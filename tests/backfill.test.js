'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Backfill } = require('../discord-bridge');
const { tempDir, rmrf, fakeMessage } = require('./helpers');

const CHANNEL = '100000000000000222';
const T0 = 1_700_000_000_000;

function msg(id, extra = {}) {
  return fakeMessage({
    id,
    channelId: CHANNEL,
    createdTimestamp: T0 - 60000,
    ...extra,
  });
}

describe('backfill guards from the reviewed gateway', () => {
  const dirs = [];
  after(() => { for (const dir of dirs) rmrf(dir); });

  function setup(messages, options = {}) {
    const dir = tempDir('phicc-bf-guard-');
    dirs.push(dir);
    const calls = [];
    const channel = {
      messages: {
        fetch: async (opts) => {
          calls.push(opts);
          const list = !opts.after
            ? messages.slice(-1)
            : messages.filter((item) => BigInt(item.id) > BigInt(opts.after));
          const map = new Map(list.map((item) => [item.id, item]));
          map.first = () => list[0];
          return map;
        },
      },
    };
    const handled = [];
    const backfill = new Backfill({
      client: { channels: { fetch: async () => channel } },
      log: { info() {}, warn() {} },
      handle: options.handle || (async (message) => {
        handled.push(message.id);
        return { accepted: true };
      }),
      channelIds: [CHANNEL],
      cursorFile: path.join(dir, 'cursor.json'),
      botId: () => '444',
      rateCheck: options.rateCheck,
      killSwitchOn: options.killSwitchOn || (() => false),
      now: () => T0,
      schedule: () => null,
    });
    return { handled, backfill };
  }

  it('stops at STOP without moving the cursor past the unhandled message', async () => {
    const messages = [
      msg('100000000000001001'),
      msg('100000000000001002'),
      msg('100000000000001003'),
    ];
    let stopped = false;
    const ctx = setup(messages, {
      handle: async (message) => {
        stopped = true;
        return { accepted: message.id === '100000000000001002' };
      },
      killSwitchOn: () => stopped,
    });
    ctx.backfill.note(messages[0]);
    await ctx.backfill.trigger('connected');
    assert.equal(ctx.backfill.cursor[CHANNEL], '100000000000001002');
  });

  it('falls back to the snowflake timestamp when createdTimestamp is missing', async () => {
    const fresh = msg('100000000000001001');
    const undated = msg('100000000000001002');
    undated.createdTimestamp = 0;
    const ctx = setup([fresh, undated]);
    ctx.backfill.note(fresh);
    const summary = await ctx.backfill.trigger('connected');
    assert.equal(summary.skippedOld, 1);
    assert.deepEqual(ctx.handled, []);
  });

  it('accepts a content-only mention via botMentioned', async () => {
    const seed = msg('100000000000001001');
    const contentOnly = msg('100000000000001002', {
      mention: false,
      content: '<@444> hello from text',
    });
    const ctx = setup([seed, contentOnly]);
    ctx.backfill.note(seed);
    await ctx.backfill.trigger('connected');
    assert.deepEqual(ctx.handled, ['100000000000001002']);
  });
});
