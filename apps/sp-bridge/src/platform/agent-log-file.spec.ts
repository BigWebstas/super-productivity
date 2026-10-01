import assert from 'node:assert/strict';
import { describe, it } from '../test/harness';
import { readLogTail, tailLogLines } from './agent-log-file';

describe('tailLogLines', () => {
  it('returns the last lines in order', () => {
    assert.deepEqual(tailLogLines('a\nb\nc\n', 2), ['b', 'c']);
    assert.deepEqual(tailLogLines('a\nb\nc', 2), ['b', 'c']);
  });

  it('handles CRLF line endings', () => {
    assert.deepEqual(tailLogLines('a\r\nb\r\nc\r\n', 2), ['b', 'c']);
  });

  it('returns everything when the log is short', () => {
    assert.deepEqual(tailLogLines('only\n', 300), ['only']);
    assert.deepEqual(tailLogLines('', 300), []);
  });

  it('returns nothing for a non-positive limit', () => {
    assert.deepEqual(tailLogLines('a\nb\n', 0), []);
    assert.deepEqual(tailLogLines('a\nb\n', -1), []);
  });
});

describe('readLogTail', () => {
  it('returns an array without throwing', () => {
    const lines = readLogTail(50);
    assert(Array.isArray(lines));
  });
});
