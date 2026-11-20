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
    assert.equal(data.allowed_mentions.replied_user, false);
    const wire = JSON.parse(JSON.stringify(data.allowed_mentions));
    assert.deepEqual(wire.parse, []);
    assert.equal(wire.replied_user, false);

    const first = allowedMentions();
    const second = allowedMentions();
    assert.notEqual(first, second);
    assert.notEqual(first.parse, second.parse);
    assert.equal(Object.isFrozen(first), false);
    assert.equal(Object.isFrozen(first.parse), false);
    assert.equal(Object.isExtensible(first), true);
    assert.deepEqual(first, { parse: [], repliedUser: false });
    assert.deepEqual(second, { parse: [], repliedUser: false });
    first.parse.push('users');
    first.repliedUser = true;
    assert.deepEqual(second, { parse: [], repliedUser: false });
  });
});
