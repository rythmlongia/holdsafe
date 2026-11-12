'use strict';
/**
 * Policy engine: the only component allowed to decide that money moves.
 * The AI recommends; these deterministic rules decide. Every decision returns
 * its reasons so it can be written to the audit ledger and shown to users.
 */

function canFund(deal, risk, history, policy) {
  const reasons = [];
  if (!(deal.amount > 0)) reasons.push('Deal amount must be greater than zero.');
  if (deal.amount > policy.maxDealAmount) reasons.push(`Per-deal limit is $${policy.maxDealAmount}.`);
  if ((history.buyerFundedToday || 0) + deal.amount > policy.dailyBuyerLimit) {
    reasons.push(`Buyer daily escrow limit of $${policy.dailyBuyerLimit} would be exceeded.`);
  }
  if (risk && risk.score > policy.maxRiskScoreToFund) {
    reasons.push(`Risk score ${risk.score} is above the funding threshold of ${policy.maxRiskScoreToFund}.`);
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Decide what happens after the AI verifies a delivery.
 * AUTO_RELEASE  - capture now, no human needed (small, clean, high-confidence)
 * BUYER_CONFIRM - buyer must click release (or dispute)
 * HUMAN_REVIEW  - something smells (injection, high risk): auto-release disabled
 */
function releaseDecision(deal, verification, policy) {
  const reasons = [];
  if (verification.injectionSuspected) {
    reasons.push('Delivery proof tried to instruct the AI agent; automatic release disabled.');
    return { action: 'HUMAN_REVIEW', reasons };
  }
  if (deal.risk && deal.risk.level === 'high') {
    reasons.push('Deal was rated high-risk at funding time.');
    return { action: 'HUMAN_REVIEW', reasons };
  }
  if (verification.verdict !== 'PASS') {
    reasons.push(`AI verdict is ${verification.verdict}; buyer must confirm or dispute.`);
    return { action: 'BUYER_CONFIRM', reasons };
  }
  if (verification.confidence < policy.autoReleaseMinConfidence) {
    reasons.push(`AI confidence ${verification.confidence} is below ${policy.autoReleaseMinConfidence}.`);
    return { action: 'BUYER_CONFIRM', reasons };
  }
  if (deal.amount > policy.autoReleaseMaxAmount) {
    reasons.push(`Amount $${deal.amount} is above the auto-release cap of $${policy.autoReleaseMaxAmount}.`);
    return { action: 'BUYER_CONFIRM', reasons };
  }
  if (deal.autoRelease === false) {
    reasons.push('Buyer opted out of automatic release.');
    return { action: 'BUYER_CONFIRM', reasons };
  }
  reasons.push('All criteria met with high confidence, low risk, and amount under the auto-release cap.');
  return { action: 'AUTO_RELEASE', reasons };
}

/** Convert a mediation % into exact cent amounts that always sum to the total. */
function splitAmounts(total, sellerPercent) {
  const cents = Math.round(total * 100);
  const sellerCents = Math.round((cents * Math.min(100, Math.max(0, sellerPercent))) / 100);
  return { seller: sellerCents / 100, buyer: (cents - sellerCents) / 100 };
}

module.exports = { canFund, releaseDecision, splitAmounts };
