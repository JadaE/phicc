'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { chunkReply, MAX_CHUNK_LEN, MAX_CHUNKS, TRUNCATION_NOTE } = require('../discord-bridge');

describe('reply chunking', () => {
  it('keeps a short reply in one piece', () => {
    assert.deepEqual(chunkReply('hello'), ['hello']);
    assert.equal(chunkReply('x'.repeat(MAX_CHUNK_LEN)).length, 1);
  });

  it('splits on line breaks and keeps every chunk within 1900 characters', () => {
    const line = 'L'.repeat(100);
    const text = Array.from({ length: 25 }, () => line).join('\n');
    const chunks = chunkReply(text);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.length <= MAX_CHUNKS);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX_CHUNK_LEN);
      for (const part of chunk.split('\n')) {
        if (part.length === 0) continue;
        assert.equal(part, line);
      }
    }
  });

  it('hard-splits a long line and caps the reply at 3 chunks with a truncation note', () => {
    const chunks = chunkReply('x'.repeat(8000));
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) assert.ok(chunk.length <= MAX_CHUNK_LEN);
    assert.ok(chunks[2].endsWith(TRUNCATION_NOTE));
    assert.equal(chunks[0].length, MAX_CHUNK_LEN);
  });

  it('does not split a mention token on the final chunk', () => {
    const mention = '<@100000000000000099>';
    const text = `${'x'.repeat(30)}${mention}${'y'.repeat(40)}`;
    const chunks = chunkReply(text, 50, 1);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].length <= 50);
    assert.equal(/<@(?!\d+>)/.test(chunks[0]), false);
    assert.ok(chunks[0].endsWith(TRUNCATION_NOTE));
  });

  it('does not add a truncation note when the text fits in 3 chunks', () => {
    const chunks = chunkReply('y'.repeat(4000));
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join('').length, 4000);
    assert.equal(chunks.some((chunk) => chunk.includes(TRUNCATION_NOTE)), false);
  });
});
