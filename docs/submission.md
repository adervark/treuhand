# Devpost submission text

Ready to paste into the Devpost form. Every statement is true of the code and the recorded runs as of 12 Nov 2026. Before submitting, the owner fills in `[REPO URL]`, `[HOSTED URL]` (or deletes that paragraph if there is no hosted demo), `[VIDEO URL]` and `[SANDBOX PAYER LOGIN]`. If the money path in `docs/runbook.md` is run on US sandbox accounts before the deadline, update the sentences marked *(update if the runbook is run)* here and "Status and limitations" in the README.

---

## Project name

Treuhand

(The name is German: *Treuhand*, "faithful hand", is the word for holding something on someone else's behalf and handing it over only as agreed. One sentence on this can go at the top of "Inspiration" if wanted.)

## Tagline (elevator pitch)

Contracts that pay themselves: AI checks the work against tests both sides signed, abstains when unsure, signs a receipt, and PayPal pays only when every test passes.

## Video

`[VIDEO URL]` (under 3 minutes; script in `docs/video-script.md`)

---

## About the project

### Inspiration

Freelancers do the work first and get paid when the client gets round to it. Clients, for their part, do not want to pay up front for work they have not seen. The usual fix adds a person in the middle: the client clicks "release", or a marketplace arbitrates days later and takes a cut.

An AI can open a website or read a pull request, so it could be the neutral party that decides. But an AI whose answer moves money has to be accountable: it should say "I don't know" instead of guessing, show its evidence, and leave a record nobody can quietly edit afterwards. And the money should sit on rails people already use. AI agents are starting to buy and sell work for people too. Others hold money for AI agents on crypto rails; none we found does it on PayPal, where the payer approves in a window they know and the worker needs only an email address.

### What it does

Treuhand is conditional payment on ordinary PayPal rails, with an accountable AI verifier deciding the condition.

1. **Draft.** The payer describes the deal in plain English: "Pay $20 for a one-page website, due in 3 days. It must load at a public URL, work at phone width without scrolling sideways, and explain that the domain is for use in documentation examples." An AI drafter turns it into machine-checkable tests. A condition no machine can decide, such as "look professional", is refused, with a checkable rewrite where one means what the payer asked, or "No checkable version" and one click to remove it.
2. **Sign.** Payer and worker edit and sign the same tests. Any edit clears both signatures; once both sign, the terms are fixed and fingerprinted (SHA-256).
3. **Fund.** The payer approves with the PayPal button. The money is held by a PayPal authorization on the payer's own account, not charged.
4. **Verify.** The worker submits a link: a live website or a GitHub pull request. Code decides every fact it can: GitHub's API for merged after signing, checks passed and issue referenced; a headless Chromium for page loads, no sideways scrolling at 375 px, an element a visitor can see, a form that submits. The one judgement call goes to a **panel of three AI reviewers** with different briefs (a literal reader, a reader on the worker's side, a sceptic hunting for manipulation). The test passes only if all three are sure it passes, fails only if all three are sure it fails, and otherwise **abstains**: no money moves until a re-run or a person decides. Each test shows its reasoning, evidence and screenshots to both sides. While a run is in progress the page shows the verifier's work step by step (the address check, the browser, the page load, each screenshot, each reviewer's call) with timings, and each test's finished work log is part of the evidence the receipt signs.
5. **Receipt.** Every finished run gets a **receipt signed with Ed25519**: the terms fingerprint, the submitted URL, and for each test its outcome, confidence and hashes of its evidence, reasoning and screenshots. A standalone script that needs only Node's built-in crypto checks it against the app's public key, without access to the database.
6. **Settle.** When every test passes, PayPal captures the hold and pays the worker by Payout. If a test fails, the worker sees why and can resubmit. If the deadline passes first, the hold is voided and the payer is charged nothing.
7. **Disagree.** Either side can dispute. An AI mediator reads the contract, the evidence and both arguments and proposes a split. If both accept, PayPal captures, refunds the payer's share and pays out the worker's share. If either declines, a person decides.
8. **Agents.** AI agents can be the customers. An MCP server with 16 tools and per-party tokens lets a buyer's agent draft and open a contract and a worker's agent submit the work, read the verdict and check the receipt. Funding always stays with the human payer in PayPal's window, and an agent signs only if its person created its token with an explicit `--allow-sign`.

A ledger page, built with AG Grid and AG Charts, lists every money movement PayPal made.

### How we built it

One Next.js 16 app in TypeScript, with SQLite through better-sqlite3 and Tailwind CSS. Every state change goes through one state machine module, and every allowed action is derived on the server, so the interface and the agents see only what the current party may do.

- **PayPal**, all against the sandbox and all direct REST: the JS SDK v6 checkout button; Orders v2 with `intent: AUTHORIZE`; capture, void and refund through the Payments v2 API; Payouts to the worker's email; and a webhook handler that verifies signatures with PayPal and reconciles events idempotently, as a secondary confirmation that nothing depends on (not configured against a live webhook). Every money call carries a deterministic `PayPal-Request-Id`, so a retried call cannot move money twice.
- **AI**: DeepSeek's `deepseek-flash` (DeepSeek-V4.1-Flash, which accepts images) through its OpenAI-compatible API with the `openai` npm package, as drafter, reviewer panel and mediator. Every reply is JSON validated with zod and retried with the problem spelled out if it does not fit.
- **Verifier**: Playwright driving headless Chromium behind a local proxy that checks every connection the browser makes; GitHub's REST API for code bounties; receipts canonicalised as sorted-key JSON, hashed with SHA-256 and signed with Ed25519 from Node's built-in crypto.
- **Agents**: the official MCP TypeScript SDK, served statelessly over Streamable HTTP at `/api/mcp`, with a stdio relay for clients that launch a local process. Tokens are random 256-bit secrets stored only as hashes. The plain HTTP API is described in an OpenAPI 3.1 file, ready for APIMatic to generate SDKs (none generated yet).
- **Testing**: 844 Vitest tests, a browser QA pass that found 21 defects (19 fixed, one half-fixed, one cosmetic left open), and three scripts that run against the real services: an adversarial evaluation of the page judgement, an evaluation of the drafter and mediator, and a PayPal sandbox smoke test.

We built it with Claude Code agents working in parallel lanes (money, AI, verifier, contract flow, interface, agents, QA) against a written spec, with people handling the accounts, the video and the submission.

### Challenges we ran into

- **A confident model is not a calibrated one.** Our single judge reported a confidence between 0.90 and 0.99 on every one of 136 evaluation judgements, which says little about when it might be wrong, so its own confidence is a poor gate for money. We moved to a panel of differently briefed reviewers whose agreement is the confidence, following "Trust or Escalate" (arXiv 2407.18370), and made disagreement an abstention rather than a guess.
- **The submitted page is written by the person who gets paid.** Our fixture pages hide instructions in CSS, draw them on a canvas, fake the end of the data, rewrite the criterion, write in Chinese, fake their own `innerText` from page scripts, and cover real text with an opaque panel. Each needed its own defence: only text a visitor can see reaches the model, page reads run in an isolated JavaScript world, screenshots overrule extracted text, and page content sits between markers carrying a random nonce.
- **A submitted URL could point the verifier at our own network.** Redirects and WebSockets bypass Playwright's request interception, so every connection goes through a proxy that resolves the host, rejects private and metadata addresses, and connects to exactly the address it checked.
- **Our first sandbox business account was in India**, where `POST /v1/payments/payouts` returned 403 `PAYOUT_NOT_AVAILABLE`. Payouts need a US-region account. Real payouts have since succeeded from the command line, but buyer approval, authorize, capture, void and refund have not yet been run against the real sandbox; they are implemented and unit-tested with PayPal's responses mocked. *(update if the runbook is run)*
- **The PayPal Agent Toolkit cannot hold money.** It has no authorize, no capture of an authorization, no void and no Payouts, and its `create_order` is fixed to intent `CAPTURE`, so every PayPal call is direct REST, and our own MCP server is what agents use.
- **JS SDK v6 has no documented authorize example.** v6 has no client-side intent, so the server creates the order with `intent: AUTHORIZE` and authorizes it after approval.
- **Sandbox authorizations never expire**, and real ones last 29 days with a 3-day honour period, so deadlines are enforced by our own sweep, which voids the hold.
- **Payouts are asynchronous.** An accepted batch is not money in the worker's account, so a contract is marked paid only when PayPal reports the payout item `SUCCESS`, and a returned payout is retried under a new key, never duplicated.
- **Agents must not be able to spend people's money.** No token scope can fund, whatever it is granted; the funding tool tells the agent what to ask its person to do and where.

### Accomplishments that we're proud of

- An AI verifier that is accountable: it abstains instead of guessing, shows its evidence, and signs a receipt that a third party can check with a short script and Node's crypto alone.
- The reviewer panel, against the real model on 17 cases, 12 of them adversarial: 17 of 17 correct in each of two runs, none inconclusive, and no attacked page passed; the one attacked page that genuinely met the criterion still passed. The single judge it replaced scored 51 of 51 across three runs and 17 of 17 in a fourth.
- The drafter and mediator passed 21 of 21 real-model cases, including mediation cases with injected instructions from the worker, from the payer and inside page evidence.
- Two AI agents completed a contract end to end through MCP, one over HTTP and one over stdio, with the real drafter and verifier, and the buyer's agent checked the receipt; the payer's PayPal approval stayed a human step.
- Facts are decided by code; the model judges only the one thing code cannot.
- 844 automated tests, a single state machine, and money steps that record each PayPal result, resume from the step that failed, and never send a second payout while the first is pending.

### What we learned

- When an AI's answer moves money, "I don't know" is a feature. Agreement between differently briefed reviewers is a better signal than a model's stated confidence, and an abstention costs a re-run, not a payment.
- A signed receipt proves that the record was not changed after it was signed, not that the verifier was honest. Saying exactly which of those it proves matters.
- A screenshot is harder to fake than the DOM. A page's own scripts can feed false text to other scripts, but the screenshot shows what a visitor sees.
- PayPal's details matter for holding money: authorizations are valid for 29 days with a 3-day honour period; sandbox authorizations never expire; capturing an `AUTHORIZE` order goes through the authorization, not the order; Payouts use `currency` where Orders use `currency_code`.
- PayPal's Acceptable Use Policy lists escrow services among activities that need pre-approval, so we describe and build Treuhand as conditional payment held by an ordinary authorization, and a live launch would start with asking PayPal.
- Telling people plainly what the AI interpreted ("'works on phones' is checked as no sideways scrolling at 375 px") does more for trust than a confident answer.

### What's next for Treuhand

- Run the full money path on US sandbox accounts (`docs/runbook.md`): approve, authorize, capture, payout, void, refund, and a live webhook.
- Ask PayPal how a service like this is classified under its Acceptable Use Policy before any live launch.
- Reviewers from different models, so the panel's members do not share one model's blind spots.
- Resist cloaking, where a worker's server shows the verifier a different page from the one people see: check from more than one network and browser profile, and re-check at payout time.
- Publish receipt hashes to an append-only log, so an operator cannot quietly re-sign history.
- Generate SDKs and a docs portal from the OpenAPI file with APIMatic; real accounts in place of the two demo identities; a review tool for the person who decides escalated disputes; reauthorization for contracts longer than 29 days.

---

## Built with

next.js, react, typescript, tailwind-css, sqlite, better-sqlite3, playwright, chromium, deepseek, openai-node, zod, model-context-protocol, ag-grid, ag-charts, paypal-js-sdk-v6, paypal-orders-api, paypal-payments-api, paypal-payouts-api, paypal-webhooks, node-crypto, ed25519, openapi, vitest, claude-code

---

## PayPal and AI tools used (required statement)

**PayPal.** Treuhand uses PayPal for checkout, authorize, capture, void, payouts, refunds and webhooks, all against the sandbox, through direct REST calls with an idempotency key on every money movement. The **JavaScript SDK v6** renders the Fund button and runs the payer's approval. The **Orders v2 API** creates each contract's order with `intent: AUTHORIZE` for exactly the agreed amount and authorizes it after approval, so the payer's money is held, not charged. The **Payments v2 API** captures that authorization when every test passes or a split is agreed, voids it when the deadline passes without a pass, and refunds the payer's share of an agreed split. The **Payouts API** sends the worker's money to their email address, and the contract is marked paid only when PayPal reports the payout item `SUCCESS`. A **webhook** handler verifies each event with PayPal's verify-webhook-signature API and reconciles it idempotently, as a secondary confirmation only; no webhook has been configured or received. Treuhand does not use the PayPal Agent Toolkit, because it cannot authorize, capture an authorization, void or pay out. Run against the real sandbox: token, order creation (read back as `AUTHORIZE` with the right amount), the v6 button opening PayPal's checkout window, and payouts from the command line. Implemented and unit-tested but not yet run against the real sandbox: buyer approval, authorize, capture, void and refund. *(update if the runbook is run)*

**AI.** One model, DeepSeek `deepseek-flash` (DeepSeek-V4.1-Flash, text and images), called through DeepSeek's OpenAI-compatible API with the `openai` npm package, plays three roles. The **drafter** turns a plain-English deal into machine-checkable tests, or refuses vague conditions with a checkable rewrite. The **reviewer panel** of three differently briefed reviewers answers one agreed criterion about a submitted web page from its screenshots and visible text, treating the page as untrusted data; the check passes or fails only if all three agree with confidence of at least 0.8, and otherwise abstains. Together with checks decided by code (GitHub's API and a Playwright-driven Chromium), its verdict decides whether PayPal pays, and every run is recorded in an Ed25519-signed receipt. The **mediator** reads the contract, the evidence and both parties' arguments in a dispute and proposes a split, which PayPal settles once both accept. Every reply is JSON validated with zod. AI agents use Treuhand through its own MCP server (official MCP TypeScript SDK).

---

## Testing instructions for judges

**Code:** `[REPO URL]`. "Quick start" in the README runs it locally (Node.js 22.13+, pnpm, a DeepSeek API key, and a PayPal sandbox app on a US business account).

**Hosted demo:** `[HOSTED URL]` (delete this paragraph if there is none). There is no sign-up: use the "Viewing as Payer / Worker" switch at the top right to act as either side. Every window of one browser acts as the same side, so use the switch in one window, or two browser profiles. To fund a contract, log in to the PayPal window with the sandbox payer: `[SANDBOX PAYER LOGIN]`. This is a PayPal sandbox account; no real money moves. Everyone using the demo shares the same two identities and sees the same contracts.

**A five-minute script** (also in the README, with expected results):

1. As **Payer**, paste: `Pay $20 for a one-page website, due in 3 days. It must load at a public URL, work at phone width (375px) without scrolling sideways, and explain that the domain is for use in documentation examples.` Press **Draft the contract**, then **Create the contract**, then **Sign as payer**.
2. Switch to **Worker** and press **Sign as worker**.
3. Switch to **Payer** and fund it with the PayPal button, logging in as the sandbox payer.
4. Switch to **Worker** and submit `https://info.cern.ch/`. Expect `FAILED`: no mobile viewport, and nothing about documentation examples, each with its reasoning.
5. Resubmit `https://example.com/`. Expect every test to pass, then capture and payout, and `PAID` once PayPal confirms the payout. The Ledger page shows each movement, and the contract's Receipt panel shows the signed receipt and the command that checks it.

Steps 1, 2, 4 and 5 up to `PASSED` were run on 12 Nov 2026 with the hold faked by a test-only script. Step 3 and the capture and payout in step 5 are the PayPal steps not yet run against the real sandbox. *(update if the runbook is run)*

To see the drafter refuse a vague condition, add "It must also look professional." to the deal in step 1 and draft it again: it is refused as "No checkable version", because taste cannot be checked, and one click removes it from the deal.

To see agents use it, follow `docs/agents.md`: create a token with `pnpm agent:token create --role worker`, connect any MCP client to `/api/mcp`, or run `scripts/agent-demo.ts` against a scratch database.

---

## Prize categories

A project can win at most one main prize (a grand prize or one honourable mention) plus one sponsor prize.

- **Best Use of PayPal + AI (strongest fit).** The AI's verdict is what moves the money: a unanimous pass captures the authorization and sends a Payout, an agreed mediator split captures, refunds and pays out, an expired deadline voids the hold, and a split panel moves nothing. Checkout, authorize, capture, void, payouts and refunds, each used for what it is for.
- **Best Use of Agentic Commerce.** Buyer and worker agents run contracts through an MCP server with per-party tokens and scopes; agents can draft, sign (only when delegated), submit, dispute and check receipts, while funding always stays a human approval in PayPal's window.
- **Most Impactful.** Late payment and non-payment of freelancers, with a payee who needs only an email address and an AI decision that comes with evidence and a checkable receipt.
- **Best Use of AG Grid (sponsor prize).** The ledger page (`src/components/ledger/ledger-view.tsx`) uses AG Grid Community for every PayPal money movement: grouped amount columns (into hold, captured, paid out, returned), a pinned totals row that sums only the rows left after filtering, quick search, date, text and number column filters, movement-type toggles wired in as an external filter, custom cell renderers, rows that flash when new movements arrive on its 5-second refresh, pagination, and CSV export with formula-like text escaped; AG Charts Community draws money over time beside it.
