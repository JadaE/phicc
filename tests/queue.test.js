'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FileQueue } = require('../discord-bridge');
const { tempDir, rmrf } = require('./helpers');

describe('atomic file queue', () => {
  const root = tempDir('phicc-queue-');
  const queue = new FileQueue(root);
  after(() => rmrf(root));

  it('creates inbox, outbox, done, and dead as mode 700', () => {
    queue.ensure();
    for (const name of ['inbox', 'outbox', 'done', 'dead']) {
      const dir = path.join(root, name);
      assert.equal(fs.statSync(dir).isDirectory(), true);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
  });

  it('writes exclusively and refuses a second copy of the same message id', () => {
    const first = queue.enqueue({ discordMessageId: '42', text: 'one', createdTimestamp: 1 });
    const second = queue.enqueue({ discordMessageId: '42', text: 'two', createdTimestamp: 2 });
    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(queue.read('inbox', '42').text, 'one');
    const raw = fs.readFileSync(queue.pathFor('inbox', '42'), 'utf8');
    assert.equal(raw.includes('two'), false);
  });

  it('rejects ids that could escape the queue directory', () => {
    assert.throws(() => queue.enqueue({ discordMessageId: '../etc/passwd', text: 'no' }), /invalid message id/);
    assert.throws(() => queue.pathFor('inbox', 'abc'), /invalid message id/);
  });

  it('moves a correlated outbox reply to done and a failed one to dead', () => {
    queue.overwrite('outbox', '42', { replyTo: '42', channelId: '7', text: 'answer', final: true });
    queue.complete('42', { chunks: 1 });
    assert.equal(queue.read('inbox', '42'), null);
    assert.equal(queue.read('outbox', '42'), null);
    assert.equal(queue.read('done', '42').status, 'done');
    assert.equal(queue.seen('42'), true);

    queue.enqueue({ discordMessageId: '43', text: 'later', channelId: '7' });
    queue.overwrite('outbox', '43', { replyTo: '43', channelId: '7', text: 'nope', final: true });
    queue.fail('43', { error: 'send_failed' });
    assert.equal(queue.read('inbox', '43'), null);
    assert.equal(queue.read('dead', '43').status, 'dead');
    assert.equal(queue.read('dead', '43').error, 'send_failed');
  });
});
