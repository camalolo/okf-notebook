/**
 * Daily digest runner: for a single bundle, ask the LLM to scan for anything
 * actionable within the next 24 hours and either send an email summary or
 * stay silent.
 *
 * Decision mechanism: the LLM signals its decision by calling one of two
 * terminal tools — `skip_digest` (nothing urgent) or `send_digest` (with
 * subject/body/urgency args). Tool-call arguments are schema-constrained
 * JSON, so this avoids the brittleness of parsing free-text JSON replies
 * (which previously failed on LLM-quoted control characters in markdown
 * bodies). The runner, not the model, performs the actual SMTP send — the
 * model never has direct control of the email channel.
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
import type { ToolDefinition } from './llm.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data', 'digests');

// --- Decision tools ---------------------------------------------------------

/** Tool name constants. Declared as terminalTools in runReadOnlyTask. */
const SKIP_DIGEST = 'skip_digest';
const SEND_DIGEST = 'send_digest';

const SKIP_DIGEST_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: SKIP_DIGEST,
    description:
      'Signal that nothing in this notebook needs attention within the next 24 hours. ' +
      'No email will be sent. Call this when your review is complete and nothing is actionable.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

const SEND_DIGEST_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: SEND_DIGEST,
    description:
      'Signal that one or more items need attention within the next 24 hours. ' +
      'An email with the subject and body you provide will be sent to the configured recipient. ' +
      'Only call this when you have verified the items against files you have read.',
    parameters: {
      type: 'object',
      properties: {
        urgency: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How urgent the items are. Use "high" for same-day deadlines or anything with a hard cutoff.',
        },
        subject: {
          type: 'string',
          description: 'Short email subject, typically leading with the date and the most urgent item. e.g. "Today Aug 11: Pay NT$576 + Math class 15:00".',
        },
        body: {
          type: 'string',
          description:
            'Markdown email body. Concise — typically 3-10 bullet points. Lead with the most urgent item. ' +
            'Reference source files with relative markdown links like [appt](health/appointments.md). ' +
            'Include dates, times, and timezones. Mention any web_search lookups inline briefly.',
        },
      },
      required: ['urgency', 'subject', 'body'],
    },
  },
};

const DIGEST_DECISION_TOOLS: ToolDefinition[] = [SKIP_DIGEST_TOOL, SEND_DIGEST_TOOL];
const TERMINAL_TOOLS = new Set<string>([SKIP_DIGEST, SEND_DIGEST]);

// --- Task prompt ------------------------------------------------------------

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
  'When you are done, signal your decision by calling EXACTLY ONE of:',
  '- skip_digest    — if nothing needs attention in the next 24 hours.',
  '- send_digest    — if one or more items need attention, passing urgency,',
  '                   subject, and body. Do not invent items; if you are unsure',
  '                   whether something falls in the next 24h, call skip_digest.',
  '',
  'Do not emit a final text answer. Your turn is complete once you call one of',
  'these tools. Use plain text only between tool calls to think out loud if useful.',
].join('\n');

// --- Types ------------------------------------------------------------------

export type DigestStatus =
  | 'ok'           // completed; nothing actionable (skip_digest called)
  | 'emailed'      // completed; email sent
  | 'no_recipient' // completed; would have emailed but DIGEST_TO unset
  | 'parse_failed' // model ended without calling skip_digest / send_digest
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
  /** Name of the terminal tool the model called, if any (skip_digest / send_digest). */
  decisionTool: string | null;
  /** Final assistant turn (raw text) — kept for debugging. */
  rawContent: string;
  error: string | null;
}

// --- Decision interpretation ------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isUrgency(v: unknown): v is 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high';
}

export type InterpretedDecision =
  | { kind: 'skip' }
  | { kind: 'send'; urgency: 'low' | 'medium' | 'high'; subject: string; body: string }
  | { kind: 'invalid'; reason: string };

/**
 * Interpret the model's terminal tool call (or its absence) into a digest
 * decision. This is the testable boundary between LLM output and the email
 * channel — it never throws and never trusts malformed input.
 */
export function interpretDecision(tc: ToolCallRecord | undefined): InterpretedDecision {
  if (!tc) {
    return { kind: 'invalid', reason: 'model ended without calling skip_digest or send_digest' };
  }
  if (tc.name === SKIP_DIGEST) {
    return { kind: 'skip' };
  }
  if (tc.name === SEND_DIGEST) {
    const args = tc.args as { urgency?: unknown; subject?: unknown; body?: unknown };
    if (!isUrgency(args.urgency)) {
      return { kind: 'invalid', reason: `send_digest called with invalid urgency: ${JSON.stringify(args.urgency)}` };
    }
    if (!isString(args.subject)) {
      return { kind: 'invalid', reason: 'send_digest called with missing or empty subject' };
    }
    if (!isString(args.body)) {
      return { kind: 'invalid', reason: 'send_digest called with missing or empty body' };
    }
    return { kind: 'send', urgency: args.urgency, subject: args.subject, body: args.body };
  }
  return { kind: 'invalid', reason: `unexpected terminal tool: ${tc.name}` };
}

// --- Run record persistence -------------------------------------------------

/** Today's date as YYYY-MM-DD in the configured digest timezone. */
function todayStamp(tz: string): string {
  return new Date().toLocaleString('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
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

// --- Main runner ------------------------------------------------------------

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
    decisionTool: null,
    rawContent: '',
    error: null,
  };

  log.info(`Digest start: bundle=${bundle.id} (${bundle.name})`);

  try {
    const result = await runReadOnlyTask(bundle, DIGEST_TASK_PROMPT, {
      log,
      maxIterations: 20,
      extraTools: DIGEST_DECISION_TOOLS,
      terminalTools: TERMINAL_TOOLS,
    });

    base.toolCalls = result.toolCalls;
    base.iterations = result.iterations;
    base.capped = result.capped;
    base.rawContent = result.content;
    base.decisionTool = result.terminalToolCall?.name ?? null;

    if (result.capped) {
      log.warn(`Digest hit iteration cap for ${bundle.id} (no decision tool called)`);
    }

    const decision = interpretDecision(result.terminalToolCall);
    if (decision.kind === 'invalid') {
      base.status = 'parse_failed';
      base.error = decision.reason;
      log.warn(`Digest parse_failed for ${bundle.id}: ${decision.reason}`);
      return finalize(base, tz, t0);
    }

    if (decision.kind === 'skip') {
      base.status = 'ok';
      log.info(`Digest ok (no action) for ${bundle.id} after ${result.iterations} iter`);
      return finalize(base, tz, t0);
    }

    // decision.kind === 'send'
    base.urgency = decision.urgency;
    base.subject = decision.subject;

    if (!DIGEST_TO) {
      base.status = 'no_recipient';
      base.error = 'DIGEST_TO is not set — would have emailed but no recipient.';
      log.warn(`Digest no_recipient for ${bundle.id}: DIGEST_TO unset`);
      return finalize(base, tz, t0);
    }

    const mail = await sendMail({
      to: DIGEST_TO,
      subject: `[${bundle.name}] ${base.subject}`,
      body: `${decision.body}\n\n-- \nDaily digest from Notebook.\nBundle: ${bundle.name}`,
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
