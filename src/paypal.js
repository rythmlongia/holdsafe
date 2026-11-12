'use strict';
/**
 * PayPal REST client (Orders v2 + Payments v2 + Webhooks), zero dependencies.
 *
 * Security choices:
 *  - Orders are created with intent=AUTHORIZE: the buyer's funds are HELD,
 *    not moved, until the escrow agent decides to capture or void.
 *  - Every mutating call sends a PayPal-Request-Id so retries are idempotent
 *    (a network retry can never double-charge or double-capture).
 *  - Amounts are always computed server-side from the stored deal; the client
 *    never tells us how much to charge.
 *  - Webhooks are verified with PayPal's verify-webhook-signature API before
 *    we act on them.
 *  - OAuth tokens are cached in memory and refreshed before expiry.
 *
 * If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are absent, a faithful in-memory
 * mock with the same response shapes is used so the app still runs end to end.
 */
const crypto = require('node:crypto');

class PayPalError extends Error {
  constructor(message, status, details, debugId) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details;
    this.debugId = debugId;
  }
}

function money(value) {
  // PayPal wants a string with exactly 2 decimals for USD/EUR/etc.
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

class PayPalClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get mock() { return this.cfg.mock; }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const auth = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await fetch(`${this.cfg.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError('PayPal OAuth failed', res.status, json);
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  async request(method, path, body, { requestId } = {}) {
    const token = await this.accessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new PayPalError(json.message || `PayPal ${method} ${path} failed`, res.status, json.details, json.debug_id);
    }
    return json;
  }

  /** Create an order whose funds will be authorized (held), not captured. */
  async createAuthorizeOrder(deal) {
    const body = {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: deal.id,
        custom_id: deal.id,
        invoice_id: `HS-${deal.id}-${deal.paymentAttempt || 1}`,
        description: `HoldSafe escrow: ${deal.contract.title}`.slice(0, 127),
        soft_descriptor: 'HOLDSAFE',
        amount: {
          currency_code: this.cfg.currency,
          value: money(deal.amount),
          breakdown: { item_total: { currency_code: this.cfg.currency, value: money(deal.amount) } },
        },
        items: [{
          name: deal.contract.title.slice(0, 127),
          quantity: '1',
          category: deal.contract.category === 'physical_goods' ? 'PHYSICAL_GOODS' : 'DIGITAL_GOODS',
          unit_amount: { currency_code: this.cfg.currency, value: money(deal.amount) },
        }],
      }],
      application_context: {
        brand_name: 'HoldSafe Escrow',
        user_action: 'CONTINUE',
        shipping_preference: deal.contract.category === 'physical_goods' ? 'GET_FROM_FILE' : 'NO_SHIPPING',
      },
    };
    if (this.mock) return this.mockCreate(body);
    return this.request('POST', '/v2/checkout/orders', body, { requestId: `create-${deal.id}-${deal.paymentAttempt || 1}` });
  }

  async getOrder(orderId) {
    if (this.mock) return this.mockGet(orderId);
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /** Buyer approved -> place the hold. Returns order with authorization id. */
  async authorizeOrder(orderId) {
    if (this.mock) return this.mockAuthorize(orderId);
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, { requestId: `auth-${orderId}` });
  }

  async getAuthorization(authId) {
    if (this.mock) return this.mockGetAuth(authId);
    return this.request('GET', `/v2/payments/authorizations/${encodeURIComponent(authId)}`);
  }

  /** Release escrow to the seller. */
  async captureAuthorization(authId, amount, { note, invoiceId } = {}) {
    const body = {
      amount: { currency_code: this.cfg.currency, value: money(amount) },
      final_capture: true,
      note_to_payer: (note || 'Released by HoldSafe escrow agent').slice(0, 255),
      invoice_id: invoiceId,
    };
    if (this.mock) return this.mockCapture(authId, body);
    return this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`, body, { requestId: `capture-${authId}` });
  }

  /** Return the hold to the buyer. */
  async voidAuthorization(authId) {
    if (this.mock) return this.mockVoid(authId);
    return this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(authId)}/void`, null, { requestId: `void-${authId}` });
  }

  /** Partial refund after capture (used for split dispute settlements). */
  async refundCapture(captureId, amount, note) {
    const body = { amount: { currency_code: this.cfg.currency, value: money(amount) }, note_to_payer: (note || '').slice(0, 255) };
    if (this.mock) return this.mockRefund(captureId, body);
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, { requestId: `refund-${captureId}-${money(amount)}` });
  }

  /** Verify a webhook really came from PayPal. */
  async verifyWebhook(headers, rawBody) {
    if (this.mock) return { verification_status: 'SUCCESS', mock: true };
    if (!this.cfg.webhookId) throw new PayPalError('PAYPAL_WEBHOOK_ID not configured', 500);
    const h = (k) => headers[k.toLowerCase()];
    return this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.cfg.webhookId,
      webhook_event: JSON.parse(rawBody),
    });
  }

  // ---------------------------------------------------------------------------
  // Mock implementation (same shapes as the real API, no network)
  // ---------------------------------------------------------------------------
  _mockState() {
    if (!this._mock) this._mock = { orders: {}, auths: {}, captures: {} };
    return this._mock;
  }

  _id(prefix) { return prefix + crypto.randomBytes(8).toString('hex').toUpperCase(); }

  mockCreate(body) {
    const s = this._mockState();
    const id = this._id('MOCK');
    const order = {
      id,
      intent: body.intent,
      status: 'CREATED',
      purchase_units: body.purchase_units,
      links: [{ rel: 'approve', href: `#mock-approve-${id}`, method: 'GET' }],
      create_time: new Date().toISOString(),
    };
    s.orders[id] = order;
    return structuredClone(order);
  }

  mockGet(orderId) {
    const o = this._mockState().orders[orderId];
    if (!o) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    return structuredClone(o);
  }

  /** Simulates the buyer clicking "approve" in the PayPal popup. */
  mockApprove(orderId, payer = {}) {
    const o = this._mockState().orders[orderId];
    if (!o) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    o.status = 'APPROVED';
    o.payer = {
      email_address: payer.email || 'sandbox-buyer@example.com',
      payer_id: payer.payerId || 'MOCKPAYER' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      name: { given_name: 'Sandbox', surname: 'Buyer' },
      address: { country_code: payer.country || 'US' },
    };
    return structuredClone(o);
  }

  mockAuthorize(orderId) {
    const s = this._mockState();
    const o = s.orders[orderId];
    if (!o) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    if (o.status === 'COMPLETED') return structuredClone(o); // idempotent
    if (o.status !== 'APPROVED') throw new PayPalError('ORDER_NOT_APPROVED', 422, [{ issue: 'ORDER_NOT_APPROVED' }]);
    const authId = this._id('AUTH');
    const amount = o.purchase_units[0].amount;
    const auth = {
      id: authId,
      status: 'CREATED',
      amount: { currency_code: amount.currency_code, value: amount.value },
      expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(),
      create_time: new Date().toISOString(),
      seller_protection: { status: 'ELIGIBLE' },
    };
    s.auths[authId] = auth;
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { authorizations: [auth] };
    return structuredClone(o);
  }

  mockGetAuth(authId) {
    const a = this._mockState().auths[authId];
    if (!a) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    return structuredClone(a);
  }

  mockCapture(authId, body) {
    const s = this._mockState();
    const a = s.auths[authId];
    if (!a) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    if (a.status === 'CAPTURED') return structuredClone(a._capture);
    if (a.status !== 'CREATED') throw new PayPalError('AUTHORIZATION_ALREADY_' + a.status, 422);
    if (Number(body.amount.value) > Number(a.amount.value)) throw new PayPalError('AMOUNT_EXCEEDS_AUTHORIZED', 422);
    const cap = { id: this._id('CAP'), status: 'COMPLETED', amount: body.amount, final_capture: true, create_time: new Date().toISOString() };
    a.status = 'CAPTURED';
    a._capture = cap;
    s.captures[cap.id] = { ...cap, refunded: 0 };
    return structuredClone(cap);
  }

  mockVoid(authId) {
    const a = this._mockState().auths[authId];
    if (!a) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    if (a.status === 'VOIDED') return structuredClone(a);
    if (a.status !== 'CREATED') throw new PayPalError('AUTHORIZATION_ALREADY_' + a.status, 422);
    a.status = 'VOIDED';
    return structuredClone(a);
  }

  mockRefund(captureId, body) {
    const c = this._mockState().captures[captureId];
    if (!c) throw new PayPalError('RESOURCE_NOT_FOUND', 404);
    const amt = Number(body.amount.value);
    if (c.refunded + amt > Number(c.amount.value) + 1e-9) throw new PayPalError('REFUND_AMOUNT_EXCEEDED', 422);
    c.refunded += amt;
    return { id: this._id('REF'), status: 'COMPLETED', amount: body.amount };
  }
}

/** Pull the first authorization out of an order response. */
function extractAuthorization(order) {
  const pu = order && order.purchase_units && order.purchase_units[0];
  const auths = pu && pu.payments && pu.payments.authorizations;
  return auths && auths[0];
}

module.exports = { PayPalClient, PayPalError, money, extractAuthorization };
