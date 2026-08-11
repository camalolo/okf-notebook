/**
 * Daily digest runner: for a single bundle, ask the LLM to scan for anything
 * actionable within the next 24 hours and either send an email summary or
 * stay silent.
 *
 * The runner owns the email channel — the LLM never gets a send_mail tool.
 * It returns structured JSON; the runner parses it strictly and, only if
 * `sendEmail === true`, hands the composed subject/body to the mailer.
 *
 * Each run produces a JSON record under data/digests/{bundleId}/{date}.json
 * so you can audit what the model read, what it concluded, and whether an
 * email was sent. A separate lastrun.json (managed by scheduler.ts) gates
 * same-day re-runs for idempotency.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chatLogger, newTraceId } from './logger.js';
import { runReadOnlyTask, type ToolCallRecord } from './bundle-agent.js';
import { sendMail } from './mailer.js';
import { DIGEST_TO } from '../config.js';
import type { BundleConfig } from '../config.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data', 'digests');

const DIGEST_TASK_PROMPT = [
  'You are doing the daily review of this notebook.',
  '',
  'Goal: find anything that needs attention within the next 24 hours.',
  '',
  'Steps:',
  '1. Call list_files to see the structure of the bundle.',
  '2. Call read_file on anything plausibly time-sensitive — calendars, todo',
  '   lists, deadlines, appointment notes, scheduled maintenance, expiring',
  '   items, reminders. Skip purely historical or reference material.',
  '3. If a timely external fact would clarify whether something needs action',
  '   (e.g. tomorrow\'s weather, a public holiday, a news event tied to a',
  '   tracked item), use web_search to look it up. Otherwise skip web_search.',
  '',
  'Decision rule:',
  '- If NOTHING in the bundle is due, scheduled, or flagged for action in the',
  '  next 24 hours, reply with exactly: {"sendEmail": false}',
  '- If something needs attention, reply with a JSON object exactly in this shape:',
  '  {"sendEmail": true, "urgency": "low|medium|high", "subject": "<short subject>", "body": "<markdown summary>"}',
  '',
  'Body guidelines:',
  '- Be concise — typically 3-10 bullet points.',
  '- Lead with the most urgent item.',
  '- Reference the source file with a relative markdown link, e.g. [appt](health/appointments.md).',
  '- Include dates and times with the timezone.',
  '- If you used web_search to confirm a fact, mention it inline briefly.',
  '',
  'Hard requirements for your reply:',
  '- Reply with ONLY the JSON object. No prose before or after.',
  '- No markdown code fences. No "Here is...". Just the raw JSON.',
  '- Do not invent items. If you are unsure whether something is in the next 24h,',
  '  treat it as not actionable and set sendEmail=false.',
].join('\n');

export type DigestStatus =
  | 'ok'           // completed; no action needed (sendEmail=false)
  | 'emailed'      // completed; email sent
  | 'no_recipient' // completed; would have emailed but DIGEST_TO unset
  | 'parse_failed' // final assistant turn was not valid JSON / wrong schema
  | 'error';       // exception during the run

export interface DigestRunRecord {
  bundleId: string;
  bundleName: string;
  startedAt: string;
  finishedAt: string;
  status: DigestStatus;
  /** ms duration of the whole run. */
  durationMs: number;
  urgency: 'low' | 'medium' | 'high' | null;
  subject: string | null;
  /** Final recipient if emailed, else null. */
  emailRecipient: string | null;
  /** SMTP messageId if emailed, else null. */
  messageId: string | null;
  /** Number of LLM round-trips. */
  iterations: number;
  /** Whether the iteration cap was hit. */
  capped: boolean;
  toolCalls: ToolCallRecord[];
  /** Final assistant turn (raw) — kept for debugging parse failures. */
  rawContent: string;
  error: string | null;
}

interface DigestDecision {
  sendEmail: boolean;
  urgency?: unknown;
  subject?: unknown;
  body?: unknown;
}

/** Today's date as YYYY-MM-DD in the configured digest timezone. */
function todayStamp(tz: string): string {
  return new Date().toLocaleString('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Extract the JSON object from a model reply that may (despite instructions) wrap it in fences or prose. */
export function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Direct JSON.
  if (trimmed.startsWith('{')) return trimmed;
  // Fenced ```json ... ``` or ``` ... ``` — grab contents.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // Trailing JSON after prose: find the last {...} block.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isUrgency(v: unknown): v is 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * Escape raw control characters that appear INSIDE JSON string literals.
 *
 * LLMs frequently emit bare newlines/tabs inside string values (especially
 * when the string holds markdown) instead of the `\n` / `\t` escape sequences
 * JSON requires. Strict `JSON.parse` rejects this with "Bad control character
 * in string literal". This walker tracks string-literal state (respecting
 * backslash escapes) and rewrites only the in-string control chars to their
 * escaped forms, leaving everything else — including any raw newlines outside
 * strings, which JSON also permits as insignificant whitespace — untouched.
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        // Preserve the backslash and the following char verbatim.
        out += c;
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
        continue;
      }
      if (c === '"') {
        out += c;
        inString = false;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (c === '\b') out += '\\b';
        else if (c === '\f') out += '\\f';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    } else {
      if (c === '"') inString = true;
      out += c;
    }
  }
  return out;
}

/**
 * Parse JSON strictly first; on failure retry after escaping in-string control
 * characters. Surfaces the second parse error if both attempts fail.
 */
function lenientJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(text));
  }
}

export function parseDecision(raw: string): { ok: true; decision: DigestDecision } | { ok: false; reason: string } {
  const jsonText = extractJson(raw);
  if (!jsonText) return { ok: false, reason: 'no JSON object found in reply' };
  let parsed: unknown;
  try {
    parsed = lenientJsonParse(jsonText);
  } catch (err) {
    return { ok: false, reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'parsed value is not an object' };
  }
  const obj = parsed as DigestDecision;
  if (typeof obj.sendEmail !== 'boolean') {
    return { ok: false, reason: 'missing or non-boolean "sendEmail" field' };
  }
  if (obj.sendEmail) {
    if (!isString(obj.subject)) return { ok: false, reason: 'sendEmail=true but "subject" is missing/empty' };
    if (!isString(obj.body)) return { ok: false, reason: 'sendEmail=true but "body" is missing/empty' };
    if (!isUrgency(obj.urgency)) return { ok: false, reason: 'sendEmail=true but "urgency" must be low|medium|high' };
  }
  return { ok: true, decision: obj };
}

async function writeRecord(record: DigestRunRecord, tz: string): Promise<void> {
  try {
    const dir = path.join(DATA_DIR, record.bundleId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${todayStamp(tz)}.json`);
    await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (err) {
    // best-effort — don't let log-writing mask the real result
    console.error(`[digest] failed to write record for ${record.bundleId}:`, err);
  }
}

export async function runDigestForBundle(
  bundle: BundleConfig,
  tz: string,
): Promise<DigestRunRecord> {
  const traceId = newTraceId();
  const log = chatLogger(`d-${traceId}`);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const base: DigestRunRecord = {
    bundleId: bundle.id,
    bundleName: bundle.name,
    startedAt,
    finishedAt: '',
    status: 'error',
    durationMs: 0,
    urgency: null,
    subject: null,
    emailRecipient: null,
    messageId: null,
    iterations: 0,
    capped: false,
    toolCalls: [],
    rawContent: '',
    error: null,
  };

  log.info(`Digest start: bundle=${bundle.id} (${bundle.name})`);

  try {
    const result = await runReadOnlyTask(bundle, DIGEST_TASK_PROMPT, {
      log,
      maxIterations: 20,
    });

    base.toolCalls = result.toolCalls;
    base.iterations = result.iterations;
    base.capped = result.capped;
    base.rawContent = result.content;

    if (result.capped) {
      log.warn(`Digest hit iteration cap for ${bundle.id} (raw length=${result.content.length})`);
    }

    const decision = parseDecision(result.content);
    if (!decision.ok) {
      base.status = 'parse_failed';
      base.error = decision.reason;
      log.warn(`Digest parse_failed for ${bundle.id}: ${decision.reason}`);
      return finalize(base, tz, t0);
    }

    const d = decision.decision;
    if (!d.sendEmail) {
      base.status = 'ok';
      log.info(`Digest ok (no action) for ${bundle.id} after ${result.iterations} iter`);
      return finalize(base, tz, t0);
    }

    base.urgency = d.urgency as 'low' | 'medium' | 'high';
    base.subject = d.subject as string;
    const body = d.body as string;

    if (!DIGEST_TO) {
      base.status = 'no_recipient';
      base.error = 'DIGEST_TO is not set — would have emailed but no recipient.';
      log.warn(`Digest no_recipient for ${bundle.id}: DIGEST_TO unset`);
      return finalize(base, tz, t0);
    }

    const mail = await sendMail({
      to: DIGEST_TO,
      subject: `[${bundle.name}] ${base.subject}`,
      body: `${body}\n\n-- \nDaily digest from Notebook.\nBundle: ${bundle.name}`,
    });
    base.status = 'emailed';
    base.emailRecipient = DIGEST_TO;
    base.messageId = mail.messageId;
    log.info(`Digest emailed for ${bundle.id} → ${DIGEST_TO} (msg ${mail.messageId})`);
    return finalize(base, tz, t0);
  } catch (err) {
    base.status = 'error';
    base.error = err instanceof Error ? err.message : String(err);
    log.errorTrace(`Digest error for ${bundle.id}`, err);
    return finalize(base, tz, t0);
  }
}

function finalize(base: DigestRunRecord, tz: string, t0: number): DigestRunRecord {
  const finished = { ...base };
  finished.finishedAt = new Date().toISOString();
  finished.durationMs = Date.now() - t0;
  void writeRecord(finished, tz);
  return finished;
}
