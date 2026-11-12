'use strict';
/**
 * Configuration loader. Zero dependencies: parses a local .env file if present,
 * then reads process.env. Everything has a safe default so the app boots in
 * "mock" mode for judges who have no credentials.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadDotEnv();

const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Secret used to HMAC capability tokens and sign the audit ledger.
  // A random one is generated per boot if not set (fine for demos).
  appSecret: env.APP_SECRET || crypto.randomBytes(32).toString('hex'),

  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    currency: env.CURRENCY || 'USD',
  },

  ai: {
    // anthropic | openai | gemini | heuristic
    provider: (env.AI_PROVIDER || '').toLowerCase(),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    timeoutMs: Number(env.AI_TIMEOUT_MS || 30000),
  },

  rateLimits: {
    all: Number(env.RATE_LIMIT_PER_MIN || 120),
    ai: Number(env.RATE_LIMIT_AI_PER_MIN || 20),
  },

  policy: {
    maxDealAmount: Number(env.POLICY_MAX_DEAL || 5000),
    autoReleaseMaxAmount: Number(env.POLICY_AUTO_RELEASE_MAX || 500),
    autoReleaseMinConfidence: Number(env.POLICY_AUTO_RELEASE_MIN_CONF || 0.85),
    maxRiskScoreToFund: Number(env.POLICY_MAX_RISK || 75),
    dailyBuyerLimit: Number(env.POLICY_DAILY_BUYER_LIMIT || 10000),
  },
};

config.paypal.mock = !(config.paypal.clientId && config.paypal.clientSecret);
config.paypal.baseUrl = config.baseUrl;

// Persist a generated secret so the audit ledger still verifies after restarts.
if (!env.APP_SECRET) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const f = path.join(config.dataDir, '.app_secret');
    if (fs.existsSync(f)) config.appSecret = fs.readFileSync(f, 'utf8').trim();
    else fs.writeFileSync(f, config.appSecret, { mode: 0o600 });
  } catch { /* read-only FS: keep the per-boot secret */ }
}

if (!config.ai.provider) {
  if (config.ai.anthropicKey) config.ai.provider = 'anthropic';
  else if (config.ai.openaiKey) config.ai.provider = 'openai';
  else if (config.ai.geminiKey) config.ai.provider = 'gemini';
  else config.ai.provider = 'heuristic';
}

module.exports = config;
