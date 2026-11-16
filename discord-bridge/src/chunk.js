'use strict';

const MAX_CHUNK_LEN = 1900;
const MAX_CHUNKS = 3;
const TRUNCATION_NOTE = '\n[truncated]';

function safeCut(rest, maxLen) {
  let cut = Math.min(maxLen, rest.length);
  if (rest.length <= maxLen) return rest.length;
  const window = rest.slice(0, maxLen);
  const newline = window.lastIndexOf('\n');
  const floor = Math.floor(maxLen * 0.4);
  if (newline >= floor) {
    cut = newline + 1;
  } else {
    const space = window.lastIndexOf(' ');
    if (space >= floor) cut = space + 1;
  }
  const head = rest.slice(0, cut);
  const open = head.lastIndexOf('<');
  const close = head.lastIndexOf('>');
  if (open > close) {
    if (open > 0) cut = open;
    else return 0;
  }
  if (cut <= 0) return 0;
  return cut;
}

/**
 * Split a reply into at most `maxChunks` pieces of `maxLen` characters.
 * Prefers line breaks. The last piece carries a truncation note when text remains.
 */
function chunkReply(text, maxLen = MAX_CHUNK_LEN, maxChunks = MAX_CHUNKS) {
  const clean = text == null ? '' : String(text);
  const limit = maxLen > 0 ? maxLen : MAX_CHUNK_LEN;
  const pieces = maxChunks > 0 ? maxChunks : MAX_CHUNKS;
  if (clean.length <= limit) return [clean];

  const chunks = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < pieces) {
    if (rest.length <= limit) {
      chunks.push(rest);
      rest = '';
      break;
    }
    const lastSlot = chunks.length === pieces - 1;
    const budget = lastSlot ? Math.max(1, limit - TRUNCATION_NOTE.length) : limit;
    let cut = safeCut(rest, budget);
    if (cut <= 0) cut = Math.min(budget, rest.length);
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut);
    if (lastSlot && rest.length > 0) {
      if (piece.length + TRUNCATION_NOTE.length > limit) {
        piece = piece.slice(0, budget);
      }
      piece += TRUNCATION_NOTE;
      rest = '';
    }
    chunks.push(piece);
  }
  return chunks;
}

module.exports = {
  MAX_CHUNK_LEN,
  MAX_CHUNKS,
  TRUNCATION_NOTE,
  chunkReply,
};
