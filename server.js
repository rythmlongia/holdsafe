'use strict';
/**
 * HoldSafe server - zero runtime dependencies (Node 18+).
 *   node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./src/config');
const { Store } = require('./src/store');
const { Ledger } = require('./src/ledger');
const { PayPalClient, PayPalError } = require('./src/paypal');
const { EscrowAgent } = require('./src/ai');
const { EscrowService, EscrowError } = require('./src/escrow');

function buildApp(cfg = config, { persist = true } = {}) {
  const store = new Store(cfg.dataDir, { persist });
  const ledger = new Ledger(store, cfg.appSecret);
  const paypal = new PayPalClient(cfg.paypal);
  const agent = new EscrowAgent(cfg.ai);
  const escrow = new EscrowService({ store, ledger, paypal, agent, config: cfg });

  // ---- tiny rate limiter (per IP, per bucket) -------------------------------
  const buckets = new Map();
  function rateLimited(ip, bucket, limit, windowMs = 60_000) {
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const b = buckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
    b.count++;
    buckets.set(key, b);
    return b.count > limit;
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://www.paypal.com https://*.paypal.com https://*.paypalobjects.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com",
      "frame-src https://*.paypal.com",
      "connect-src 'self' https://*.paypal.com",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new EscrowError('Request body too large', 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function json(req) {
    if (!/application\/json/.test(req.headers['content-type'] || '')) {
      throw new EscrowError('Content-Type must be application/json', 415);
    }
    const raw = await readBody(req);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new EscrowError('Invalid JSON', 400); }
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const PUBLIC = path.join(__dirname, 'public');

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    });
  }

  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true })],
    ['GET', /^\/api\/config$/, async () => ({
      paypalClientId: cfg.paypal.mock ? null : cfg.paypal.clientId,
      currency: cfg.paypal.currency,
      mockPayments: cfg.paypal.mock,
      aiEngine: agent.label,
      policy: cfg.policy,
    })],
    ['GET', /^\/api\/stats$/, async () => escrow.stats()],
    ['GET', /^\/api\/ledger\/verify$/, async () => ledger.verify()],
    ['POST', /^\/api\/deals$/, async (ctx) => escrow.create(await json(ctx.req)), { bucket: 'ai' }],
    ['GET', /^\/api\/deals\/([a-f0-9]{12})$/, async (ctx, id) => escrow.get(id, ctx.token)],
    ['GET', /^\/api\/deals\/([a-f0-9]{12})\/ledger$/, async (ctx, id) => {
      escrow.get(id, ctx.token); // access check
      return { entries: ledger.entries(id), chain: ledger.verify() };
    }],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/accept$/, async (ctx, id) => escrow.accept(id, ctx.token)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/cancel$/, async (ctx, id) => escrow.cancel(id, ctx.token)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/order$/, async (ctx, id) => escrow.createOrder(id, ctx.token), { bucket: 'ai' }],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/mock-approve$/, async (ctx, id) => escrow.mockApprove(id, ctx.token)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/authorize$/, async (ctx, id) => escrow.authorize(id, ctx.token, (await json(ctx.req)).orderId)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/deliver$/, async (ctx, id) => escrow.deliver(id, ctx.token, await json(ctx.req)), { bucket: 'ai' }],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/release$/, async (ctx, id) => escrow.release(id, ctx.token)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/refund$/, async (ctx, id) => escrow.refund(id, ctx.token)],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/dispute$/, async (ctx, id) => escrow.dispute(id, ctx.token, await json(ctx.req)), { bucket: 'ai' }],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/respond$/, async (ctx, id) => escrow.respond(id, ctx.token, await json(ctx.req)), { bucket: 'ai' }],
    ['POST', /^\/api\/deals\/([a-f0-9]{12})\/accept-proposal$/, async (ctx, id) => escrow.acceptProposal(id, ctx.token)],
    ['POST', /^\/api\/webhooks\/paypal$/, async (ctx) => {
      const raw = await readBody(ctx.req, 256 * 1024);
      const v = await paypal.verifyWebhook(ctx.req.headers, raw);
      if (v.verification_status !== 'SUCCESS') {
        ledger.append(null, 'WEBHOOK_REJECTED', 'system', { reason: 'signature verification failed' });
        throw new EscrowError('Webhook signature verification failed', 401);
      }
      return escrow.handleWebhook(JSON.parse(raw));
    }, { bucket: 'webhook', limit: 300 }],
  ];

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    if (rateLimited(ip, 'all', cfg.rateLimits.all)) return send(res, 429, { error: 'Too many requests' });

    // CSRF defence: state-changing API calls must come from our own origin (or a server like PayPal webhooks).
    if (req.method === 'POST' && pathname !== '/api/webhooks/paypal') {
      const origin = req.headers.origin;
      if (origin && origin !== cfg.baseUrl && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        return send(res, 403, { error: 'Cross-origin request blocked' });
      }
    }

    for (const [method, re, fn, opts] of routes) {
      if (req.method !== method) continue;
      const m = pathname.match(re);
      if (!m) continue;
      if (opts && rateLimited(ip, opts.bucket, opts.limit || cfg.rateLimits[opts.bucket])) return send(res, 429, { error: 'Slow down: rate limit for this action reached' });
      const ctx = { req, res, token: req.headers['x-deal-token'] };
      try {
        const out = await fn(ctx, ...m.slice(1));
        return send(res, 200, out);
      } catch (err) {
        if (err instanceof EscrowError) return send(res, err.status, { error: err.message, reasons: err.reasons });
        if (err instanceof PayPalError) {
          ledger.append(m[1] && /^[a-f0-9]{12}$/.test(m[1]) ? m[1] : null, 'PAYPAL_ERROR', 'paypal', { status: err.status, message: err.message, debugId: err.debugId });
          return send(res, 502, { error: `PayPal: ${err.message}`, debugId: err.debugId, details: err.details });
        }
        console.error(err);
        return send(res, 500, { error: 'Internal error' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  return { handler, store, ledger, paypal, agent, escrow };
}

if (require.main === module) {
  const app = buildApp();
  http.createServer(app.handler).listen(config.port, () => {
    console.log(`\n  HoldSafe running at ${config.baseUrl}`);
    console.log(`  PayPal : ${config.paypal.mock ? 'MOCK mode (set PAYPAL_CLIENT_ID/SECRET for sandbox)' : 'Sandbox ' + config.paypal.apiBase}`);
    console.log(`  AI     : ${app.agent.label}\n`);
  });
}

module.exports = { buildApp };
