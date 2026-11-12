# Devpost submission text (copy/paste)

## Name
HoldSafe: an AI escrow agent on PayPal

## Tagline
Describe a deal in one sentence. PayPal holds the money and an AI checks the delivery before a cent moves.

## Inspiration
Paying a stranger online is a leap of faith for both people. Buyers worry the seller disappears. Freelancers worry the buyer never pays. Scammers push both sides to "just use gift cards" or "send it as friends and family." Escrow solves this, but traditional escrow is slow, manual and expensive. We wanted to see what happens when an AI agent does the escrow officer's job, with PayPal as the trusted rail that holds the money.

## What it does
- **The buyer describes the deal in plain English.** The AI drafts a contract with deliverables, objective acceptance criteria, a deadline and scam red flags.
- **The seller accepts.** The contract's SHA-256 hash goes into a tamper-evident audit ledger.
- **The buyer pays through PayPal Smart Buttons.** HoldSafe creates an Orders v2 **AUTHORIZE** order, so the money is *held*, not moved. Before the order is created, a risk engine (deterministic rules plus AI) and a policy engine can block risky payments such as off-platform requests or self-dealing.
- **The seller submits proof of delivery.** The AI checks it criterion by criterion. A prompt-injection detector catches sellers who try to talk the AI into approving.
- **The policy engine decides what happens next:**
  - **Auto-release:** PayPal captures the payment for small, clean, high-confidence deals.
  - **Buyer confirm:** the buyer reviews and releases.
  - **Human review:** used when manipulation is detected.
- **Disputes.** The AI mediator proposes a release, refund or split. When both parties accept, a split is settled with one PayPal **partial capture** (`final_capture=true`), so the remaining hold goes back to the buyer automatically.

## How we built it
- **Server:** Node.js with zero npm dependencies. A hand-written PayPal REST client (OAuth, Orders v2, Payments v2, webhook signature verification, `PayPal-Request-Id` idempotency).
- **AI:** a provider-agnostic agent (Claude, GPT or Gemini) with strict JSON schemas, validators and an automatic offline fallback.
- **State and audit:** an escrow state machine with per-deal locks, capability-token access control (HMAC-hashed, delivered in the URL fragment), and a SHA-256 hash-chained, HMAC-signed audit ledger.
- **Front end:** vanilla JS behind a strict Content-Security-Policy.
- **Tests:** 25 `node:test` tests covering the happy path, role abuse, order-id swapping, double capture, CSRF, prompt injection, policy blocks, split math and ledger tampering.

## Challenges we ran into
- **Making the AI useful without making it the weak point.** We settled on "AI recommends, deterministic policy decides."
  - The model cannot report PASS while any criterion is unmet.
  - It cannot lower the rule-based risk score by more than 15 points.
  - It can never move money directly.
- **Mapping escrow onto PayPal primitives.** AUTHORIZE, then capture or void, with a partial final capture for splits. This gave us real escrow semantics without holding funds ourselves.

## Accomplishments we're proud of
- A prompt-injection attack in the delivery proof is caught live and auto-release is disabled.
- Scam patterns get blocked *before* a PayPal order even exists.
- Judges can run the full flow with no keys at all, then add Sandbox keys for the real PayPal popup.

## What we learned
PayPal's authorization model (3-day honor period, 29-day validity, partial final capture) is a natural fit for AI-supervised escrow. Agentic payments need guardrails that live *outside* the model.

## What's next
- Multi-milestone deals
- Automatic reauthorization for long deals
- Vision-model verification of delivered images
- Seller payouts via the Payouts API
- An MCP server so other AI agents can open HoldSafe escrows on behalf of their users

## Built with
paypal-orders-api, paypal-payments-api, paypal-javascript-sdk, paypal-webhooks, node.js, javascript, anthropic-claude, openai, google-gemini, render
