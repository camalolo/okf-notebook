/**
 * Tests for the digest decision parser — the boundary that protects the email
 * channel. The LLM is instructed to return one of two JSON shapes; the runner
 * must accept well-formed replies (including common LLM quirks like fenced
 * code blocks or trailing prose) and reject anything that doesn't match the
 * schema, so a malformed reply can never trigger an email.
 */

import { describe, it, expect } from 'vitest';
import { parseDecision, extractJson, escapeControlCharsInStrings } from './digest.js';

describe('extractJson', () => {
  it('returns raw input when it already starts with {', () => {
    expect(extractJson('{"sendEmail": false}')).toBe('{"sendEmail": false}');
  });

  it('strips a ```json fenced block', () => {
    const raw = 'Here is my decision:\n```json\n{"sendEmail": true}\n```\n';
    expect(extractJson(raw)).toBe('{"sendEmail": true}');
  });

  it('strips a bare ``` fenced block', () => {
    const raw = '```\n{"sendEmail": false}\n```';
    expect(extractJson(raw)).toBe('{"sendEmail": false}');
  });

  it('extracts a trailing JSON object surrounded by prose', () => {
    const raw = 'Sure! My answer is:\n{"sendEmail": false}\nThanks.';
    expect(extractJson(raw)).toBe('{"sendEmail": false}');
  });

  it('returns null for empty or non-JSON input', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('   ')).toBeNull();
    expect(extractJson('just prose, no JSON')).toBeNull();
  });
});

describe('parseDecision', () => {
  it('accepts a clean sendEmail=false reply', () => {
    const r = parseDecision('{"sendEmail": false}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.sendEmail).toBe(false);
  });

  it('accepts a clean sendEmail=true reply with all required fields', () => {
    const raw = JSON.stringify({
      sendEmail: true,
      urgency: 'high',
      subject: 'Tomorrow: payment due',
      body: 'Pay NT$576 at the office.',
    });
    const r = parseDecision(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.sendEmail).toBe(true);
      expect(r.decision.urgency).toBe('high');
      expect(r.decision.subject).toBe('Tomorrow: payment due');
    }
  });

  it('accepts a fenced reply despite instructions saying not to fence', () => {
    const raw = '```json\n{"sendEmail": false}\n```';
    const r = parseDecision(raw);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-boolean sendEmail', () => {
    const r = parseDecision('{"sendEmail": "yes"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sendEmail/);
  });

  it('rejects sendEmail=true with a missing subject', () => {
    const raw = JSON.stringify({ sendEmail: true, urgency: 'low', body: 'x' });
    const r = parseDecision(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/subject/);
  });

  it('rejects sendEmail=true with an empty-string subject', () => {
    const raw = JSON.stringify({ sendEmail: true, urgency: 'low', subject: '   ', body: 'x' });
    const r = parseDecision(raw);
    expect(r.ok).toBe(false);
  });

  it('rejects sendEmail=true with a missing body', () => {
    const raw = JSON.stringify({ sendEmail: true, urgency: 'low', subject: 'x' });
    const r = parseDecision(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/body/);
  });

  it('rejects sendEmail=true with an invalid urgency value', () => {
    const raw = JSON.stringify({ sendEmail: true, urgency: 'critical', subject: 'x', body: 'y' });
    const r = parseDecision(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/urgency/);
  });

  it('rejects unparseable input without throwing', () => {
    const r = parseDecision('the dog ate my homework');
    expect(r.ok).toBe(false);
  });

  it('rejects an array (wrong top-level shape)', () => {
    const r = parseDecision('[1, 2, 3]');
    expect(r.ok).toBe(false);
  });

  it('rejects a parsed value that is not an object', () => {
    // A bare quoted string doesn't begin with `{` so extractJson bails first;
    // the rejection reason mentions "no JSON object found".
    const r = parseDecision('"just a string"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no JSON object/);
  });
});

describe('escapeControlCharsInStrings', () => {
  it('is a no-op on text with no string literals', () => {
    expect(escapeControlCharsInStrings('12345')).toBe('12345');
  });

  it('is a no-op on already-correct JSON (no false positives)', () => {
    const correct = '{"a":"b","c":"d\\ne"}';
    expect(escapeControlCharsInStrings(correct)).toBe(correct);
  });

  it('escapes raw newlines inside string values', () => {
    // LLM quirk: bare 0x0A inside the "body" string instead of \n.
    const bad = '{"k":"line1\nline2"}'; // ← that \n is a real newline byte
    expect(escapeControlCharsInStrings(bad)).toBe('{"k":"line1\\nline2"}');
  });

  it('escapes raw tabs inside string values', () => {
    const bad = '{"k":"col1\tcol2"}';
    expect(escapeControlCharsInStrings(bad)).toBe('{"k":"col1\\tcol2"}');
  });

  it('preserves existing backslash escapes (does not double-escape)', () => {
    // Already-correct \n stays as \n; raw tab gets escaped.
    const mixed = '{"k":"ok\\nhere\ttab"}';
    expect(escapeControlCharsInStrings(mixed)).toBe('{"k":"ok\\nhere\\ttab"}');
  });

  it('escapes other control characters as \\uXXXX', () => {
    const bad = '{"k":"a\u0001b"}';
    expect(escapeControlCharsInStrings(bad)).toBe('{"k":"a\\u0001b"}');
  });

  it('leaves raw newlines OUTSIDE string literals untouched (valid JSON whitespace)', () => {
    const text = '{\n  "k": "v"\n}';
    expect(escapeControlCharsInStrings(text)).toBe('{\n  "k": "v"\n}');
  });
});

describe('parseDecision with lenient JSON parsing', () => {
  it('accepts a body containing raw newlines (the demo 2026-08-11 bug)', () => {
    // Real production failure: the LLM wrote markdown body content with
    // literal newline bytes instead of \n escapes, which strict JSON.parse
    // rejects as "Bad control character in string literal".
    const raw = [
      '{"sendEmail": true, "urgency": "high", "subject": "Today: payment due", "body": "**Items due today:**',
      '',
      '- **Payment NT$576** at the office, 08:30–16:00.',
      '- **Math class** 15:00–18:00, room 503."}',
    ].join('\n');
    const r = parseDecision(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.sendEmail).toBe(true);
      expect(r.decision.urgency).toBe('high');
      expect((r.decision.body as string)).toMatch(/Payment NT\$576/);
      expect((r.decision.body as string)).toMatch(/Math class/);
    }
  });

  it('still rejects genuinely malformed JSON (not just unescaped control chars)', () => {
    const r = parseDecision('{"sendEmail": true, "body":}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JSON.parse failed/);
  });
});
