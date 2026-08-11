/**
 * Tests for interpretDecision — the boundary that protects the email channel.
 *
 * The model's terminal tool call (skip_digest / send_digest) is interpreted
 * strictly: missing or malformed args can never trigger an email send.
 */

import { describe, it, expect } from 'vitest';
import { interpretDecision } from './digest.js';
import type { ToolCallRecord } from './bundle-agent.js';

function tc(name: string, args: unknown): ToolCallRecord {
  return { name, args, result: { captured: true } };
}

describe('interpretDecision', () => {
  describe('skip path', () => {
    it('accepts skip_digest with no args', () => {
      expect(interpretDecision(tc('skip_digest', {}))).toEqual({ kind: 'skip' });
    });

    it('accepts skip_digest even if extra args are present', () => {
      // The model sometimes adds unwanted fields; skip should still be skip.
      expect(interpretDecision(tc('skip_digest', { reason: 'nothing urgent' }))).toEqual({ kind: 'skip' });
    });
  });

  describe('send path', () => {
    it('accepts send_digest with valid urgency, subject, and body', () => {
      const r = interpretDecision(tc('send_digest', {
        urgency: 'high',
        subject: 'Today Aug 11: payment due',
        body: 'Pay NT$576 at the office.',
      }));
      expect(r).toEqual({
        kind: 'send',
        urgency: 'high',
        subject: 'Today Aug 11: payment due',
        body: 'Pay NT$576 at the office.',
      });
    });

    it('accepts all three urgency levels', () => {
      for (const u of ['low', 'medium', 'high'] as const) {
        const r = interpretDecision(tc('send_digest', { urgency: u, subject: 's', body: 'b' }));
        expect(r.kind).toBe('send');
        if (r.kind === 'send') expect(r.urgency).toBe(u);
      }
    });

    it('accepts a body containing newlines (the original bug, now via tool args)', () => {
      // Tool-call args are JSON, so newlines arrive as proper \n escapes — no
      // control-char sanitizer needed. We still verify the body survives intact.
      const body = 'Line 1\nLine 2\n- bullet';
      const r = interpretDecision(tc('send_digest', { urgency: 'low', subject: 's', body }));
      expect(r.kind).toBe('send');
      if (r.kind === 'send') expect(r.body).toBe(body);
    });
  });

  describe('invalid: send_digest with bad args', () => {
    it('rejects an invalid urgency enum value', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'critical', subject: 's', body: 'b' }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/urgency/);
    });

    it('rejects a missing urgency', () => {
      const r = interpretDecision(tc('send_digest', { subject: 's', body: 'b' }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/urgency/);
    });

    it('rejects a missing subject', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'low', body: 'b' }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/subject/);
    });

    it('rejects an empty / whitespace-only subject', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'low', subject: '   ', body: 'b' }));
      expect(r.kind).toBe('invalid');
    });

    it('rejects a missing body', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'low', subject: 's' }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/body/);
    });

    it('rejects an empty body', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'low', subject: 's', body: '' }));
      expect(r.kind).toBe('invalid');
    });

    it('rejects a non-string subject (e.g. a number leaked in)', () => {
      const r = interpretDecision(tc('send_digest', { urgency: 'low', subject: 42, body: 'b' }));
      expect(r.kind).toBe('invalid');
    });
  });

  describe('invalid: no terminal tool called', () => {
    it('treats undefined as invalid (model ended with plain text)', () => {
      const r = interpretDecision(undefined);
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/without calling/);
    });
  });

  describe('invalid: unexpected tool name', () => {
    it('rejects a terminal tool name we did not advertise', () => {
      // Defensive — would only happen if the model hallucinated a name.
      const r = interpretDecision(tc('email_digest', { subject: 's', body: 'b', urgency: 'low' }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).toMatch(/unexpected terminal tool/);
    });
  });
});
