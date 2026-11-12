'use strict';
/**
 * Tiny persistent key/value store backed by a single JSON file.
 * Writes are atomic (write temp file, then rename) so a crash never leaves
 * half-written state. Good enough for a hackathon demo; swap for Postgres in prod.
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir, { persist = true } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.file = path.join(dir, 'db.json');
    this.data = {};
    if (persist) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
      }
    }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this.flush();
  }

  flush() {
    if (!this.persist) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Deal helpers
  deals() { return this.data.deals || (this.data.deals = {}); }
  getDeal(id) { return this.deals()[id]; }
  saveDeal(deal) {
    deal.updatedAt = new Date().toISOString();
    this.deals()[deal.id] = deal;
    this.flush();
    return deal;
  }
}

module.exports = { Store };
