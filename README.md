# HoldSafe: an AI escrow agent built on PayPal

**Pay strangers online without the leap of faith.**

HoldSafe lets two people who don't trust each other (a buyer and a freelancer, a marketplace seller, a tutor) trade safely.
The buyer describes the deal in plain English. An AI agent turns that description into a contract with checkable acceptance criteria.
**PayPal holds the buyer's money** with an Orders v2 `AUTHORIZE` order, and the AI checks the seller's delivery proof against each criterion before any money is captured.

> Built for **Build What's Next with PayPal and AI** (Devpost).
> The app has **no runtime dependencies**: `node server.js` is all it takes. If you have no PayPal or AI keys, it still runs end to end (see [Run modes](#run-modes)).

![HoldSafe home](docs/screenshot-home.png)

---

## Why this is safer than "just send the money"

| Problem with normal P2P payments | What HoldSafe does |
|---|---|
| Buyer pays, seller vanishes | Money is only **authorized** (held) on the buyer's PayPal account. If nothing is delivered by the deadline, the hold is **voided** and nothing is taken. |
| Seller delivers, buyer refuses to pay | The contract is accepted by both sides and its SHA-256 hash is recorded. When the AI confirms every criterion, small deals **auto-release** (capture) with no buyer action needed. |
| "Pay me with gift cards / F&F outside PayPal" | The AI and the rules engine flag off-platform payment requests, urgency pressure and self-dealing. Above the risk threshold the policy engine **refuses to create the PayPal order**. |
| AI agents can be manipulated | The seller's proof is wrapped in `<untrusted_…>` tags and also scanned by a deterministic **prompt-injection detector**. If it fires, automatic release is switched off and a human has to decide. The model can't report `PASS` while any criterion is unmet. |
| "He said / she said" disputes | The AI mediator proposes RELEASE / REFUND / SPLIT with reasons. Money moves only when **both** parties accept. A split is settled with a single **partial capture** (`final_capture: true`), so PayPal returns the rest of the hold to the buyer automatically. |
| No record of what happened | Every event goes into a **hash-chained, HMAC-signed audit ledger**. Editing any past entry breaks verification, and the footer shows the chain status live. |

## How it works

```mermaid
sequenceDiagram
    participant B as Buyer
    participant H as HoldSafe server
    participant AI as AI agent (Claude / GPT / Gemini)
    participant PP as PayPal (Orders v2 / Payments v2)
    participant S as Seller

    B->>H: "Logo for my bakery, PNG+SVG, 5 days, $150"
    H->>AI: draftContract (untrusted text wrapped)
    AI-->>H: deliverables, acceptance criteria, deadline, red flags
    H->>AI: assessRisk (+ deterministic rule signals)
    H-->>B: private buyer link + seller invite link
    S->>H: accept contract (hash recorded)
    B->>H: Pay
    H->>H: policy gate (limits, risk score, daily cap)
    H->>PP: POST /v2/checkout/orders intent=AUTHORIZE (PayPal-Request-Id)
    B->>PP: approve in PayPal popup (JS SDK)
    H->>PP: POST /orders/{id}/authorize
    H->>H: verify amount, currency, reference = deal (else void)
    Note over PP: funds HELD, not moved
    S->>H: delivery proof + links
    H->>H: prompt-injection scan
    H->>AI: verifyDelivery per criterion
    H->>H: policy: AUTO_RELEASE / BUYER_CONFIRM / HUMAN_REVIEW
    alt released
        H->>PP: POST /authorizations/{id}/capture
    else refunded
        H->>PP: POST /authorizations/{id}/void
    else dispute settled as a split
        H->>PP: partial capture, final_capture=true
    end
    PP-->>H: webhooks (signature verified)
```

**Deal states:** `PENDING_ACCEPTANCE → AWAITING_PAYMENT → FUNDED → IN_REVIEW → RELEASED`, plus `DISPUTED → RESOLVED`, `REFUNDED` and `CANCELLED`. The state machine in [`src/escrow.js`](src/escrow.js) rejects every transition that isn't explicitly allowed.

## Screenshots

| Prompt-injection attempt caught | AI dispute mediation |
|---|---|
| ![](docs/screenshot-injection.png) | ![](docs/screenshot-dispute.png) |

## Features

- **Natural-language contracts.** One sentence becomes deliverables, objective acceptance criteria, a deadline (capped at 28 days because PayPal authorizations last 29) and scam red flags.
- **Real escrow on PayPal.** Uses Orders v2 `AUTHORIZE`, then Payments v2 capture, void and partial capture, with the PayPal JS SDK Smart Buttons (`intent=authorize`).
- **AI risk scoring on top of deterministic rules.** The AI explains the risk and can raise the rule score, but can lower it by **at most 15 points**.
- **Per-criterion AI delivery verification**, with evidence quoted for each criterion.
- **Auto-release for small, clean deals.** Requires a PASS verdict, confidence ≥ 0.85, amount ≤ $500, low risk, no injection and buyer opt-in.
- **AI dispute mediation.** The seller can respond, the AI then revises its proposal, and both parties must accept it.
- **Tamper-evident audit ledger**, shown in the UI and verifiable at `/api/ledger/verify`.
- **Multi-provider AI.** Supports Anthropic Claude, OpenAI or Google Gemini. If a provider call fails, HoldSafe **falls back automatically** to an offline heuristic engine so the payment flow never gets stuck.

## Security design (summary)

| Layer | Control |
|---|---|
| Money | Amounts are always computed server-side from the stored deal. The authorization is checked for amount, currency and `reference_id`, and voided if anything doesn't match. The order id must belong to the deal. |
| Idempotency | A `PayPal-Request-Id` is sent on every create, authorize, capture, void and refund call. A per-deal async lock means a double click can't double-capture (there's a test for this). |
| Access | Each deal has two random 192-bit **capability tokens**. They travel in the URL *fragment* (`#t=…`), so they never reach server logs or the `Referer` header. Only an HMAC of each token is stored, and comparisons are constant-time. Role checks run on every action (for example, a seller can't release funds). |
| AI safety | Untrusted text is tagged and attempts to close the tags are neutralized. A regex injection detector runs on top of that. Every AI output is validated against a schema and clamped. The model only *recommends*; [`src/policy.js`](src/policy.js) is the only code allowed to decide that money moves. |
| Web | Strict CSP (only PayPal origins allowed), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, an Origin check against CSRF, JSON-only bodies, a 64 KB body limit, per-IP rate limits (with a tighter limit on AI endpoints), path-traversal protection, and escaping of all user text in the UI. |
| Webhooks | Checked with PayPal's `verify-webhook-signature` API, de-duplicated by event id, and logged to the ledger. |
| Audit | SHA-256 hash chain plus an HMAC signature per entry. Tampering is detected and shown in the UI. |

## Run modes

| PayPal keys | AI key | What you get |
|---|---|---|
| none | none | Full flow with **simulated PayPal** (same response shapes) and the **offline heuristic AI**. Good for a quick look. |
| sandbox | none | **Real PayPal Sandbox** popup, authorization, capture and void, with the heuristic AI. |
| sandbox | Anthropic / OpenAI / Gemini | **The full experience.** |

The header badges always show which mode is active.

## Quick start

Requires **Node.js 18.17 or newer**. Nothing needs to be installed.

```bash
git clone https://github.com/<you>/holdsafe.git
cd holdsafe
cp .env.example .env        # optional: add keys (see below)
npm start                   # or: node server.js
# open http://localhost:3000
```

Run the test suite (25 tests: happy path, security, disputes, ledger, policy):

```bash
npm test
```

### Getting PayPal Sandbox credentials (about 5 minutes)

1. Sign in at <https://developer.paypal.com>, open **Apps & Credentials**, make sure **Sandbox** is selected, and click **Create App**.
2. Copy the **Client ID** and **Secret** into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Under **Testing Tools → Sandbox Accounts**, use the auto-created *Personal* account to log in to the PayPal popup as the buyer.
4. Optional (webhooks): add a webhook pointing to `https://<public-url>/api/webhooks/paypal` for `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` and `CUSTOMER.DISPUTE.CREATED`, then put its id in `PAYPAL_WEBHOOK_ID`. Locally you can expose the server with a tunnel such as `ngrok http 3000`.

### Adding an AI key

Set one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` in `.env`. You can override the model with `ANTHROPIC_MODEL`, `OPENAI_MODEL` or `GEMINI_MODEL`.

## Try the demo flow (about 2 minutes, one browser)

1. On the home page, click the **Logo design** sample chip, then **Draft contract with AI**.
2. Click **Open seller view in new tab**, then **Accept contract**.
3. Back in the buyer tab, refresh and click **Pay with PayPal**. Funds are now *held*: look for the authorization id in the PayPal card.
4. In the seller tab, click **Sample: honest proof**, then **Submit**. The AI verifies 4/4 criteria and the funds are **auto-released** (captured).
5. Start a second deal and submit **Sample: prompt-injection attack** as the proof. The AI flags it and auto-release is disabled. As the buyer, open a dispute and look at the mediator's proposal.
6. Try the **Scammy deal** sample. The risk score goes above 75 and the policy engine **refuses to create the PayPal order**.
7. Watch the footer: the audit ledger chain is re-verified live.

## Project layout

```
server.js            HTTP server, routing, security headers, rate limits, CSRF, static files
src/paypal.js        PayPal REST client: OAuth, Orders v2 AUTHORIZE, capture/void/refund, webhook verify, mock
src/ai.js            EscrowAgent: draft / risk / verify / mediate; Claude, OpenAI, Gemini + heuristic fallback; output validators
src/risk.js          Deterministic risk signals and prompt-injection detector
src/policy.js        Funding gate, release decision, exact-cent split math
src/escrow.js        State machine, capability tokens, per-deal locks, all business actions
src/ledger.js        Hash-chained, HMAC-signed audit ledger
src/store.js         Atomic JSON file store
public/              Vanilla JS front end (no build step) with PayPal JS SDK buttons
test/                node:test suite
```

## API

All deal routes need the `X-Deal-Token: <buyer or seller token>` header.

| Method & path | Who | What |
|---|---|---|
| `POST /api/deals` | anyone | `{description, amount?, buyerEmail, sellerEmail, autoRelease?}` → AI contract + both links |
| `GET /api/deals/:id` | buyer/seller | Deal view (token hashes never returned) |
| `POST /api/deals/:id/accept` | seller | Accept contract |
| `POST /api/deals/:id/order` | buyer | Risk + policy gate → PayPal AUTHORIZE order |
| `POST /api/deals/:id/authorize` | buyer | `{orderId}` → place the hold, verify it |
| `POST /api/deals/:id/deliver` | seller | `{text, links[]}` → AI verification → policy decision |
| `POST /api/deals/:id/release` | buyer | Capture |
| `POST /api/deals/:id/refund` | seller (any time) / buyer (after deadline, no delivery) | Void |
| `POST /api/deals/:id/dispute` | buyer | `{claim}` → AI mediation |
| `POST /api/deals/:id/respond` | seller | `{response}` → AI re-mediates |
| `POST /api/deals/:id/accept-proposal` | both | Settles when both accept |
| `GET /api/deals/:id/ledger` | buyer/seller | Audit entries + chain status |
| `GET /api/ledger/verify` | anyone | Verify the whole chain |
| `POST /api/webhooks/paypal` | PayPal | Signature-verified webhooks |

## Tools used (for judges)

- **PayPal Orders v2 API**: `POST /v2/checkout/orders` (intent `AUTHORIZE`) and `POST /v2/checkout/orders/{id}/authorize`.
- **PayPal Payments v2 API**: `authorizations/{id}/capture` (full and partial with `final_capture`), `authorizations/{id}/void` and `captures/{id}/refund`.
- **PayPal JavaScript SDK** Smart Buttons with `intent=authorize`.
- **PayPal Webhooks**: `POST /v1/notifications/verify-webhook-signature`.
- **PayPal OAuth 2.0** client-credentials flow with token caching, plus `PayPal-Request-Id` idempotency.
- **AI models**: Anthropic Claude (Messages API), OpenAI (Chat Completions in JSON mode) or Google Gemini (`generateContent` with a JSON MIME type). The model is used for four agent tasks: contract drafting, risk explanation, per-criterion delivery verification and dispute mediation. Every output is schema-validated and bounded by deterministic policy.
- **Render**: `render.yaml` for one-click hosting. A `Dockerfile` is included too.

## Limitations and next steps

- PayPal authorizations have a **3-day honor period** and stay valid for **29 days**. A production version would reauthorize automatically after day 3 for long deals.
- Multi-milestone deals (one authorization per milestone), seller payouts via the Payouts API, and vision-model checks of delivered images are the natural next features.
- The JSON file store is for the demo; production would use Postgres with row-level locks.

## License

[MIT](LICENSE)
