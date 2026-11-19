'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MessagePayload } = require('discord.js');
const { Bridge, allowedMentions } = require('../discord-bridge');

describe('allowed mentions', () => {
  it('resolves a fresh no-mention reply through discord.js MessagePayload', async () => {
    const channel = {};
    const bridge = Object.create(Bridge.prototype);
    bridge.secrets = [];
    bridge.sleep = async () => {};

    let options;
    await bridge.replyWithRetry({
      reply(payload) {
        options = payload;
        return { id: 'local-reply' };
      },
    }, 'hello');

    let data;
    assert.doesNotThrow(() => {
      data = MessagePayload.create(channel, options).resolveData().data;
    });
    assert.deepEqual(data.allowed_mentions.parse, []);

    const first = allowedMentions();
    const second = allowedMentions();
    assert.notEqual(first, second);
    assert.deepEqual(first, { parse: [] });
    assert.deepEqual(second, { parse: [] });
  });
});
