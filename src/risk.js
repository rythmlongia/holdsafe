'use strict';
/**
 * Deterministic risk + prompt-injection signals.
 * These run BEFORE and independently of the AI, so a manipulated or
 * hallucinating model can never talk the system below these floors.
 */

const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (all |any |the )?(previous|prior|above|system)/i,
  /you are now/i,
  /\bsystem prompt\b/i,
  /\b(act|behave) as (an? )?(admin|administrator|developer|system)/i,
  /(mark|set|return|output|respond with)\s+(this|the verdict|verdict|it)?\s*(as\s+)?["']?(pass|passed|approved|release)/i,
  /"verdict"\s*:\s*"pass"/i,
  /<\/?\s*(system|assistant|untrusted_[a-z_]*)\s*>/i,
  /\bnew instructions\b/i,
  /release (the )?(funds|payment|money) (now|immediately)/i,
];

function detectInjection(text) {
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = String(text || '').match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

const OFF_PLATFORM = /(gift ?cards?|crypto|bitcoin|usdt|wire transfer|western union|zelle|cash app|outside (of )?paypal|off[- ]platform|friends (and|&) family)/i;
const URGENCY = /(urgent|asap|immediately|right now|today only|within the hour)/i;

/**
 * @param {object} deal      the deal being evaluated
 * @param {object} history   { buyerDealsLastHour, sellerCompleted, sellerDisputed, buyerFundedToday }
 * @param {object} policy    config.policy
 */
function ruleSignals(deal, history, policy) {
  const flags = [];
  let score = 5;
  const add = (pts, msg) => { score += pts; flags.push(msg); };

  const amt = deal.amount;
  if (amt > policy.maxDealAmount) add(60, `Amount $${amt} exceeds the per-deal limit of $${policy.maxDealAmount}.`);
  else if (amt > policy.maxDealAmount * 0.5) add(15, 'Amount is in the top half of the allowed range.');

  if (deal.buyerEmail && deal.sellerEmail && deal.buyerEmail.toLowerCase() === deal.sellerEmail.toLowerCase()) {
    add(50, 'Buyer and seller are the same person (self-dealing).');
  }

  const text = `${deal.description} ${deal.contract?.summary || ''}`;
  if (OFF_PLATFORM.test(text)) add(65, 'Deal text mentions off-platform / irreversible payment methods.');
  if (URGENCY.test(text)) add(10, 'Urgency pressure language detected.');
  if (detectInjection(deal.description).length) add(25, 'Deal description contains instructions aimed at the AI agent.');

  if ((history.buyerDealsLastHour || 0) >= 3) add(20, `Buyer created ${history.buyerDealsLastHour} deals in the last hour (velocity).`);
  if ((history.sellerCompleted || 0) === 0) add(10, 'Seller has no completed HoldSafe deals yet.');
  const sd = history.sellerDisputed || 0;
  const sc = history.sellerCompleted || 0;
  if (sd > 0 && sd / (sd + sc) > 0.3) add(25, `Seller has a high dispute rate (${sd}/${sd + sc}).`);

  if (deal.contract && deal.contract.acceptanceCriteria.length < 2) add(10, 'Few acceptance criteria: scope is vague.');
  if (deal.contract && deal.contract.deadlineDays <= 1 && amt > 200) add(10, 'Very short deadline for a sizeable amount.');

  return { ruleScore: Math.min(100, score), flags };
}

module.exports = { detectInjection, ruleSignals, INJECTION_PATTERNS };
