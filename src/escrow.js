'use strict';
/**
 * Escrow service: the state machine that ties PayPal, the AI agent, the risk
 * engine, the policy engine and the audit ledger together.
 *
 *   PENDING_ACCEPTANCE --seller accepts--> AWAITING_PAYMENT
 *   AWAITING_PAYMENT --buyer approves in PayPal, server authorizes--> FUNDED
 *   FUNDED --seller submits proof, AI verifies-->
 *        AUTO_RELEASE  -> RELEASED   (capture)
 *        otherwise     -> IN_REVIEW
 *   IN_REVIEW --buyer releases--> RELEASED          (capture)
 *   FUNDED|IN_REVIEW --buyer disputes--> DISPUTED --AI mediation, both accept--> RESOLVED
 *        (partial capture with final_capture=true returns the rest to the buyer)
 *   FUNDED --seller refunds / deadline passes and buyer reclaims--> REFUNDED (void)
 *   PENDING_ACCEPTANCE|AWAITING_PAYMENT --cancel--> CANCELLED
 *
 * Access control: each deal has two capability tokens (buyer, seller). Only an
 * HMAC of each token is stored. Every action checks the caller's role.
 */
const crypto = require('node:crypto');
const { extractAuthorization, money } = require('./paypal');
const { ruleSignals, detectInjection } = require('./risk');
const { canFund, releaseDecision, splitAmounts } = require('./policy');

const TRANSITIONS = {
  PENDING_ACCEPTANCE: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['FUNDED', 'CANCELLED'],
  FUNDED: ['IN_REVIEW', 'RELEASED', 'DISPUTED', 'REFUNDED'],
  IN_REVIEW: ['RELEASED', 'DISPUTED', 'IN_REVIEW', 'REFUNDED'],
  DISPUTED: ['RESOLVED', 'RELEASED', 'REFUNDED'],
  RELEASED: [],
  REFUNDED: [],
  RESOLVED: [],
  CANCELLED: [],
};

class EscrowError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(s);

class EscrowService {
  constructor({ store, ledger, paypal, agent, config }) {
    this.store = store;
    this.ledger = ledger;
    this.paypal = paypal;
    this.agent = agent;
    this.config = config;
    this.locks = new Map();
  }

  // --- helpers ---------------------------------------------------------------
  tokenHash(token) {
    return crypto.createHmac('sha256', this.config.appSecret).update(String(token)).digest('hex');
  }

  roleFor(deal, token) {
    if (!token) return null;
    const h = Buffer.from(this.tokenHash(token));
    if (crypto.timingSafeEqual(h, Buffer.from(deal.buyerTokenHash))) return 'buyer';
    if (crypto.timingSafeEqual(h, Buffer.from(deal.sellerTokenHash))) return 'seller';
    return null;
  }

  load(id, token, ...roles) {
    const deal = this.store.getDeal(id);
    if (!deal) throw new EscrowError('Deal not found', 404);
    const role = this.roleFor(deal, token);
    if (!role) throw new EscrowError('Invalid or missing deal access token', 403);
    if (roles.length && !roles.includes(role)) throw new EscrowError(`Only the ${roles.join(' or ')} can do this`, 403);
    return { deal, role };
  }

  transition(deal, to, actor, data = {}) {
    const from = deal.status;
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
      throw new EscrowError(`Cannot move deal from ${from} to ${to}`, 409);
    }
    deal.status = to;
    deal.history.push({ at: new Date().toISOString(), from, to, actor });
    this.ledger.append(deal.id, `STATUS_${to}`, actor, { from, ...data });
  }

  /** Serialize work per deal so double-clicks can't double-capture. */
  async withLock(id, fn) {
    while (this.locks.get(id)) await this.locks.get(id);
    let release;
    const p = new Promise((r) => { release = r; });
    this.locks.set(id, p);
    try { return await fn(); } finally { this.locks.delete(id); release(); }
  }

  history(deal) {
    const all = Object.values(this.store.deals());
    const hourAgo = Date.now() - 3600e3;
    const dayAgo = Date.now() - 864e5;
    const b = deal.buyerEmail.toLowerCase();
    const s = deal.sellerEmail.toLowerCase();
    return {
      buyerDealsLastHour: all.filter((d) => d.buyerEmail.toLowerCase() === b && Date.parse(d.createdAt) > hourAgo).length,
      buyerFundedToday: all.filter((d) => d.id !== deal.id && d.buyerEmail.toLowerCase() === b && d.fundedAt && Date.parse(d.fundedAt) > dayAgo)
        .reduce((sum, d) => sum + d.amount, 0),
      sellerCompleted: all.filter((d) => d.sellerEmail.toLowerCase() === s && d.status === 'RELEASED').length,
      sellerDisputed: all.filter((d) => d.sellerEmail.toLowerCase() === s && (d.status === 'DISPUTED' || d.status === 'RESOLVED' || d.dispute)).length,
    };
  }

  view(deal, role) {
    const {
      buyerTokenHash, sellerTokenHash, ...rest // never leak token hashes
    } = deal;
    return { ...rest, viewerRole: role, mockPayments: this.paypal.mock, aiEngine: this.agent.label };
  }

  // --- actions ---------------------------------------------------------------

  /** Buyer describes the deal in plain English; the AI drafts the contract. */
  async create({ description, amount, buyerEmail, sellerEmail, autoRelease = true }) {
    description = String(description || '').trim();
    if (description.length < 15) throw new EscrowError('Describe the deal in at least a sentence.');
    if (description.length > 4000) throw new EscrowError('Description is too long (4000 chars max).');
    if (!isEmail(buyerEmail) || !isEmail(sellerEmail)) throw new EscrowError('Valid buyer and seller emails are required.');
    const amountHint = amount != null && amount !== '' ? Number(amount) : null;
    if (amountHint != null && !(amountHint > 0 && amountHint < 1e6)) throw new EscrowError('Amount must be a positive number.');

    const contract = await this.agent.draftContract(description, amountHint);
    const finalAmount = Math.round((amountHint || contract.amount) * 100) / 100;
    if (!(finalAmount > 0)) throw new EscrowError('Could not determine the amount. Please enter it explicitly.', 422);
    contract.amount = finalAmount;

    const id = crypto.randomBytes(6).toString('hex');
    const buyerToken = crypto.randomBytes(24).toString('base64url');
    const sellerToken = crypto.randomBytes(24).toString('base64url');
    const now = new Date().toISOString();
    const deal = {
      id,
      createdAt: now,
      status: 'PENDING_ACCEPTANCE',
      description,
      amount: finalAmount,
      currency: this.config.paypal.currency,
      buyerEmail,
      sellerEmail,
      autoRelease: autoRelease !== false,
      contract,
      contractHash: crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
      deadlineAt: null,
      buyerTokenHash: this.tokenHash(buyerToken),
      sellerTokenHash: this.tokenHash(sellerToken),
      paymentAttempt: 0,
      paypal: {},
      risk: null,
      proof: null,
      verification: null,
      decision: null,
      dispute: null,
      history: [{ at: now, from: null, to: 'PENDING_ACCEPTANCE', actor: 'buyer' }],
    };

    // Risk preview so the buyer sees warnings before anyone pays.
    const signals = ruleSignals(deal, this.history(deal), this.config.policy);
    deal.risk = await this.agent.assessRisk(deal, signals);
    deal.risk.ruleFlags = signals.flags;

    this.store.saveDeal(deal);
    this.ledger.append(id, 'DEAL_CREATED', 'buyer', {
      amount: finalAmount, contractHash: deal.contractHash, aiSource: contract._source, riskScore: deal.risk.score,
    });
    return {
      deal: this.view(deal, 'buyer'),
      buyerLink: `${this.config.baseUrl}/?deal=${id}#t=${buyerToken}`,
      sellerLink: `${this.config.baseUrl}/?deal=${id}#t=${sellerToken}`,
      buyerToken,
      sellerToken,
    };
  }

  get(id, token) {
    const { deal, role } = this.load(id, token);
    return this.view(deal, role);
  }

  async accept(id, token) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'seller');
      this.ledger.append(id, 'CONTRACT_ACCEPTED', 'seller', { contractHash: deal.contractHash });
      this.transition(deal, 'AWAITING_PAYMENT', 'seller');
      this.store.saveDeal(deal);
      return this.view(deal, 'seller');
    });
  }

  async cancel(id, token) {
    return this.withLock(id, async () => {
      const { deal, role } = this.load(id, token);
      this.transition(deal, 'CANCELLED', role);
      this.store.saveDeal(deal);
      return this.view(deal, role);
    });
  }

  /** Step 1 of payment: risk/policy gate, then create a PayPal AUTHORIZE order. */
  async createOrder(id, token) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'buyer');
      if (deal.status !== 'AWAITING_PAYMENT') throw new EscrowError(`Deal is ${deal.status}, not awaiting payment`, 409);

      const signals = ruleSignals(deal, this.history(deal), this.config.policy);
      deal.risk = await this.agent.assessRisk(deal, signals);
      deal.risk.ruleFlags = signals.flags;
      const gate = canFund(deal, deal.risk, this.history(deal), this.config.policy);
      this.ledger.append(id, gate.allowed ? 'FUNDING_ALLOWED' : 'FUNDING_BLOCKED', 'policy', { riskScore: deal.risk.score, reasons: gate.reasons });
      if (!gate.allowed) {
        this.store.saveDeal(deal);
        throw new EscrowError('Funding blocked by policy', 403, { reasons: gate.reasons });
      }

      deal.paymentAttempt += 1;
      const order = await this.paypal.createAuthorizeOrder(deal);
      deal.paypal.orderId = order.id;
      deal.paypal.orderStatus = order.status;
      this.ledger.append(id, 'PAYPAL_ORDER_CREATED', 'system', { orderId: order.id, intent: 'AUTHORIZE', amount: money(deal.amount) });
      this.store.saveDeal(deal);
      return { orderId: order.id, mock: this.paypal.mock };
    });
  }

  /** Mock-mode only: simulate the buyer approving in the PayPal popup. */
  mockApprove(id, token) {
    if (!this.paypal.mock) throw new EscrowError('Not available with real PayPal credentials', 404);
    const { deal } = this.load(id, token, 'buyer');
    if (!deal.paypal.orderId) throw new EscrowError('No order yet', 409);
    return this.paypal.mockApprove(deal.paypal.orderId, { email: deal.buyerEmail });
  }

  /** Step 2 of payment: buyer approved; place the hold and verify it exactly. */
  async authorize(id, token, orderId) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'buyer');
      if (deal.status === 'FUNDED') return this.view(deal, 'buyer'); // idempotent
      if (deal.status !== 'AWAITING_PAYMENT') throw new EscrowError(`Deal is ${deal.status}`, 409);
      if (!orderId || orderId !== deal.paypal.orderId) {
        this.ledger.append(id, 'ORDER_MISMATCH', 'system', { got: String(orderId).slice(0, 40) });
        throw new EscrowError('Order does not belong to this deal', 400);
      }

      const order = await this.paypal.authorizeOrder(orderId);
      const auth = extractAuthorization(order);
      if (!auth) throw new EscrowError('PayPal did not return an authorization', 502);

      // Verify PayPal held exactly what we expect. Never trust the client.
      const pu = order.purchase_units[0];
      const okAmount = auth.amount.value === money(deal.amount) && auth.amount.currency_code === deal.currency;
      const okRef = !pu.reference_id || pu.reference_id === deal.id;
      if (!okAmount || !okRef || !['CREATED', 'PENDING'].includes(auth.status)) {
        this.ledger.append(id, 'AUTHORIZATION_REJECTED', 'system', { authId: auth.id, status: auth.status, amount: auth.amount });
        try { await this.paypal.voidAuthorization(auth.id); } catch { /* best effort */ }
        throw new EscrowError('Authorization did not match the deal and was voided', 400);
      }

      deal.paypal.authorizationId = auth.id;
      deal.paypal.authorizationStatus = auth.status;
      deal.paypal.authorizationExpiresAt = auth.expiration_time;
      deal.paypal.payerEmail = order.payer?.email_address;
      deal.paypal.payerId = order.payer?.payer_id;
      deal.paypal.sellerProtection = auth.seller_protection?.status;
      deal.fundedAt = new Date().toISOString();
      deal.deadlineAt = new Date(Date.now() + deal.contract.deadlineDays * 864e5).toISOString();
      this.ledger.append(id, 'FUNDS_HELD', 'paypal', {
        authorizationId: auth.id, amount: auth.amount.value, expires: auth.expiration_time, payerId: deal.paypal.payerId,
      });
      this.transition(deal, 'FUNDED', 'buyer');
      this.store.saveDeal(deal);
      return this.view(deal, 'buyer');
    });
  }

  /** Seller submits delivery proof -> AI verifies -> policy decides. */
  async deliver(id, token, { text, links }) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'seller');
      if (!['FUNDED', 'IN_REVIEW'].includes(deal.status)) throw new EscrowError(`Deal is ${deal.status}`, 409);
      text = String(text || '').trim().slice(0, 6000);
      if (text.length < 10) throw new EscrowError('Describe what you delivered (with evidence).');
      links = (Array.isArray(links) ? links : String(links || '').split(/\s+/))
        .map((l) => String(l).trim()).filter((l) => /^https?:\/\/[^\s<>"]{3,500}$/.test(l)).slice(0, 10);

      const injection = detectInjection(text + ' ' + links.join(' '));
      deal.proof = { text, links, submittedAt: new Date().toISOString(), injectionPatterns: injection };
      deal.proofHash = crypto.createHash('sha256').update(text + '\n' + links.join('\n')).digest('hex');
      this.ledger.append(id, 'DELIVERY_SUBMITTED', 'seller', { proofHash: deal.proofHash, links: links.length, injectionPatterns: injection.length });

      const v = await this.agent.verifyDelivery(deal.contract, deal.proof, injection.length > 0);
      deal.verification = v;
      const decision = releaseDecision(deal, v, this.config.policy);
      deal.decision = decision;
      this.ledger.append(id, 'AI_VERDICT', 'ai', {
        verdict: v.verdict, confidence: v.confidence, injectionSuspected: v.injectionSuspected, source: v._source, action: decision.action,
      });

      if (decision.action === 'AUTO_RELEASE') {
        if (deal.status === 'FUNDED') this.transition(deal, 'IN_REVIEW', 'ai');
        await this._capture(deal, deal.amount, 'ai', 'Delivery verified by HoldSafe AI agent');
      } else if (deal.status === 'FUNDED') {
        this.transition(deal, 'IN_REVIEW', 'ai', { action: decision.action });
      } else {
        this.ledger.append(id, 'REVIEW_UPDATED', 'ai', { action: decision.action });
      }
      this.store.saveDeal(deal);
      return this.view(deal, 'seller');
    });
  }

  async release(id, token) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'buyer');
      if (!['FUNDED', 'IN_REVIEW'].includes(deal.status)) throw new EscrowError(`Deal is ${deal.status}`, 409);
      await this._capture(deal, deal.amount, 'buyer', 'Released by buyer');
      this.store.saveDeal(deal);
      return this.view(deal, 'buyer');
    });
  }

  async _capture(deal, amount, actor, note) {
    const cap = await this.paypal.captureAuthorization(deal.paypal.authorizationId, amount, {
      note, invoiceId: `HS-${deal.id}-CAP`,
    });
    deal.paypal.captureId = cap.id;
    deal.paypal.captureStatus = cap.status;
    deal.paypal.authorizationStatus = 'CAPTURED';
    deal.paypal.capturedAmount = Number(cap.amount?.value ?? amount);
    this.ledger.append(deal.id, 'FUNDS_CAPTURED', actor, { captureId: cap.id, amount: money(amount), status: cap.status });
    const target = deal.status === 'DISPUTED' && Number(amount) < deal.amount ? 'RESOLVED' : 'RELEASED';
    this.transition(deal, target, actor);
  }

  /** Seller voluntarily returns the money, or buyer reclaims after the deadline with no delivery. */
  async refund(id, token) {
    return this.withLock(id, async () => {
      const { deal, role } = this.load(id, token);
      const late = deal.deadlineAt && Date.now() > Date.parse(deal.deadlineAt) && !deal.proof;
      if (role === 'buyer' && !(deal.status === 'FUNDED' && late)) {
        throw new EscrowError('Buyers can reclaim funds only after the deadline passes with no delivery. Otherwise open a dispute.', 403);
      }
      if (!['FUNDED', 'IN_REVIEW', 'DISPUTED'].includes(deal.status)) throw new EscrowError(`Deal is ${deal.status}`, 409);
      await this.paypal.voidAuthorization(deal.paypal.authorizationId);
      deal.paypal.authorizationStatus = 'VOIDED';
      this.ledger.append(id, 'FUNDS_RETURNED', role, { authorizationId: deal.paypal.authorizationId, reason: late ? 'deadline_passed' : 'seller_refund' });
      this.transition(deal, 'REFUNDED', role);
      this.store.saveDeal(deal);
      return this.view(deal, role);
    });
  }

  async dispute(id, token, { claim }) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'buyer');
      claim = String(claim || '').trim().slice(0, 3000);
      if (claim.length < 10) throw new EscrowError('Explain what is wrong.');
      deal.dispute = { claim, openedAt: new Date().toISOString(), response: null, proposal: null, acceptedBy: [] };
      this.transition(deal, 'DISPUTED', 'buyer');
      deal.dispute.proposal = await this.agent.mediateDispute(deal.contract, deal.proof, deal.verification, claim, null);
      this.ledger.append(id, 'AI_MEDIATION', 'ai', { ...pick(deal.dispute.proposal, ['recommendation', 'sellerPercent', '_source']) });
      this.store.saveDeal(deal);
      return this.view(deal, 'buyer');
    });
  }

  async respond(id, token, { response }) {
    return this.withLock(id, async () => {
      const { deal } = this.load(id, token, 'seller');
      if (deal.status !== 'DISPUTED') throw new EscrowError('No open dispute', 409);
      deal.dispute.response = String(response || '').trim().slice(0, 3000);
      deal.dispute.acceptedBy = []; // new info invalidates earlier acceptances
      deal.dispute.proposal = await this.agent.mediateDispute(deal.contract, deal.proof, deal.verification, deal.dispute.claim, deal.dispute.response);
      this.ledger.append(id, 'AI_MEDIATION', 'ai', { ...pick(deal.dispute.proposal, ['recommendation', 'sellerPercent', '_source']), revised: true });
      this.store.saveDeal(deal);
      return this.view(deal, 'seller');
    });
  }

  /** Both parties must accept the AI proposal before money moves. */
  async acceptProposal(id, token) {
    return this.withLock(id, async () => {
      const { deal, role } = this.load(id, token);
      if (deal.status !== 'DISPUTED' || !deal.dispute?.proposal) throw new EscrowError('No proposal to accept', 409);
      if (!deal.dispute.acceptedBy.includes(role)) deal.dispute.acceptedBy.push(role);
      this.ledger.append(id, 'PROPOSAL_ACCEPTED', role, { sellerPercent: deal.dispute.proposal.sellerPercent });
      if (deal.dispute.acceptedBy.length === 2) {
        const { seller } = splitAmounts(deal.amount, deal.dispute.proposal.sellerPercent);
        if (seller <= 0) {
          await this.paypal.voidAuthorization(deal.paypal.authorizationId);
          deal.paypal.authorizationStatus = 'VOIDED';
          this.ledger.append(id, 'FUNDS_RETURNED', 'settlement', { reason: 'mediation' });
          this.transition(deal, 'REFUNDED', 'settlement');
        } else {
          // Partial capture with final_capture=true: PayPal releases the remainder back to the buyer.
          await this._capture(deal, seller, 'settlement', `Dispute settlement: ${deal.dispute.proposal.sellerPercent}% to seller`);
        }
        deal.dispute.settledAt = new Date().toISOString();
      }
      this.store.saveDeal(deal);
      return this.view(deal, role);
    });
  }

  /** Apply verified PayPal webhook events (keeps state in sync if something happens outside the app). */
  handleWebhook(event) {
    const seen = this.store.get('webhookIds') || [];
    if (seen.includes(event.id)) return { duplicate: true };
    this.store.set('webhookIds', [...seen.slice(-500), event.id]);

    const res = event.resource || {};
    const dealId = res.custom_id || res.supplementary_data?.related_ids?.order_id && this.findByOrder(res.supplementary_data.related_ids.order_id)?.id;
    const deal = dealId && this.store.getDeal(dealId);
    this.ledger.append(dealId || null, 'WEBHOOK_' + event.event_type, 'paypal', { eventId: event.id, resourceId: res.id });
    if (!deal) return { matched: false };

    if (event.event_type === 'PAYMENT.AUTHORIZATION.VOIDED' && ['FUNDED', 'IN_REVIEW'].includes(deal.status)) {
      deal.paypal.authorizationStatus = 'VOIDED';
      this.transition(deal, 'REFUNDED', 'paypal');
    }
    if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') {
      deal.paypalDispute = { id: res.dispute_id, reason: res.reason };
    }
    this.store.saveDeal(deal);
    return { matched: true };
  }

  findByOrder(orderId) {
    return Object.values(this.store.deals()).find((d) => d.paypal.orderId === orderId);
  }

  stats() {
    const all = Object.values(this.store.deals());
    const by = (s) => all.filter((d) => d.status === s);
    const sum = (list) => Math.round(list.reduce((a, d) => a + d.amount, 0) * 100) / 100;
    return {
      deals: all.length,
      heldNow: sum([...by('FUNDED'), ...by('IN_REVIEW'), ...by('DISPUTED')]),
      released: sum(by('RELEASED')),
      refunded: sum(by('REFUNDED')),
      autoReleased: all.filter((d) => d.decision?.action === 'AUTO_RELEASE').length,
      injectionsBlocked: all.filter((d) => d.verification?.injectionSuspected).length,
      fundingBlocked: (this.store.get('ledger') || []).filter((e) => e.type === 'FUNDING_BLOCKED').length,
    };
  }
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k]; return r; }

module.exports = { EscrowService, EscrowError, TRANSITIONS };
