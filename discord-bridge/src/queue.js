'use strict';

const fs = require('fs');
const path = require('path');

const FOLDERS = ['inbox', 'outbox', 'done', 'dead'];

function assertSafeId(id) {
  const value = String(id);
  if (!/^\d{1,25}$/.test(value)) {
    throw new Error('invalid message id');
  }
  return value;
}

function resolveInside(dir, id) {
  const safe = assertSafeId(id);
  const dest = path.resolve(dir, `${safe}.json`);
  const root = path.resolve(dir);
  if (dest !== path.join(root, `${safe}.json`)) {
    throw new Error('invalid message id');
  }
  return dest;
}

class FileQueue {
  constructor(root) {
    this.root = root;
    this.dirs = {};
    for (const name of FOLDERS) this.dirs[name] = path.join(root, name);
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.chmodSync(this.root, 0o700);
    for (const dir of Object.values(this.dirs)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o700);
    }
  }

  pathFor(folder, id) {
    if (!this.dirs[folder]) throw new Error(`unknown queue folder: ${folder}`);
    return resolveInside(this.dirs[folder], id);
  }

  exists(folder, id) {
    return fs.existsSync(this.pathFor(folder, id));
  }

  seen(id) {
    return FOLDERS.some((folder) => {
      try {
        return this.exists(folder, id);
      } catch (err) {
        return false;
      }
    });
  }

  writeAtomic(folder, id, record, exclusive) {
    this.ensure();
    const dest = this.pathFor(folder, id);
    const tmp = path.join(
      this.dirs[folder],
      `.${assertSafeId(id)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    if (!exclusive) {
      fs.renameSync(tmp, dest);
      fs.chmodSync(dest, 0o600);
      return true;
    }
    try {
      fs.linkSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* ignore */ }
      if (err.code === 'EEXIST') return false;
      throw err;
    }
    fs.unlinkSync(tmp);
    fs.chmodSync(dest, 0o600);
    return true;
  }

  enqueue(record) {
    const id = assertSafeId(record.discordMessageId || record.id);
    if (this.seen(id)) return { ok: false, duplicate: true, id };
    const stored = { ...record, discordMessageId: id, id };
    const created = this.writeAtomic('inbox', id, stored, true);
    if (!created) return { ok: false, duplicate: true, id };
    return { ok: true, id };
  }

  read(folder, id) {
    const file = this.pathFor(folder, id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  overwrite(folder, id, record) {
    this.writeAtomic(folder, id, record, false);
  }

  remove(folder, id) {
    const file = this.pathFor(folder, id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  list(folder) {
    this.ensure();
    return fs.readdirSync(this.dirs[folder])
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  }

  listRecords(folder) {
    return this.list(folder).map((id) => this.read(folder, id));
  }

  complete(id, extra) {
    const inbox = this.read('inbox', id) || { id, discordMessageId: id };
    const done = {
      ...inbox,
      ...(extra || {}),
      status: 'done',
      finishedAt: new Date().toISOString(),
    };
    this.writeAtomic('done', id, done, false);
    this.remove('inbox', id);
    this.remove('outbox', id);
  }

  fail(id, extra) {
    const inbox = this.read('inbox', id) || { id, discordMessageId: id };
    const outbox = this.read('outbox', id);
    const dead = {
      ...inbox,
      outbox: outbox || null,
      ...(extra || {}),
      status: 'dead',
      failedAt: new Date().toISOString(),
    };
    this.writeAtomic('dead', id, dead, false);
    this.remove('inbox', id);
    this.remove('outbox', id);
  }
}

module.exports = { FileQueue, FOLDERS, assertSafeId };
