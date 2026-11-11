'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, RateLimiter } = require('../discord-bridge');
const { enabledConfig, fakeMessage } = require('./helpers');

function decide(message, config, ctx) {
  return evaluate(message, config || enabledConfig(), {
    botId: '444',
    killSwitchOn: false,
    now: 1_700_000_000_000,
    ...(ctx || {}),
  });
}

describe('policy allowlists and mention gate', () => {
  it('accepts an allowlisted user mention in an allowlisted channel', () => {
    const result = decide(fakeMessage());
    assert.equal(result.allow, true);
    assert.equal(result.channelId, '222');
    assert.equal(result.guildId, '111');
  });

  it('accepts an allowlisted role only when usersOnly is off', () => {
    const blocked = enabledConfig();
    blocked.policy.usersOnly = true;
    assert.equal(decide(fakeMessage({ userId: '777', roles: ['555'] }), blocked).reason, 'user_denied');
    const config = enabledConfig();
    config.policy.usersOnly = false;
    const result = decide(fakeMessage({ userId: '777', roles: ['555'] }), config);
    assert.equal(result.allow, true);
  });

  it('drops the wrong guild, channel, and user', () => {
    assert.equal(decide(fakeMessage({ guildId: '000' })).reason, 'guild_denied');
    assert.equal(decide(fakeMessage({ channelId: '000' })).reason, 'channel_denied');
    assert.equal(decide(fakeMessage({ userId: '000' })).reason, 'user_denied');
  });

  it('fails closed when an allowlist is empty', () => {
    const config = enabledConfig();
    config.discord.allowedUserIds = [];
    config.discord.allowedRoleIds = [];
    assert.equal(decide(fakeMessage(), config).reason, 'user_denied');
  });

  it('drops DMs, other bots, itself, and webhooks', () => {
    assert.equal(decide(fakeMessage({ guildId: null })).reason, 'dm_blocked');
    assert.equal(decide(fakeMessage({ bot: true })).reason, 'ignore_bot');
    assert.equal(decide(fakeMessage({ bot: false, userId: '444' })).reason, 'ignore_self');
    assert.equal(decide(fakeMessage({ webhookId: '9', bot: false })).reason, 'ignore_webhook');
  });

  it('requires a real bot mention and ignores @everyone and role mentions', () => {
    assert.equal(decide(fakeMessage({ mention: false, content: 'hello' })).reason, 'not_mention');
    assert.equal(decide(fakeMessage({
      mention: false,
      everyone: true,
      content: '@everyone hello',
    })).reason, 'not_mention');
    assert.equal(decide(fakeMessage({
      mention: false,
      content: '<@&555> hello',
      mentionedRoles: ['555'],
    })).reason, 'not_mention');
  });

  it('accepts a mention written only in the content', () => {
    const result = decide(fakeMessage({ mention: false, content: 'hey <@!444> there' }));
    assert.equal(result.allow, true);
  });

  it('lets a thread through only when threads are enabled and the parent is listed', () => {
    const notAThread = decide(fakeMessage({
      channel: { id: '3333', parentId: '222', isThread: true, parent: { type: 'GUILD_CATEGORY' } },
      channelId: '3333',
    }));
    assert.equal(notAThread.reason, 'channel_denied');
    const denied = decide(fakeMessage({
      thread: true,
      channelId: '3333',
      parentId: '222',
    }));
    assert.equal(denied.reason, 'channel_denied');
    const config = enabledConfig();
    config.discord.allowThreads = true;
    const allowed = decide(fakeMessage({
      thread: true,
      channelId: '3333',
      parentId: '222',
    }), config);
    assert.equal(allowed.allow, true);
  });

  it('does not treat a !! command as a bridge message', () => {
    const result = decide(fakeMessage({ content: '!!rulereader' }));
    assert.equal(result.reason, 'prefix_command');
  });

  it('stops on the kill switch and when the feature flag is off', () => {
    assert.equal(decide(fakeMessage(), enabledConfig(), { killSwitchOn: true }).reason, 'kill_switch');
    const disabled = enabledConfig();
    disabled.features.enabled = false;
    assert.equal(decide(fakeMessage(), disabled).reason, 'disabled');
  });

  it('enforces per-user, per-channel, and global rate limits without counting denies', () => {
    const rates = new RateLimiter({ perUserPerMin: 2, perChannelPerMin: 3, globalPerHour: 4 });
    const now = 5_000_000;
    const config = enabledConfig();
    const ctx = { rateLimits: rates, now };
    assert.equal(decide(fakeMessage({ id: '1' }), config, ctx).allow, true);
    rates.commit('333', '222', now);
    assert.equal(decide(fakeMessage({ id: '2' }), config, ctx).allow, true);
    rates.commit('333', '222', now);
    assert.equal(decide(fakeMessage({ id: '3' }), config, ctx).reason, 'rate_limited_user');

    const other = new RateLimiter({ perUserPerMin: 10, perChannelPerMin: 1, globalPerHour: 10 });
    other.commit('333', '222', now);
    assert.equal(decide(fakeMessage({ userId: '333' }), config, { rateLimits: other, now }).reason, 'rate_limited_channel');

    const global = new RateLimiter({ perUserPerMin: 10, perChannelPerMin: 10, globalPerHour: 1 });
    global.commit('1', '222', now);
    assert.equal(decide(fakeMessage(), config, { rateLimits: global, now }).reason, 'rate_limited_global');
  });
});
