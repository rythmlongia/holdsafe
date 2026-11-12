'use strict';
/**
 * Tamper-evident audit ledger.
 *
 * Every security-relevant event (deal created, order authorized, AI verdict,
 * capture, void, policy block...) is appended as an entry whose hash covers
 * the previous entry's hash. Each entry is also HMAC-signed with APP_SECRET,
 * so editing or deleting any past line breaks verification.
 */
const crypto = require('node:crypto');

function canonical(obj) {
  // Stable JSON: sorted keys at every level so hashing is deterministic.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

const GENESIS = '0'.repeat(64);

class Ledger {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
  }

  entries(dealId) {
    const all = this.store.get('ledger') || [];
    return dealId ? all.filter((e) => e.dealId === dealId) : all;
  }

  append(dealId, type, actor, data = {}) {
    const all = this.store.get('ledger') || [];
    const prevHash = all.length ? all[all.length - 1].hash : GENESIS;
    const body = {
      seq: all.length,
      ts: new Date().toISOString(),
      dealId,
      type,
      actor,
      data,
      prevHash,
    };
    const hash = crypto.createHash('sha256').update(canonical(body)).digest('hex');
    const sig = crypto.createHmac('sha256', this.secret).update(hash).digest('hex');
    const entry = { ...body, hash, sig };
    all.push(entry);
    this.store.set('ledger', all);
    return entry;
  }

  /** Re-derive every hash + signature. Returns {ok, length, brokenAt?, reason?}. */
  verify() {
    const all = this.store.get('ledger') || [];
    let prev = GENESIS;
    for (let i = 0; i < all.length; i++) {
      const { hash, sig, ...body } = all[i];
      if (body.seq !== i) return { ok: false, length: all.length, brokenAt: i, reason: 'sequence gap' };
      if (body.prevHash !== prev) return { ok: false, length: all.length, brokenAt: i, reason: 'chain link mismatch' };
      const h = crypto.createHash('sha256').update(canonical(body)).digest('hex');
      if (h !== hash) return { ok: false, length: all.length, brokenAt: i, reason: 'content hash mismatch' };
      const s = crypto.createHmac('sha256', this.secret).update(hash).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig))) {
        return { ok: false, length: all.length, brokenAt: i, reason: 'signature mismatch' };
      }
      prev = hash;
    }
    return { ok: true, length: all.length, head: prev };
  }
}

module.exports = { Ledger, canonical, GENESIS };
