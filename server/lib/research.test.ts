/**
 * Tests for the knowledge-verification pass's pure boundaries:
 * buildResearchPrompt (what the agent is told to do) and isResearchCommit
 * (which commit messages mark a *completed* pass, mirroring isOkfPassCommit
 * in cleanup.ts).
 */

import { describe, it, expect } from 'vitest';
import { buildResearchPrompt, isResearchCommit } from './research.js';

const PRE_RESEARCH_MESSAGE = 'docs(verify): snapshot working tree before research';

describe('buildResearchPrompt', () => {
  const prompt = buildResearchPrompt('2026-09-08');

  it('includes today\'s date for "verified <date>" annotations', () => {
    expect(prompt).toContain('2026-09-08');
  });

  it('directs the agent to verify online via web_search', () => {
    expect(prompt).toContain('web_search');
  });

  it('requires reading source pages (web_fetch), not trusting snippets', () => {
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('never rely on the search snippet alone');
  });

  it('requires citations of fetched pages, not just search results', () => {
    expect(prompt).toContain('page URL you actually fetched'); 
  });

  it('requires git_commit with the docs(verify): prefix', () => {
    expect(prompt).toContain('"docs(verify):"');
  });

  it('forbids inventing facts — unverifiable claims stay untouched', () => {
    expect(prompt).toContain('Never invent facts');
    expect(prompt).toContain('unverifiable');
  });

  it('protects spec/meta files from the research agent', () => {
    expect(prompt).toContain('OKF.md');
    expect(prompt).toContain('AGENTS.md');
  });

  it('allows a no-op exit when nothing is verifiable', () => {
    expect(prompt).toContain('nothing to verify');
  });
});

describe('isResearchCommit', () => {
  it('accepts the agent\'s own docs(verify): commits', () => {
    expect(isResearchCommit('docs(verify): refresh BTC price and sources')).toBe(true);
  });

  it('accepts the runner\'s safety commit', () => {
    expect(isResearchCommit('docs(verify): auto-commit leftover research changes')).toBe(true);
  });

  it('rejects the pre-run snapshot (an interrupted pass must re-run)', () => {
    expect(isResearchCommit(PRE_RESEARCH_MESSAGE)).toBe(false);
  });

  it('rejects unrelated and cleanup commits', () => {
    expect(isResearchCommit('chore(okf): dedupe notes')).toBe(false);
    expect(isResearchCommit('add note about X')).toBe(false);
    expect(isResearchCommit('docs: verify stuff')).toBe(false);
  });
});
