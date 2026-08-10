/**
 * Tests for the digest decision parser — the boundary that protects the email
 * channel. The LLM is instructed to return one of two JSON shapes; the runner
 * must accept well-formed replies (including common LLM quirks like fenced
 * code blocks or trailing prose) and reject anything that doesn't match the
 * schema, so a malformed reply can never trigger an email.
 */

import { describe, it, expect } from 'vitest';
import { parseDecision, extractJson } from './digest.js';

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
