'use strict';

const crypto = require('crypto');
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
      .filter((name) => /^\d{1,25}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }

  listRecords(folder) {
    const records = [];
    for (const id of this.list(folder)) {
      try {
        const record = this.read(folder, id);
        if (record) records.push(record);
      } catch (err) {
        this.quarantine(folder, `${id}.json`, 'bad_json');
      }
    }
    return records;
  }

  sendingDir() {
    return path.join(this.root, 'sending');
  }

  sendingPath(id) {
    return path.join(this.sendingDir(), `${assertSafeId(id)}.json`);
  }

  readSending(id) {
    const file = this.sendingPath(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  writeSending(id, record) {
    const dir = this.sendingDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const dest = this.sendingPath(id);
    fs.writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
  }

  removeSending(id) {
    const file = this.sendingPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  claimOutbox(id) {
    const safe = assertSafeId(id);
    if (this.exists('done', safe)) {
      this.remove('outbox', safe);
      this.removeSending(safe);
      return { alreadyDone: true };
    }
    const src = this.pathFor('outbox', safe);
    if (!fs.existsSync(src)) return null;
    this.writeSending(safe, JSON.parse(fs.readFileSync(src, 'utf8')));
    fs.unlinkSync(src);
    return { claimed: true, record: this.readSending(safe) };
  }

  restoreClaim(id, record) {
    const safe = assertSafeId(id);
    if (record) this.overwrite('outbox', safe, record);
    else if (this.readSending(safe)) this.overwrite('outbox', safe, this.readSending(safe));
    this.removeSending(safe);
  }

  restoreSending() {
    const dir = this.sendingDir();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{1,25}\.json$/.test(name)) {
        this.quarantineFile(dir, name, 'bad_sending');
        continue;
      }
      const id = name.slice(0, -5);
      if (this.exists('done', id) || this.exists('dead', id)) {
        fs.unlinkSync(path.join(dir, name));
        continue;
      }
      if (!this.exists('outbox', id)) {
        fs.renameSync(path.join(dir, name), this.pathFor('outbox', id));
      } else {
        fs.unlinkSync(path.join(dir, name));
      }
    }
  }

  quarantine(folder, filename, reason) {
    if (!this.dirs[folder]) return;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
    this.quarantineFile(this.dirs[folder], filename, reason);
  }

  quarantineFile(dir, filename, reason) {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
    const src = path.join(dir, filename);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return;
    this.ensure();
    let snippet = '';
    try { snippet = fs.readFileSync(src, 'utf8').slice(0, 200); } catch (err) { snippet = ''; }
    const digest = crypto.createHash('sha256').update(filename).digest('hex').slice(0, 16);
    const dest = path.join(this.dirs.dead, `corrupt-${digest}.json`);
    const record = {
      status: 'dead',
      error: reason || 'corrupt',
      file: filename,
      failedAt: new Date().toISOString(),
      snippet: snippet.replace(/[^\x20-\x7E\n]/g, '?').slice(0, 200),
    };
    fs.writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
    fs.unlinkSync(src);
  }

  quarantineBad(folder) {
    this.ensure();
    const dir = this.dirs[folder];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (!/^\d{1,25}\.json$/.test(name)) {
        this.quarantine(folder, name, 'bad_id');
        continue;
      }
      try {
        JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        this.quarantine(folder, name, 'bad_json');
      }
    }
  }

  sweepTmp() {
    const dirs = Object.values(this.dirs).concat([this.sendingDir(), path.join(this.root, 'state')]);
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.includes('.tmp')) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) fs.unlinkSync(full);
        } catch (err) { /* ignore */ }
      }
    }
  }

  sweepExpired(now, ttlMs) {
    const stamp = now == null ? Date.now() : now;
    for (const folder of ['done', 'dead']) {
      for (const id of this.list(folder)) {
        try {
          const record = this.read(folder, id);
          const when = Date.parse((record && (record.finishedAt || record.failedAt)) || 0);
          if (Number.isFinite(when) && stamp - when > ttlMs) this.remove(folder, id);
        } catch (err) {
          this.quarantine(folder, `${id}.json`, 'bad_json');
        }
      }
    }
    for (const id of this.list('inbox')) {
      try {
        const record = this.read('inbox', id);
        const when = Date.parse(record && record.enqueuedAt);
        if (Number.isFinite(when) && stamp - when > ttlMs) this.fail(id, { error: 'expired' });
      } catch (err) {
        this.quarantine('inbox', `${id}.json`, 'bad_json');
      }
    }
  }

  authorKey() {
    this.ensure();
    const dir = path.join(this.root, 'state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'author.key');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    fs.chmodSync(file, 0o600);
    return fs.readFileSync(file, 'utf8').trim();
  }

  authorLabel(id) {
    return crypto.createHmac('sha256', this.authorKey()).update(String(id)).digest('hex');
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
    try { this.removeSending(id); } catch (err) { /* id already checked */ }
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
    try { this.removeSending(id); } catch (err) { /* id already checked */ }
  }
}

module.exports = { FileQueue, FOLDERS, assertSafeId };
