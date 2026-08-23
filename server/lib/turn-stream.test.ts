import { describe, it, expect } from 'vitest';
import {
  beginTurn,
  recordEvent,
  attachSubscriber,
  endTurn,
  hasActiveTurn,
  bufferedCount,
  turnKey,
} from './turn-stream.js';

describe('turn-stream buffer', () => {
  it('records events with sequential ids and replays after `since`', () => {
    const key = turnKey('b1', 'c1');
    beginTurn(key);
    recordEvent(key, 'content', { text: 'a' });
    recordEvent(key, 'content', { text: 'b' });
    recordEvent(key, 'tool_call', { name: 't' });

    const chunks: string[] = [];
    const { detach } = attachSubscriber(key, 1, {
      write: (c) => chunks.push(c),
      end: () => chunks.push('END'),
    });
    detach();

    // Only events with id > 1 replayed (ids 0,1,2 recorded).
    expect(chunks.filter((c) => c !== 'END')).toHaveLength(1);
    expect(chunks[0]).toContain('id: 2');
    expect(chunks[0]).toContain('event: tool_call');
  });

  it('replays the whole turn for since < 0', () => {
    const key = turnKey('b1', 'c2');
    beginTurn(key);
    recordEvent(key, 'content', { text: 'x' });
    recordEvent(key, 'done', {});
    const chunks: string[] = [];
    attachSubscriber(key, -1, {
      write: (c) => chunks.push(c),
      end: () => chunks.push('END'),
    });
    expect(chunks.filter((c) => c !== 'END')).toHaveLength(2);
  });

  it('broadcasts live events to attached subscribers', () => {
    const key = turnKey('b1', 'c3');
    beginTurn(key);
    recordEvent(key, 'content', { text: 'before' });
    const chunks: string[] = [];
    attachSubscriber(key, -1, { write: (c) => chunks.push(c), end: () => {} });
    recordEvent(key, 'content', { text: 'live' });
    expect(chunks.some((c) => c.includes('live'))).toBe(true);
  });

  it('attach on a done turn replays and ends immediately', () => {
    const key = turnKey('b1', 'c4');
    beginTurn(key);
    recordEvent(key, 'done', {});
    endTurn(key);
    expect(hasActiveTurn(key)).toBe(false);

    const chunks: string[] = [];
    const attached = attachSubscriber(key, -1, {
      write: (c) => chunks.push(c),
      end: () => chunks.push('END'),
    });
    expect(attached.done).toBe(true);
    expect(chunks[chunks.length - 1]).toBe('END');
  });

  it('endTurn closes subscribers; buffer lingers for late reconnectors', () => {
    const key = turnKey('b1', 'c5');
    beginTurn(key);
    const ends: string[] = [];
    attachSubscriber(key, -1, { write: () => {}, end: () => ends.push('END') });
    recordEvent(key, 'done', {});
    endTurn(key);
    expect(ends).toEqual(['END']);
    // Buffer still present (grace period) → a client reconnecting right
    // after the end still receives the replay incl. `done`.
    expect(bufferedCount(key)).toBe(1);
  });

  it('throws when nothing is buffered', () => {
    expect(() =>
      attachSubscriber(turnKey('b1', 'nope'), -1, { write: () => {}, end: () => {} }),
    ).toThrow('turn not found');
  });
});
