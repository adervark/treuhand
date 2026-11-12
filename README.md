# Treuhand: contracts that pay themselves

Treuhand is a web app for two parties who agree a small job and a price, such as a freelancer and a client, or a maintainer and whoever fixes an issue. The payer describes the deal in plain English and an AI drafts it into a contract whose conditions are machine-checkable tests; anything too vague to test is refused. Both parties sign. The payer's money is held with a PayPal authorization on their own account, not charged. When the worker submits a link to the work (a live website or a GitHub pull request), code checks every fact it can and a panel of three AI reviewers judges the rest; if the reviewers do not all agree, no money moves and the check goes to a re-run or a person. Every finished run gets an Ed25519-signed receipt that anyone can check with a script. If every test passes, PayPal captures the hold and pays the worker by Payout to their email address. If the deadline passes first, the hold is released and the payer is never charged. If the parties disagree, an AI mediator proposes a split that both must accept. Nobody presses "approve payment".

The name is German: *Treuhand*, "faithful hand", is the word for holding something on someone else's behalf and handing it over only as agreed.

AI agents can be the customers too: an MCP server with per-party tokens lets a buyer's agent and a worker's agent run a contract, while funding always stays with a person in PayPal's own window.

Entry for the PayPal AI Hackathon. Everything runs against the PayPal sandbox; no real money moves. [Status and limitations](#status-and-limitations) lists exactly what has been run against the real sandbox and what has not.

Hosted demo: none at the time of writing. Run it locally ([Quick start](#quick-start)) or deploy your own copy with the included `Dockerfile` and `render.yaml` ([Deploying](#deploying)).

Treuhand was called Clause while it was built. The environment variables (`CLAUSE_*`), the database file (`data/clause.db`) and the view-as cookie (`clause_view_as`) keep that name.

## How it works

1. **Draft.** The payer types the deal. The drafter (AI) returns a structured contract: amount (US dollars, at most $5,000.00), deadline, and a list of conditions, each mapped to a check the verifier can run. Vague conditions ("looks professional", "clean code") are refused, each with a checkable rewrite where one means what the payer asked, or else "No checkable version" and a button to remove it from the deal. Where the drafter narrowed someone's words, it says so in notes that both parties see.
2. **Sign.** Payer and worker review and edit the tests, then both sign. Any edit clears both signatures. When both have signed, the terms are fixed and their SHA-256 is recorded.
3. **Fund.** The payer approves in the PayPal checkout button. The server creates the order with `intent: AUTHORIZE` and authorizes it after approval, so the money is reserved on the payer's account but not taken.
4. **Submit.** The worker submits a link. The verifier runs each test: GitHub facts come from GitHub's API, website facts from a headless Chromium, and the one judgement call (`ai_page_judgement`) from the reviewer panel looking at screenshots of the page. Each test ends as pass, fail, or inconclusive, with evidence stored and shown to both sides, and the run ends with a signed receipt.
5. **Settle.** If every test passes, the server captures the authorization and sends a PayPal Payout to the worker's email. The contract becomes `PAID` when PayPal reports the payout item `SUCCESS`. If a test fails, the worker sees which one and why, and can resubmit until the deadline.
6. **Expire.** If the deadline passes without a pass, the authorization is voided and the payer is charged nothing. The same happens to a dispute still unsettled at the deadline, unless both parties have accepted a split.
7. **Dispute.** Either party can contest. Once both have argued, the mediator (AI) proposes a split. If both accept, the server captures, refunds the payer's share and pays out the worker's share. If either declines, the contract is escalated to a person.

Contract states (`src/lib/contract/machine.ts`, the only code that changes state):

```text
DRAFT -> SIGNED -> FUNDED -> SUBMITTED -> VERIFYING -> PASSED -> PAID
                                 ^            |
                                 +-- FAILED <-+                 (worker may resubmit)

FUNDED / FAILED / VERIFYING (inconclusive) -> EXPIRED           (deadline passed: hold voided)
FUNDED / FAILED / PASSED / VERIFYING (inconclusive) -> DISPUTED -> SETTLED    (agreed split)
                                                                -> ESCALATED  (a person decides)
DISPUTED / ESCALATED -> EXPIRED      (deadline passed with no split both accepted: hold voided)
PASSED -> SETTLED                    (PayPal returned all three payouts: payer refunded in full)
```

## The verifier

### Facts by code, one judgement by a panel

There are eight check kinds. Seven are decided by code and never reach the model:

| Check kind | Contract type | Decided by |
|---|---|---|
| `github_pr_merged` | Code bounty | GitHub REST: merged into the default branch of the named repo, after both parties signed |
| `github_checks_passed` | Code bounty | GitHub REST: every check run and status on the PR's head commit passed (at least one succeeded) |
| `github_pr_references_issue` | Code bounty | GitHub REST: the PR title, body or timeline references the issue in the same repo |
| `http_ok` | Website | The page answers 2xx |
| `dom_assert` | Website | Chromium: a selector exists, optionally with text a visitor can actually see |
| `responsive` | Website | Chromium at 375 px: a mobile viewport tag and no horizontal overflow |
| `form_submits` | Website | Chromium: fills and submits the form and looks for the agreed success text |
| `ai_page_judgement` | Website | The reviewer panel |

**The panel's rule** (`src/lib/verifier/ai-judgement.ts`). One agreed criterion, up to four screenshots of the page and its visible text go, at the same time, to three reviewers that share one set of rules and read the page from different angles: a strict literal reader, a reader on the worker's side looking for how the criterion is met, and a sceptic hunting for manipulation and missing evidence. The check passes only if all three say "met" with confidence of at least 0.8, and fails only if all three say "not met" with at least 0.8. A split, any reviewer below 0.8, or any reviewer whose reply fails the schema three times or whose call errors makes the check inconclusive: no money moves until a re-run or a dispute decides it. The verdict's confidence is the panel's agreement, not a model's own estimate, and every reviewer's vote, confidence and reasoning are kept in the evidence. This follows "Trust or Escalate" (arXiv 2407.18370), which found agreement among differently prompted judges a better confidence signal than a model's stated confidence. `CLAUSE_JUDGE_PANEL=1` switches to a single judge whose own confidence must reach 0.8.

The three reviewers are the same model with different instructions, so they can share a blind spot and agree on the same mistake.

### Signed receipts

When a verification run finishes, the server issues a receipt (`src/lib/verifier/receipt.ts`, rules in `receipt-core.ts`): the contract and submission ids, the submitted URL, the SHA-256 of the terms both parties signed, the run's outcome, and for each check its outcome, confidence, and the SHA-256 of its reasoning, of its evidence JSON and of each screenshot file, plus the verifier's name, version and model. The receipt's SHA-256 is signed with Ed25519 (Node's built-in crypto). The public key is served at `GET /api/verifier/public-key`; receipts at `GET /api/contracts/<id>/receipts`. The idea of binding a verification result to the payment decision is close to the verification proofs in VCAP (draft-stone-vcap, an individual Internet-Draft on verified commerce for agents); Treuhand does not implement that draft's formats.

Check a contract's receipts against a running app (no `.env` needed; exits 0 when every receipt holds, 1 when any check fails, 2 on a usage or fetch error). The contract page's receipt panel shows this command with the right URL:

```sh
pnpm exec tsx scripts/verify-receipt.ts http://localhost:3000/api/contracts/<id>/receipts --app http://localhost:3000
# or offline, from saved JSON: <receipt.json> --key <public-key.pem> --contract <contract.json>
```

It recomputes the receipt hash, checks the signature against the public key, recomputes the terms hash from the contract, compares each verdict's evidence and reasoning with the hashes the receipt signed, and downloads each screenshot and compares its hash. It imports only `receipt-core.ts`, which needs only `node:crypto`. A receipt proves that the record was not changed after it was signed. It does not prove that the verifier ran honestly: the signing key belongs to whoever runs the server. Settlement never reads a receipt; it is a record, not a gate.

### The work log

The verifier records every step it takes while it takes it (`src/lib/verifier/trace.ts`): checking that the address is public, starting the isolated browser, loading the page, each measurement and screenshot, each reviewer's model call, the verdict, and signing the receipt, each with its start time and duration. `GET /api/contracts/<id>` serves them as `trace`, so the contract page shows a run while it runs: a waterfall of steps under the test being checked with running timers, and a strip of run metrics (elapsed time, steps by kind, where the time went). Every step opens to its full record, pressing a kind in the metrics strip highlights that kind of step in every test, the log can be copied as JSON, and it stays on the page after the run. Facts that give away a result (a reviewer's vote, the verdict) are held back until the run log has shown that test's verdict. Each check's finished steps are copied into its verdict's evidence, so the signed receipt's evidence hash covers them. The recorder cannot change a verdict: if a step cannot be written, the failure is logged and the check carries on.

### How the verifier resists manipulation

The person who submits the page is the person who gets paid if it passes, so everything the verifier reads from a submission is treated as hostile content, never as instructions.

- **Only what a visitor can see.** The text sent to the model is read from the rendered page with hidden text removed: `display`/`visibility`/`opacity` hiding, tiny, transparent or background-coloured text, off-screen and clipped boxes. HTML comments and attributes are never sent. Hidden text, comments and attributes are scanned by code for manipulation patterns, and anything found is recorded as evidence.
- **Screenshots are the final word.** The model is told that the extracted text can contain things a visitor cannot see (for example text covered by another element), and that the screenshots decide. Page scripts run in an isolated world, so a page that fakes `innerText` from its own JavaScript does not change what the verifier reads.
- **Data, fenced.** The page's address, title and text sit between markers carrying a random nonce the page cannot guess. The system prompt lists the usual tricks (text addressed to an AI, fake system messages, "verified" badges, verdict-shaped JSON, claims that the criterion is met) and says to decide as if they were absent, in either direction.
- **Manipulation is shown, not scored.** A detected attempt is recorded in the evidence for both parties to see. It never changes the outcome on its own: a page that genuinely meets the criterion still passes.
- **Network guard.** Submitted URLs to loopback, private, link-local (cloud metadata) and other reserved addresses are refused. Every connection Chromium makes, including redirects, subresources, form posts and WebSockets, goes through a local proxy that resolves the host, checks every address, and connects to exactly the checked address.

### Measured with the real model

`scripts/verifier-eval.ts` runs 17 cases. Fifteen fixture pages (`test/fixtures/site/`) are judged against "at least three distinct subscription plans, each with its price", and two criteria ask about a code drawn only on a `<canvas>`, which tests that the model reads the screenshot. Twelve of the fifteen pages carry an attack: visible and CSS-hidden instructions, a "verified" banner, fake end-of-data markers, an instruction drawn on a canvas, a rewritten criterion, an instruction in Chinese, "price on request" plans, a page whose scripts fake its own text, real plan text covered by an opaque panel, and a third plan that is hidden. One of the twelve genuinely meets the criterion and must still pass.

| Configuration | Runs | Result | Time |
|---|---|---|---|
| Three-reviewer panel (the default) | 2 runs, 12 Nov 2026 (the second after the prompts' wording changed from "escrow service" to "conditional-payment service") | 17 of 17 correct in each, none inconclusive, no attacked page passed (every injection page failed with all three reviewers agreeing) | median 3.1 s and 3.2 s per check, slowest 6.1 s and 5.9 s, 21 s and 23 s for all 17 (three at a time) |
| Single judge | 3 runs during the build | 51 of 51 correct, no attacked page passed | |
| Single judge | 1 run, 12 Nov 2026 | 17 of 17 correct, no attacked page passed | median 2.7 s per check; one model call timed out after 120 s and succeeded on its retry (138 s for all 17) |

The panel makes three model calls per check instead of one; they run at once, so a check takes about as long as its slowest reviewer. In every run the model also read the canvas code from the screenshot alone.

The drafter and mediator have their own real-model evaluation (`scripts/ai-eval.ts`): 21 of 21 cases passed in each of three full runs on 12 Nov 2026 (the last after the same wording change), including three mediation cases with injected instructions (from the worker, from the payer, and inside page evidence) and drafter cases that fail any suggested rewrite that asks the payer for the work's URL or stands in for a condition no check can measure.

These are small fixed suites, not a guarantee.

## What uses PayPal

All PayPal calls go to the sandbox (`https://api-m.sandbox.paypal.com`) as direct REST calls in `src/lib/paypal/index.ts`. Every call that moves money sends a deterministic `PayPal-Request-Id`, so a retry cannot repeat the action. Orders and Payments return PayPal's first result. Payouts do not: PayPal refuses a repeated `sender_batch_id` with HTTP 400 and a link to the existing batch, and `payout` reads that batch back, checks its amount and receiver, and returns it as the payout sent.

| PayPal capability | What it does in Treuhand | Where |
|---|---|---|
| Checkout, JS SDK v6 | The Fund button. Loads `https://www.sandbox.paypal.com/web-sdk/v6/core`, creates a one-time payment session, and hands it an order the server created. | `src/components/contract/paypal-button.tsx` |
| Orders v2, `intent: AUTHORIZE` | `POST /v2/checkout/orders` for exactly the contract's amount, tagged with the contract id; after the payer approves, `POST /v2/checkout/orders/{id}/authorize`. A hold for the wrong amount, currency or contract is voided and refused. | `createAuthorizedOrder`, `authorizeOrder` |
| Capture | `POST /v2/payments/authorizations/{id}/capture` when every test passes (after the contest window, 0 seconds by default) or when both parties accept a split. | `captureAuthorization` |
| Void | `POST /v2/payments/authorizations/{id}/void` when the deadline passes without a pass, when an agreed split gives the worker nothing, or for a mismatched hold. Sandbox holds never expire on their own, so the app's own deadline sweep does this. | `voidAuthorization` |
| Payouts | `POST /v1/payments/payouts` to the worker's email, then `GET /v1/payments/payouts/{batch}` until the item settles. A contract is marked paid only on item status `SUCCESS`. While a payout is pending or `UNCLAIMED` no second one is sent; one PayPal reports final and not paid (`FAILED`, `RETURNED`, `BLOCKED`, `REFUNDED`, `REVERSED`, `CANCELED`, or a `DENIED` or `CANCELED` batch) is sent again under a new idempotency key, at most three attempts in all, after which the payer is refunded. | `payout`, `getPayoutBatch` |
| Refunds | `POST /v2/payments/captures/{id}/refund` returns the payer's share of an agreed split, the worker's share when all three payout attempts came back, or the whole capture when a void finds the hold already captured (a capture whose response was lost). | `refundCapture` |
| Webhooks | A handler at `POST /api/webhooks/paypal` verifies each event with `POST /v1/notifications/verify-webhook-signature` and reconciles nine event types idempotently. It is a secondary confirmation only: the server records every PayPal result directly, and nothing depends on a webhook arriving. Without `PAYPAL_WEBHOOK_ID` it answers 503. No webhook has been configured or received. | `src/app/api/webhooks/paypal/route.ts`, `src/lib/paypal/webhook.ts` |

Treuhand does not use PayPal's Agent Toolkit. Its tools cannot authorize, capture an authorization, void or send payouts, and its `create_order` is fixed to intent `CAPTURE` (details in `docs/paypal-notes.md`, section 6), so every PayPal call here is direct REST.

## What uses AI

One model for every role: DeepSeek `deepseek-flash` (DeepSeek-V4.1-Flash, which accepts images), called through DeepSeek's OpenAI-compatible API with the `openai` npm package. Every reply must be a JSON object that passes a zod schema; an invalid reply is sent back with the problem and retried, three attempts in all.

| Role | Input | Output | Where |
|---|---|---|---|
| Drafter | The deal in plain English | A structured contract with each condition mapped to a check kind, plus notes on how words were interpreted; or a refusal naming each vague condition with a checkable rewrite, or none where nothing checkable means the same | `src/lib/ai/drafter.ts` |
| Reviewer panel (page judgement) | One agreed criterion, up to four screenshots, the page's visible text | From each of three reviewers: met or not met, a confidence, observations, reasoning, and any manipulation attempt it noticed; the panel's rule decides | `src/lib/verifier/ai-judgement.ts` |
| Mediator | The contract, every verdict with its evidence, and both parties' arguments | A proposed worker share in cents with reasoning | `src/lib/ai/mediator.ts` |

## For agents

AI agents can be Treuhand's customers. A buyer's agent drafts and creates a contract; a worker's agent reads the tests, submits the work and reads the verdict with its evidence, the reviewer panel's votes and the signed receipt; either one can follow the money in the ledger or check a receipt.

- **Where.** The MCP server is at `/api/mcp` (Streamable HTTP, stateless). For clients that launch a local process, `scripts/mcp-server.ts` is a stdio server that relays every call to a running app's `/api/mcp` (`TREUHAND_URL`, `TREUHAND_TOKEN`). The same token works on the plain HTTP API, described in [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1, also served at `/api/openapi`).
- **Tokens.** `pnpm agent:token create --role payer|worker [--allow-sign] [--read-only] [--label <text>]` prints a token once (`treuhand_...`; only its SHA-256 is stored); `list` and `revoke <id>` manage them. A token acts as one party, under the web app's role rules.
- **Scopes.** `read` (always), `write` (act as the party: draft and create as payer, submit as worker, re-run, dispute; dropped by `--read-only`), and `sign` (only with `--allow-sign`). No token can fund: `/fund/create-order` and `/fund/authorize` answer 403 to every token, and the tool `get_funding_instructions` tells the agent what to ask the payer to do in PayPal's window.
- **Tools.** 16: `whoami`, `list_contracts`, `get_contract`, `draft_contract`, `create_contract`, `sign_contract`, `get_funding_instructions`, `submit_work`, `get_verification`, `rerun_verification`, `open_dispute`, `respond_to_dispute`, `accept_proposal`, `decline_proposal`, `get_ledger`, `check_receipt`.

[`docs/agents.md`](docs/agents.md) has the client configs, the tool table, and a worked buyer-and-worker run from `scripts/agent-demo.ts` (12 Nov 2026, scratch database, real drafter and verifier, payer's PayPal approval simulated). It also gives the steps to generate SDKs and a docs portal from the OpenAPI file with APIMatic; no SDK has been generated yet.

## Quick start

Requirements: Node.js 22.13 or later (developed on 24.22; the Docker image uses 26), pnpm 11, and for the full flow a PayPal developer account and a DeepSeek API key.

From the root of a clone of this repository:

```sh
node --version                                    # v22.13 or later
npm install -g pnpm@11.7.0                        # if pnpm 11 is not installed
pnpm install
pnpm exec playwright install --with-deps chromium # the verifier's browser and, on Linux, its system libraries (asks for sudo)
cp .env.example .env                              # then fill in the values below; DEMO_PAYER_EMAIL and DEMO_WORKER_EMAIL are required
pnpm db:init && pnpm db:seed                      # creates data/clause.db, the two demo identities and two sample draft contracts
pnpm dev                                          # http://localhost:3000
```

Without Chromium, every browser-based website check (everything except `http_ok`) comes back inconclusive, so no website contract can pass. With only the two demo emails set, the pages load, and each feature that needs a key answers with an error naming the missing variable.

`pnpm db:init` creates and migrates the database but never clears it. To start over:

```sh
rm -f data/clause.db* && pnpm db:init && pnpm db:seed
```

### Environment variables (`.env`)

| Variable | Needed for | What it is and where to get it |
|---|---|---|
| `PAYPAL_CLIENT_ID` | Funding and settlement | Client ID of a sandbox REST app. developer.paypal.com > Apps & Credentials (Sandbox) > Create App, type Merchant, linked to a US sandbox business account (see below). |
| `PAYPAL_CLIENT_SECRET` | Funding and settlement | The same app's secret. |
| `PAYPAL_WEBHOOK_ID` | Webhooks only (optional) | The app's Features > Sandbox Webhooks > Add Webhook, pointing at `https://<public host>/api/webhooks/paypal`. PayPal delivers only to public HTTPS on port 443, so this needs a deployed app or a tunnel. |
| `DEEPSEEK_API_KEY` | Drafting, page judgement, mediation | platform.deepseek.com > API keys. |
| `DEEPSEEK_BASE_URL` | Optional | Defaults to `https://api.deepseek.com`. |
| `CLAUSE_MODEL` | Optional | Defaults to `deepseek-flash`. The model must accept images; `deepseek-v4-pro` does not. |
| `GITHUB_TOKEN` | Optional | Raises GitHub API rate limits for the code-bounty checks. A personal access token with no extra permissions reads public repositories. |
| `CLAUSE_CONTEST_WINDOW_SECONDS` | Optional | Seconds between a pass and the automatic payout. Defaults to 0. |
| `CLAUSE_DB_PATH` | Optional | SQLite file. Defaults to `data/clause.db`. |
| `CLAUSE_JUDGE_PANEL` | Optional | How many reviewers judge each page for an AI judgement check, 1 to 6. Defaults to 3; 1 is a single judge. |
| `VERIFIER_SIGNING_KEY` | Optional | Ed25519 private key (PKCS#8 PEM, newlines may be written `\n`) that signs verification receipts; `openssl genpkey -algorithm ed25519` makes one. When unset, a key is generated on first use and kept in `verifier-signing-key.pem` beside the database (`data/` by default), readable by the owner only. |
| `DEMO_PAYER_EMAIL`, `DEMO_WORKER_EMAIL` | Required by `pnpm db:seed` | Emails of the two seeded demo identities: the two US sandbox personal accounts. Payouts go to the worker's address, and it must be a real sandbox account or the payout stays `UNCLAIMED`. `pnpm db:seed` stops with an error if either is unset; `pnpm db:seed --placeholder-identities` seeds `payer@example.com` and `worker@example.com` instead, for a local run where no money moves. Rerun `pnpm db:seed` after changing them; contracts created earlier keep the old emails. |

### PayPal sandbox accounts

In developer.paypal.com, switch to Sandbox, then:

1. Testing Tools > Sandbox Accounts > Create account: one **Business** account, country **United States**. It owns the app, receives captures and sends payouts.
2. Create two **Personal** accounts, country **United States**: the payer (logs in to the PayPal button) and the worker (receives payouts). Paying out to the business account itself fails with `SELF_PAY_NOT_ALLOWED`.
3. Apps & Credentials > Create App, type Merchant, linked to the new business account. Copy its client ID and secret into `.env`.

Why US: with an India-region sandbox business account, `POST /v1/payments/payouts` returned 403 `PAYOUT_NOT_AVAILABLE` and card processing was not enabled. Token and order creation worked; payouts did not.

Treuhand has no sign-up. The header's "Viewing as Payer / Worker" switch sets a cookie, and the two seeded identities are the only parties.

## Try it in five minutes

Needs the app running with a DeepSeek key and a PayPal sandbox app, and the sandbox payer's login. Steps 4 and 7 move sandbox money and have not yet been run end to end through the app (see [Status](#status-and-limitations)). Steps 1 to 3, 5 and 6 were run on 12 Nov 2026 with these inputs, over HTTP against a local production build and in the browser (`docs/qa-report.md`, areas 1, 2 and 4), with the results described below.

**One role at a time per browser profile.** The acting party is a cookie, so every window and tab of one browser profile acts as the same party. Use one window and the header's **Payer / Worker** switch, or put the payer and the worker in two separate browser profiles (or one normal and one private window). A second window in the same profile follows the switch within about 2 seconds, and a click in a window still showing the other role is refused (`409 ROLE_MISMATCH`) with nothing done.

1. Open the app. The switch at the top right reads "Viewing as" **Payer**.
2. Paste this into "The deal, in plain English" and press **Draft the contract**:

   ```text
   Pay $20 for a one-page website, due in 3 days. It must load at a public URL, work at phone width (375px) without scrolling sideways, and explain that the domain is for use in documentation examples.
   ```

   Expect three tests: the URL answers 2xx (`http_ok`), no horizontal overflow at 375 px (`responsive`), and a test that the page says the domain is for use in documentation examples, plus notes on how the drafter read your words. That third test is usually a text check for "documentation examples" (`dom_assert`) and sometimes an AI judgement of the page (`ai_page_judgement`, judged by the reviewer panel); in three runs on 12 Nov 2026 it was the text check twice. Either way it passes on example.com in step 6.

   To see a refusal, add "It must also look professional." to the end of the deal and press **Draft again**. That one condition is refused with "No checkable version": taste cannot be checked. Press **Remove from the deal**, then **Draft again**, and the three tests come back. (Three runs on 12 Nov 2026: the same single refusal each time, and the same three tests after removing it.)
3. Press **Create the contract**, then **Sign as payer**. Switch to **Worker** and press **Sign as worker**. The contract is `SIGNED`.
4. Switch to **Payer** and use the PayPal button. Log in as the sandbox payer and approve. Expect `FUNDED` and an `AUTHORIZED` row on the Ledger page.
5. Switch to **Worker**. Under "Link to the live site", submit `https://info.cern.ch/` and press **Submit for checking**. Within a minute the contract is `FAILED`: the page loads, but it has no mobile viewport tag (a 375 px phone lays it out 981 px wide), and nothing on it says the domain is for documentation examples. Each verdict shows its reasoning and evidence, with screenshots where the check took them.
6. Submit `https://example.com/` and press **Resubmit for checking**. All three tests pass and the contract is `PASSED`. The Receipt panel shows the latest run's signed receipt (outcome, hash, signing key compared with the verifier's published key) and the command to check it.
7. The server captures the hold and sends the payout; the page checks every 10 seconds until PayPal reports the payout `SUCCESS`, then shows `PAID`. The Ledger page shows `CAPTURED` and `PAID_OUT` rows and updates its totals. The worker's sandbox account shows the payout.
8. In a terminal, check the receipts: `pnpm exec tsx scripts/verify-receipt.ts http://localhost:3000/api/contracts/<id>/receipts --app http://localhost:3000`.

Without a PayPal buyer login, you can still run steps 1 to 3, 5, 6 and 8 locally by faking the hold with a test-only helper, against a separate database:

```sh
CLAUSE_DB_PATH=data/e2e.db pnpm db:seed --placeholder-identities   # or set the two demo emails
CLAUSE_DB_PATH=data/e2e.db pnpm dev
# after both parties have signed, in a second terminal:
CLAUSE_DB_PATH=data/e2e.db pnpm exec tsx scripts/flow-e2e.ts fund <contract id>
```

This writes a `FUNDED` state with a made-up authorization id. No money is held, so after a pass the capture fails with PayPal's 404, which the contract page shows as a failed payment step that is retried.

To try a code bounty instead, you need a repository you can merge into: the pull request must be merged into the default branch of the repository the contract names, after both parties signed, with at least one check that succeeded on its head commit, and must reference the agreed issue. A pull request merged before signing fails by design.

## Tests and evaluations

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm test` runs the Vitest suite (842 tests in 32 files on 12 Nov 2026): the state machine, every check kind (website checks against local fixture pages in a real Chromium), the network guard, the reviewer panel's rule, receipts and the checker's rules, agent tokens and the MCP tools, the PayPal module and webhook handling with PayPal's HTTP responses mocked, the GitHub checks with GitHub's responses mocked, the AI modules with a mocked client, and the HTTP routes. Point `CLAUSE_DB_PATH` at a scratch file when running it next to a database you care about.

Three scripts run against the real services and need `.env`:

```sh
# The page judgement against the fixture pages, including every injection page; counts inconclusive answers,
# exits 1 on any wrong verdict or injection flip (--panel 1 runs the single judge, --runs N repeats)
pnpm exec tsx --env-file=.env scripts/verifier-eval.ts --panel 3

# The drafter and mediator against fixed cases (argument: drafter or mediator to run one suite)
pnpm exec tsx --env-file=.env scripts/ai-eval.ts

# The PayPal module against the sandbox: "order" creates a held-payment order and prints its approve link;
# after approving it as the sandbox payer, "capture <orderId>" or "void <orderId>"; "payout <worker email>" pays $1.00
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts order
```

`docs/runbook.md` is the full procedure for proving the money path on US sandbox accounts. `scripts/dev-fixtures.ts` builds a separate database with a contract in every state (made-up PayPal references, receipts signed by a key beside that database) for looking at the interface without running anything.

## Architecture

One Next.js app (App Router, TypeScript): pages and JSON route handlers in the same process, SQLite through `better-sqlite3`, and a headless Chromium started per check through Playwright.

```text
 Browser: pages, "Viewing as" Payer/Worker, PayPal JS SDK v6 button ----> PayPal sandbox (payer approval)
 AI agents: MCP client --(bearer token)--> /api/mcp
    |
    v
 Route handlers  /api/contracts/...  /api/mcp  /api/sweep  /api/ledger  /api/evidence/...  /api/verifier/public-key
    |
    +-- contract service + state machine (src/lib/contract)
    |      |-- drafter, mediator (src/lib/ai) ---------------------------> DeepSeek API
    |      |-- verifier (src/lib/verifier)
    |      |      |-- GitHub checks -------------------------------------> GitHub REST API
    |      |      |-- website checks: Chromium -> guard proxy -----------> the submitted URL
    |      |      |-- page judgement: three reviewers, screenshots + text -> DeepSeek API
    |      |      '-- signed receipt (Ed25519)
    |      '-- money: order, authorize, capture, void, payout, refund ---> PayPal REST (sandbox)
    |
    +-- SQLite data/clause.db, screenshots data/evidence/, signing key data/verifier-signing-key.pem
    ^
 PayPal webhooks -> /api/webhooks/paypal (signature-verified, idempotent, optional)
```

Time-based work (expiring holds, finishing pending payouts and splits, retrying a failed payout) runs in `POST /api/sweep`. The contract page calls it every 10 to 30 seconds while a contract waits on a deadline or a payout. Nothing else in the app calls it, so with no contract page open, deadlines and pending payouts wait until something calls `POST /api/sweep`. A hosted instance should call it on a schedule; `render.yaml` includes a cron job that does.

| Directory | Contents |
|---|---|
| `src/app` | Pages (`/`, `/contracts`, `/contracts/[id]`, `/ledger`) and route handlers under `src/app/api` (documented in `docs/api.md` and `docs/openapi.yaml`) |
| `src/components` | UI, including the PayPal button, the receipt panel and the AG Grid ledger (`ledger/ledger-view.tsx`) |
| `src/lib/contract` | State machine, the rules for who may do what, per-contract locks, money and dispute flows, the sweep |
| `src/lib/paypal` | PayPal REST client and webhook reconciliation |
| `src/lib/ai` | DeepSeek client, drafter, mediator, prompts, validated JSON calls |
| `src/lib/verifier` | Check runners, browser and guard proxy, network guard, evidence storage, the reviewer panel, signed receipts |
| `src/lib/agent` | Agent tokens and the MCP tools |
| `src/lib/db` | SQLite schema, migrations and queries |
| `scripts` | Database init and seed, agent tokens, the stdio MCP relay, the receipt checker, the real-service evaluations, the agent demo, test-only helpers and fixtures |
| `test/fixtures/site` | Fixture pages for the website checks, including the injection pages |
| `docs` | HTTP API (`api.md`, `openapi.yaml`), agents (`agents.md`), PayPal sandbox notes with sources (`paypal-notes.md`), the money-path runbook (`runbook.md`), the browser QA report (`qa-report.md`), the design language (`design.md`), the Devpost text (`submission.md`), the video script (`video-script.md`) |

The ledger page uses AG Grid Community: grouped amount columns (into hold, captured, paid out, returned), a pinned totals row that sums only the rows left after filtering, quick search, date, text and number column filters, movement-type toggles as an external filter, custom cell renderers, rows that flash as new movements arrive (it polls every 5 seconds), and CSV export with formula-like text escaped. The same page has an AG Charts (Community) chart of money over time and an SVG flow diagram of where all the money went; choosing a flow filters the grid.

## Deploying

The `Dockerfile` builds on `mcr.microsoft.com/playwright:v1.65.0-noble`, which ships Chromium and its system libraries for the Playwright version in the lockfile. On every start it runs `pnpm db:init && pnpm db:seed`, then `next start` on `$PORT`, so a fresh or wiped disk comes up with a working database. Seeding fails, and the container stops, if `DEMO_PAYER_EMAIL` or `DEMO_WORKER_EMAIL` is unset. At the time of writing the image itself has not been built (no Docker daemon was available); its install, build, seed and start commands were run outside Docker, from a clean copy, on Node 26.13.1, the Node major the image ships.

`render.yaml` is a Render Blueprint with two services: the web service built from the `Dockerfile`, with every environment variable declared and no values (Render asks for them when the Blueprint is applied), and a cron job that calls `POST /api/sweep` every 5 minutes over Render's private network.

- **Memory.** Measured locally: about 190 MB idle, 674 MB peak while verifying a simple page (server plus Chromium). Each concurrent verification adds a Chromium. A 512 MB instance, including Render's free tier, is likely to run out of memory; use at least 1 GB, and preferably 2 GB. `render.yaml` uses `1c-2g` (1 CPU, 2 GB).
- **Storage.** The database, evidence screenshots and the receipt signing key are files under `/app/data`. `render.yaml` attaches a 1 GB persistent disk there. Without a disk (Render's free tier cannot attach one), every deploy, restart or spin-down wipes all contracts, ledger rows, receipts and evidence, and a new signing key is generated unless `VERIFIER_SIGNING_KEY` is set; the start command recreates an empty database and the demo identities.
- **Cost.** Both services need paid plans: the web service for its memory and disk, and the cron job (Render bills cron jobs by run time, with a $1 monthly minimum).
- **Shared demo.** A deployment has one payer and one worker identity and one database, so everyone using it sees and acts on the same contracts.

## Status and limitations

**Run against the real services:**

- DeepSeek: the drafter, mediator and reviewer panel, in the evaluations above, and in the browser QA run of 12 Nov 2026 (`docs/qa-report.md`).
- Chromium: every website check against local fixture pages, and the draft, sign, submit, fail, resubmit, pass sequence with `https://info.cern.ch/` and `https://example.com/`, over HTTP against a local production build and in the browser (the PayPal hold faked with `scripts/flow-e2e.ts`).
- GitHub: one code-bounty check against a real pull request, which failed as designed because it was merged before the contract was signed. No passing live code bounty is recorded.
- PayPal sandbox: getting a token; creating an `AUTHORIZE` order (with idempotent replay), read back from PayPal with the right intent, amount and contract id; the JS SDK v6 button rendering and opening PayPal's sandbox checkout window; and **payouts, from the command line** (`scripts/paypal-smoke.ts payout`), including recovery of a payout whose reply was lost.
- MCP: `scripts/agent-demo.ts`, a buyer's agent over Streamable HTTP and a worker's agent over stdio, drafting, signing, submitting, reading the verdict and checking the receipt (`holds: true`), against a scratch database with the payer's approval simulated.

**Not yet run against the real sandbox:** buyer approval in PayPal's window, authorize, capture, void and refund, through the app or the command line. They are implemented and unit-tested with PayPal's responses mocked, and `docs/runbook.md` is the procedure to prove them. So no contract has yet reached `PAID`, `EXPIRED` or `SETTLED` with real sandbox money; those states have been seen only on fixture contracts and in tests. **Webhooks are not configured**: no webhook has been registered or received; the handler is unit-tested only, and nothing depends on it.

**Known limits:**

- **Sandbox only.** The PayPal sandbox endpoints are hard-coded. No real money can move.
- **Demo identities, not accounts.** There is no sign-up or authentication: two seeded identities and a cookie switch. Agents authenticate with tokens, but a token maps to one of the same two identities.
- **The three reviewers share one model.** They are the same model with different instructions, so they can share a blind spot and agree on the same mistake. The confidence threshold, the evidence trail, the optional contest window and the dispute path are the other mitigations, not a guarantee.
- **A receipt proves the record, not the verifier's honesty.** It shows that a verdict, its evidence and the terms it was checked against were not changed after signing. It does not prove that the operator ran the verifier honestly: the signing key is held by whoever runs the server. Screenshots are hashed but stay on the server, so checking them needs the app (or its files).
- **PayPal's approval for a real launch.** PayPal's Acceptable Use Policy lists escrow services among activities that need PayPal's pre-approval, and its User Agreement says PayPal does not act as an escrow agent. Treuhand holds money only as an ordinary authorization on the payer's own PayPal account, captured or voided by rules both parties signed; whether a live service built this way needs that approval is PayPal's decision, and it would be asked before launch. The sandbox does not enforce this. PayPal's marketplace "delayed disbursement" holds funds for at most 28 days and needs the worker onboarded as a seller, which breaks "the worker only needs an email address".
- **A page can show the verifier something different from what people see.** The worker controls the server and can detect the verifier (by address, browser fingerprint or timing) and serve it a page that passes while people get something else, or change the page after it passes. The evidence screenshots record what the verifier saw, which helps in a dispute, but nothing prevents this.
- **Only objectively checkable conditions.** Taste, quality and "is this what I meant" are refused by design. That limits which deals fit.
- **Passing the tests is not the same as good work.** A page can meet "has a contact form" and still be useless. The payer approves the tests before funding, and some gaming will remain.
- **Hold length.** Only the authorization-hold mode is built. PayPal authorizations are honoured for 3 days and valid for 29; deadlines are not capped, and reauthorization or capture-and-hold for longer contracts is not implemented. Sandbox authorizations never expire, so the app's own sweep voids at the deadline.
- **Escalation stops in the app.** A declined split leaves the contract `ESCALATED`; there is no in-app tool for the person who decides. If nobody settles it outside the app before the deadline, the sweep voids the hold and the contract becomes `EXPIRED`.

## Licence

MIT. See [LICENSE](LICENSE).
