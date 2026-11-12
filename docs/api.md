# Treuhand HTTP API

The JSON API served by the route handlers in `src/app/api/**` and used by the
pages in `src/app` and `src/components`: every route, its exact JSON shapes,
and its error codes.

TypeScript types for every response are exported from
`src/lib/contract/service.ts` (`ContractDetail`, `AllowedAction`,
`VerificationStatus`, `ActivityStatus`, `PayoutStatus`, `LedgerRow`,
`SweepResult`, `AcceptResult`, `ContractReceipts`, `SignedReceipt`,
`VerifierPublicKey`). Import them with `import type` so no server code reaches
the browser.

## Conventions

- All bodies and responses are JSON. Money is integer cents (`amount_cents`).
  Dates are ISO 8601 UTC strings. Entity fields are snake_case, exactly as in
  `src/lib/types.ts` (`Contract`, `Condition`, `Submission`, `Verdict`,
  `LedgerEntry`, `Dispute`, `ClauseEvent`), except that ledger rows are
  returned without `raw`, the stored PayPal response body, which can hold the
  payer's name, email and address. No route returns a stored PayPal body.
- **Acting party:** the `clause_view_as` cookie (`payer` | `worker`, default
  `payer`), read through `src/lib/viewer.ts`. Set it with the `setViewAs`
  server action. There is no other auth.
- **Page role:** the pages send `X-Treuhand-Role: payer | worker`, the role
  the page was rendered for, on every request. Every tab of a browser shares
  the cookie, so a tab can be left showing the role another tab switched
  away from; a write that acts as a party (every `POST` and `PATCH` under
  `/api/contracts`) whose header names a role
  other than the cookie's is refused with `409 ROLE_MISMATCH` before anything
  is done, and the page re-renders for the cookie's role. The header is
  optional (a caller without it acts as the cookie's role) and ignored with
  an agent token.
- **Errors:** every non-2xx response is

  ```json
  { "error": { "code": "FORBIDDEN", "message": "Only the worker can submit work. You are viewing as the payer." } }
  ```

  `message` is written for people and safe to show in the UI. For
  `VALIDATION_ERROR` it is `"<field path>: <problem>"`, several joined with
  `"; "` (e.g. `"amount_cents: is required (the deal did not state an amount)"`,
  `"conditions.0.check_params.selector: Invalid input: expected string, received undefined"`).

### Error codes

| code | status | when |
|---|---|---|
| `VALIDATION_ERROR` | 400 | body is not JSON, or fails its schema, or the deadline is not in the future. `message` names the field. |
| `INVALID_CONDITION` | 422 | a condition's check kind is not allowed for the contract type |
| `FORBIDDEN` | 403 | the viewer's party may not do this (e.g. worker trying to fund) |
| `NOT_FOUND` | 404 | no contract with that id, no dispute to act on, or no submission to re-verify |
| `ILLEGAL_TRANSITION` | 409 | the contract's state does not allow this action (e.g. fund a DRAFT) |
| `CONTRACT_LOCKED` | 409 | editing conditions after the contract left DRAFT |
| `DEADLINE_PASSED` | 409 | signing a DRAFT, funding, submitting or re-running verification at or after `deadline_at` |
| `ORDER_MISMATCH` | 409 | `orderId` is not the order created for this contract, or PayPal's hold is for another contract, another amount/currency, or not held; such a hold is voided |
| `BUSY` | 409 | another action (payment, verification, mediation) is running on this contract; retry shortly |
| `DISPUTE_STATE` | 409 | the dispute is not in a state that allows this (e.g. accept before a proposal) |
| `IDENTITIES_MISSING` | 409 | demo identities are not seeded; run `pnpm db:seed` |
| `ROLE_MISMATCH` | 409 | the request's `X-Treuhand-Role` is not the `clause_view_as` cookie's role: the role was switched in another tab after this page rendered. Nothing was done; reload the page |
| `PAYPAL_ERROR` | 502 | a PayPal call failed. Whatever already succeeded is recorded; the step is retried by the next action or sweep. |
| `AI_ERROR` | 502 | the drafter or mediator failed |
| `NOT_CONFIGURED` | 503 | an env key is missing (PayPal, DeepSeek); `message` names it |
| `INTERNAL` | 500 | anything else (details go to the server log, not the response) |

## Routes

### `POST /api/contracts/draft` (payer only)

Body: `{ "prompt": string (1..4000 chars after trimming), "type"?: "code_bounty" | "website_milestone" }`

200: the drafter's `DraftResult` (`src/lib/ai/drafter.ts`), unchanged:

```json
{ "kind": "draft", "contract": {
    "title": "Fix issue #212", "type": "code_bounty", "amount_cents": 5000, "currency": "USD",
    "deadline_at": "2026-11-14T23:59:59.000Z",
    "conditions": [ { "text": "PR is merged", "check_kind": "github_pr_merged", "check_params": { "repo": "acme/app" } } ],
    "notes": [ "Read \"works\" as \"the PR's checks pass\"." ] } }
```
```json
{ "kind": "refusal", "vague_conditions": [
    { "condition": "looks professional", "reason": "...", "suggested_rewrite": null },
    { "condition": "a website for my yoga studio", "reason": "...", "suggested_rewrite": "The submitted page responds with a 2xx status." } ] }
```

`suggested_rewrite` is `null` when no check comes close to what the payer
meant (taste, speed, a website's source code, work that is neither a pull
request nor a website): the payer drops the condition or restates it. A
rewrite may contain a `[bracketed blank]` only for a value only the payer
knows; it never asks for the work's URL.

`amount_cents`, `currency` and `deadline_at` are `null` when the deal did not
state them; the payer fills them in before `POST /api/contracts`. Show `notes`
to both parties. The parties are the seeded payer and worker identities.
Errors: `VALIDATION_ERROR`, `FORBIDDEN`, `IDENTITIES_MISSING`, `AI_ERROR`,
`NOT_CONFIGURED`.

### `POST /api/contracts` (payer only)

Body: a `ProposedContract` (the `contract` of a draft, possibly edited) with
every term filled in:

```json
{ "title": string (1..200), "type": "code_bounty" | "website_milestone", "amount_cents": int 1..500000,
  "currency"?: "USD" (any case) or null (default "USD"), "deadline_at": ISO date-time with zone, in the future,
  "conditions": [ { "text": string, "check_kind": CheckKind, "check_params": {...} } ] (at least 1),
  "notes"?: string[] }
```

A null `amount_cents` or `deadline_at` is a `VALIDATION_ERROR` naming the
field. Contracts are in US dollars only and hold at most $5,000.00
(`MAX_AMOUNT_CENTS` in `src/lib/format.ts`), well under PayPal's
per-transaction limits, so a contract that can be created can be funded:
another currency is `"currency: must be USD: contracts are paid in US dollars
only"`, a larger amount `"amount_cents: must be at most 500000 ($5,000.00, the
most one contract may hold)"`. The drafter still reports the currency the deal
named; the composer then asks for the amount in USD. `deadline_at` is stored in UTC. `notes` are kept and returned as
`notes` by `GET /api/contracts/[id]`.

201: `{ "contract": Contract }` in `DRAFT`, `payer_email`/`worker_email` from
the seeded identities, no sign-offs. Errors: `VALIDATION_ERROR`,
`INVALID_CONDITION`, `FORBIDDEN`, `IDENTITIES_MISSING`.

### `GET /api/contracts`

200: `{ "contracts": Contract[] }`, newest first.

### `GET /api/contracts/[id]`

200: `ContractDetail`:

```jsonc
{
  "contract": Contract,
  "conditions": Condition[],          // position order
  "submissions": Submission[],        // newest first
  "verdicts": Verdict[],              // every verdict on every submission, oldest first; group by submission_id.
                                      // Each verdict is stored as soon as its check finishes (checks run in
                                      // condition order); a re-run first clears that submission's verdicts, so
                                      // each submission has at most one verdict per condition. While
                                      // verification.status is "running" the latest submission's set is partial;
                                      // only verification.status says whether a run has finished.
  "ledger": LedgerEntry[],            // this contract's money movements, oldest first, without `raw`
  "events": ClauseEvent[],            // audit trail, oldest first
  "dispute": Dispute | null,          // the newest dispute in any state

  // derived on the server, so the page needs no rules of its own:
  "notes": string[],                  // the drafter's notes from creation; [] if none
  "viewer": { "role": "payer" | "worker" },
  "allowed_actions": AllowedAction[], // what this viewer can do right now (see below)
  "verification": null | {            // null until the first submission
    "status": "running" | "passed" | "failed" | "inconclusive" | "error",
    "submission_id": string,          // the latest submission
    "message": string | null,         // why it was inconclusive / how many checks did not pass / what errored
    "at": string
  },
  "activity": {
    "in_progress": null | "fund" | "verify" | "settle_pass" | "expire" | "mediate" | "settle_split",
    "last_failure": null | { "action": string, "step": string, "message": string, "at": string }
  },
  "payout": null | {                  // the worker's latest payout attempt, once one has been sent
    "payout_batch_id": string,
    "amount_cents": number,
    "status": string,                 // PayPal's item status: "SUCCESS", "PENDING", "UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", ...
    "at": string
  },
  "terms_sha256": string | null,      // SHA-256 (hex) of the agreed terms, fixed at signing; null while DRAFT
  "receipt": SignedReceipt | null,    // the newest signed verification receipt (see "Verification receipts")
  "trace": {                          // the verifier's work log (see "Work log" below)
    "now": string,                    // the server's clock when this response was built
    "steps": TraceStep[]              // every step of every submission's latest run: submissions oldest first, then seq
  }
}
```

`AllowedAction` is one of `"edit_conditions"`, `"sign"`, `"fund"`, `"submit"`,
`"rerun_verification"`, `"dispute"`, `"respond"`, `"accept"`, `"decline"`.
Show a button only when its action is listed; the matching POST enforces the
same rule and returns an error otherwise. While another action holds the
contract (`activity.in_progress` not null) only `edit_conditions` and `sign`
can be listed.

`verification.status` is about the latest submission. `inconclusive` means the
verifier could not complete a check (it is neither a pass nor a fail); the
contract stays in `VERIFYING` and `rerun_verification` and `dispute` become
available to both parties (`rerun_verification` only before the deadline). `error` means the verification run itself crashed
or was interrupted; same handling. No contract is stranded in `VERIFYING`:
once its deadline has passed, the sweep voids the hold and the contract
becomes `EXPIRED`. A run that is still in progress (`status` `running`) is
never interrupted: while it runs no action is listed and the sweep skips it.

`activity.last_failure` is the latest failed money or mediation step not yet
followed by progress (a state change, or a PayPal or mediation step that
succeeded), e.g. `{ "action": "settle_pass", "step": "payout", ... }` for a
payout that failed after capture. It is retried by the next sweep or by the
action that triggered it. A payout that PayPal reports not paid (UNCLAIMED,
FAILED, RETURNED, BLOCKED, REFUNDED, REVERSED, CANCELED, or a DENIED or
CANCELED batch) also appears here (`step: "payout"`), saying what happens
next.

`step` is one of `"create_order"`, `"authorize"`, `"void_mismatched_hold"`
(funding); `"capture"`, `"payout"`, `"payout_status"` (reading the payout's
status from PayPal failed; the payout was already sent, and the sweep reads it
again), `"settle"` (an unexpected error while settling a pass), `"void"`,
`"refund"` (paying out a pass or a split, or expiring); `"propose_split"`,
`"validate_proposal"` (mediation).

**Payouts are asynchronous.** After capture and payout the contract stays
`PASSED` (or `DISPUTED` for a split) with `payout.status` `"PENDING"` until
PayPal reports the item `SUCCESS`; only then does it become `PAID` (or
`SETTLED`). The sweep polls it.

**A payout that does not arrive.** While a payout is pending or `UNCLAIMED`
(PayPal holds it for the worker to claim) no second payout is sent; the
contract waits and `payout.status` shows it. When PayPal reports a final
not-paid status (`FAILED`, `RETURNED`, `BLOCKED`, `REFUNDED`, `REVERSED`,
`CANCELED`, or a `DENIED` or `CANCELED` batch), the sweep records the returned
batch id (a `PAYOUT_RETRIED` event) and sends the same share again under a new
idempotency key and batch id, up to 3 attempts in all; `payout` then
describes the newest attempt. If the third attempt is not paid either, the
worker's share is refunded to the payer (so the payer gets the whole capture
back: a `REFUNDED` ledger row), a `PAYOUT_ABANDONED` event is recorded, and the
contract (and, for a split, its dispute) becomes `SETTLED` with nothing paid
to the worker.

Poll this route while `contract.state` is `SUBMITTED` or `VERIFYING`, while
`activity.in_progress` is not null, or while `payout.status` is not
`"SUCCESS"` and the contract is not `SETTLED`. Errors: `NOT_FOUND`.

#### Work log

`trace.steps` lists what the verifier did, one step per action, written as it
happens: a step is stored as `running` when it starts and updated when it
ends, so polling this route during a run shows the run as far as it has got.
Types are in `src/lib/verifier/trace-types.ts`.

```jsonc
// TraceStep
{
  "id": string,
  "submission_id": string,
  "condition_id": string | null,      // null for run-level steps (kind "record")
  "seq": number,                      // 1-based order of starting within the submission's run
  "kind": "guard" | "network" | "browser" | "measure" | "screenshot" | "model" | "decision" | "record",
  "label": string,                    // a phrase written by the verifier's code, never text from the page
  "status": "running" | "done" | "failed",
  "started_at": string,               // ISO, server clock
  "duration_ms": number | null,       // null while running
  "detail": { [key: string]: string | number | boolean | null },  // neutral facts, safe to show mid-run
  "result": { [key: string]: string | number | boolean | null }   // facts that reveal how the check ends
}
```

- **`detail` and `result`.** `detail` holds neutral facts: host, HTTP status,
  attempts, load time, bytes, viewport width, reviewer and model name, counts.
  `result` holds anything that gives the check's outcome away: a reviewer's
  vote and confidence, the panel's decision, whether an element or the success
  text was found, the verdict. Show `result` only once that condition's
  verdict is in `verdicts`. Values can come from the submitted page (strings
  are clipped to 160 characters): render them as text, never as markup.
- **`failed`** means the step threw (its message is in `result.error`), did
  not do what it set out to (a page that did not load, a screenshot that
  could not be taken), or was cut off: a step still running when its check hit
  the time limit is ended as failed with `detail.cut_off: true`.
- **Each check ends with a `decision` step** "Record the verdict" whose
  `result` carries `outcome` (`"pass"`, `"fail"`, `"inconclusive"`),
  `confidence` and, when inconclusive, `reason`. After the checks, one
  run-level `record` step "Sign the verification receipt" (`detail`:
  `algorithm`, `verdicts`, `issued`, and the first 12 hex digits of
  `receipt_sha256`, or `problem`) records the receipt.
- **A re-run replaces the log.** It clears that submission's steps along with
  its verdicts, then starts again at `seq` 1.
- **Covered by the receipt.** Each check's finished steps (its own and its
  decision step) are copied into its verdict as `evidence.trace`, an array of
  `{ seq, kind, label, status, started_at, duration_ms, detail, result }`,
  before the verdict is stored, so the receipt's per-verdict
  `evidence_sha256` covers the work log.

### `PATCH /api/contracts/[id]/conditions` (either party, DRAFT only)

Body: `{ "conditions": ConditionInput[] }` (at least 1; replaces the whole list).

200: `{ "contract": Contract, "conditions": Condition[] }`. Both sign-offs
are cleared. Errors: `VALIDATION_ERROR`, `INVALID_CONDITION`,
`CONTRACT_LOCKED`, `NOT_FOUND`.

### `POST /api/contracts/[id]/sign` (either party; signs as the viewer's party; DRAFT only, before the deadline)

No body. 200: `{ "contract": Contract }`. When the second party signs, the
contract is `SIGNED`. Signing twice is a no-op. A draft not signed by both
parties before `deadline_at` lapses: signing it is refused with
`DEADLINE_PASSED` ("Cannot sign: the deadline (...) has passed.") and `sign`
is no longer listed in `allowed_actions`, because a contract signed after its
deadline could never be funded. Errors: `ILLEGAL_TRANSITION` (not DRAFT, or
no conditions), `DEADLINE_PASSED`, `NOT_FOUND`.

### `POST /api/contracts/[id]/fund/create-order` (payer only, SIGNED only, before the deadline)

No body. 200: `{ "orderId": string }`, a PayPal order with `intent: AUTHORIZE`
for exactly `amount_cents` / `currency`, tagged with this contract's id
(`reference_id` and `custom_id`). Pass it to the JS SDK button's
`createOrder`. Calling again returns the same order while PayPal remembers the
request (its idempotency window, 6 hours); only the order stored on the
contract (`contract.paypal_order_id`) can be authorized. Errors: `FORBIDDEN`,
`ILLEGAL_TRANSITION`, `DEADLINE_PASSED`, `BUSY`, `PAYPAL_ERROR`,
`NOT_CONFIGURED`, `NOT_FOUND`.

### `POST /api/contracts/[id]/fund/authorize` (payer only)

Body: `{ "orderId": string }` (from the button's `onApprove`).

200: `{ "contract": Contract }` in `FUNDED`, with `paypal_order_id` and
`paypal_authorization_id` set and a ledger `AUTHORIZED` row. Repeating the call
with the same `orderId` after success returns the contract again without
calling PayPal. If the PayPal webhook funded the contract first, the call
still succeeds. A hold for the wrong amount, currency or contract is voided
and answered `ORDER_MISMATCH` (the contract stays `SIGNED`). Errors:
`VALIDATION_ERROR`, `FORBIDDEN`, `ORDER_MISMATCH`, `ILLEGAL_TRANSITION`,
`DEADLINE_PASSED`, `BUSY`, `PAYPAL_ERROR`, `NOT_CONFIGURED`, `NOT_FOUND`.

### `POST /api/contracts/[id]/submit` (worker only, FUNDED or FAILED, before the deadline)

Body: `{ "url": string (http or https URL) }`

202: `{ "submissionId": string }`. The contract is already `VERIFYING` when
this returns and `activity.in_progress` is `"verify"`. Verification runs after
the response; poll `GET /api/contracts/[id]`. It ends in `PASSED` (then paid
automatically after the contest window, 0 seconds in the demo: capture, payout,
and `PAID` once PayPal reports the payout `SUCCESS`), `FAILED` (resubmit
allowed), or stays `VERIFYING` with `verification.status` `inconclusive` /
`error`. A failed payment step after a pass is recorded in
`activity.last_failure`, never lost. Errors: `VALIDATION_ERROR`, `FORBIDDEN`,
`ILLEGAL_TRANSITION`, `DEADLINE_PASSED`, `BUSY`, `NOT_FOUND`.

Screenshots in a verdict's `evidence.screenshots` are stored paths such as
`data/evidence/<submissionId>/<file>.jpg`; load them through
`GET /api/evidence/<submissionId>/<file>` (below).

### `POST /api/contracts/[id]/verify` (either party)

Re-runs verification of the latest submission when the last run was
inconclusive, crashed or was interrupted (the contract is still `VERIFYING`),
before the deadline. No body. 202: `{ "submissionId": string }`; poll as after
submit. Errors: `ILLEGAL_TRANSITION` (not VERIFYING), `DEADLINE_PASSED` (past
the deadline the sweep expires the contract instead), `BUSY` (a run is in
progress), `NOT_FOUND`.

### `GET /api/contracts/[id]/receipts`

200: every signed verification receipt for the contract, newest first: one
per finished verification run, re-runs included (a crashed run has none).

```jsonc
{
  "contract_id": string,
  "terms_sha256": string | null,      // as in GET /api/contracts/[id]
  "receipts": SignedReceipt[]
}
```

Errors: `NOT_FOUND`. No party check, like the rest of the demo.

#### Verification receipts

When a run finishes, the verifier signs a receipt of what it verified,
against what, and what it concluded, and stores it with the submission. The
`VERIFICATION_COMPLETED` event carries its `receipt_sha256` (or
`receipt_error` if it could not be issued; the outcome stands either way). A
receipt is a record only: nothing reads it to decide whether money moves.

```jsonc
// SignedReceipt (src/lib/verifier/receipt-core.ts)
{
  "receipt": {
    "schema": "treuhand.receipt/1",
    "contract_id": string,
    "submission_id": string,
    "submitted_url": string,
    "terms_sha256": string | null,    // the terms hash fixed at signing
    "outcome": "passed" | "failed" | "inconclusive",  // the run's outcome, as the contract acted on it
    "verdicts": [{                    // condition order
      "verdict_id": string,
      "condition_id": string,
      "check_kind": CheckKind,
      "outcome": "pass" | "fail" | "inconclusive",
      "confidence": number,
      "reasoning_sha256": string,     // SHA-256 of the verdict's reasoning (UTF-8)
      "evidence_sha256": string,      // SHA-256 of the canonical JSON of the verdict's evidence
      "screenshots": [{ "path": string, "sha256": string | null }]  // the file's bytes; null if missing
    }],
    "verifier": { "name": string, "version": string, "model": string },  // package name ("treuhand") and version, model id
    "started_at": string, "finished_at": string, "issued_at": string
  },
  "receipt_sha256": string,           // SHA-256 of the canonical JSON of "receipt"
  "signature": {
    "algorithm": "Ed25519",
    "key_fingerprint": string,        // SHA-256 of the signing public key's DER SPKI
    "value": string                   // base64 Ed25519 signature over the 32 bytes of receipt_sha256
  }
}
```

**Canonical JSON** is JSON with object keys sorted by UTF-16 code unit (as RFC
8785) and no whitespace; values are written as `JSON.stringify` writes them.
**The terms hash** is the SHA-256 of the canonical JSON of
`{ "schema": "treuhand.terms/1", "contract_id", "type", "payer_email",
"worker_email", "amount_cents", "currency", "deadline_at", "conditions": [{
"text", "check_kind", "check_params" }] }`, conditions in position order,
values as in `contract` and `conditions` above. It is computed when the
contract becomes `SIGNED` (and recorded on that `STATE_CHANGED` event as
`terms_sha256`); a contract signed before receipts existed gets it computed
on first read (terms cannot change after DRAFT, so it is the same value).

**To check a receipt:** `pnpm exec tsx scripts/verify-receipt.ts <receipt file
or URL> --app <base URL>` (or `--key <PEM file>` and `--contract <contract
JSON>`) recomputes the receipt hash, checks the signature, recomputes the
terms hash from the contract, compares each verdict's evidence and reasoning
with what was signed (verdicts a later re-run replaced are reported as not
compared), and with `--app` downloads each screenshot and compares its hash.
It exits 1 on any mismatch.

### `GET /api/verifier/public-key`

200: the key that signs verification receipts.

```jsonc
{
  "algorithm": "Ed25519",
  "public_key_pem": string,           // SPKI PEM
  "public_key_jwk": { "kty": "OKP", "crv": "Ed25519", "x": string },
  "fingerprint": string               // SHA-256 (hex) of the DER SPKI; receipts cite it as signature.key_fingerprint
}
```

The key comes from `VERIFIER_SIGNING_KEY`, or is generated on first use and
kept beside the database (`data/verifier-signing-key.pem` by default,
owner-only). Errors: `INTERNAL` if `VERIFIER_SIGNING_KEY` is set but is not an
Ed25519 private key.

### `POST /api/contracts/[id]/dispute` (either party; FUNDED, FAILED, PASSED, or VERIFYING after an inconclusive or crashed run)

Body: `{ "argument": string (1..4000) }`. 200: `{ "dispute": Dispute }` in
state `OPEN`, the viewer's argument filled in; the contract is `DISPUTED`.
Not allowed once the money has been captured for a payout, and `BUSY` while
a verification run is in progress (it is never interrupted). Errors:
`VALIDATION_ERROR`, `ILLEGAL_TRANSITION`, `BUSY`, `NOT_FOUND`.

### `POST /api/contracts/[id]/dispute/respond` (either party, dispute OPEN)

Body: `{ "argument": string (1..4000) }`. Stores (or revises) the viewer's
argument. Once both arguments exist, the mediator proposes a split.

200: `{ "dispute": Dispute }`: state `PROPOSED` with `proposed_worker_cents`
(0..`amount_cents`) and `proposal_reasoning` once both sides have argued,
otherwise still `OPEN`. If the mediator fails the argument is kept, the
response is `AI_ERROR`, and calling respond again retries. Errors:
`VALIDATION_ERROR`, `DISPUTE_STATE`, `NOT_FOUND`, `BUSY`, `AI_ERROR`,
`NOT_CONFIGURED`.

### `POST /api/contracts/[id]/dispute/accept` (either party, dispute PROPOSED)

Body: none, or `{ "accept": false }` to decline.

200: `{ "dispute": Dispute, "contract": Contract }`. Accepting records the
viewer's acceptance; when both have accepted the split is settled in the same
request: capture, refund of the payer's share, payout of
`proposed_worker_cents` to the worker (a 0 worker share voids the hold
instead; if PayPal answers that the hold was already captured, from a capture
whose response was lost, the capture is replayed under the same idempotency
key and refunded in full). The dispute and the contract become `SETTLED` once
nothing is left to move: at once for a 0 worker share, otherwise when PayPal
reports the worker's payout `SUCCESS` (until then the dispute stays `PROPOSED`
with both acceptances, the contract `DISPUTED`, and `payout.status` shows the
payout; the sweep finishes it). Declining escalates both to `ESCALATED` (a
human decides); a party who has accepted cannot decline. A dispute not settled
by the deadline (still open, proposed but not accepted by both, or escalated)
ends with the hold voided by the sweep and the contract `EXPIRED`. If a PayPal
step fails, the acceptance is kept, completed steps are recorded, and the
response is `PAYPAL_ERROR`; the sweep (or accepting again over the API,
either party) resumes from the failed step. `accept` is listed in
`allowed_actions` only for a party who has not accepted yet, so once both
have, neither page offers it again. Errors: `VALIDATION_ERROR`, `DISPUTE_STATE`,
`NOT_FOUND`, `BUSY`, `PAYPAL_ERROR`, `NOT_CONFIGURED`.

### `POST /api/sweep`

No body, no party check. Runs the time-based and retry work:

- voids holds on `FUNDED`/`FAILED` contracts past `deadline_at`, on
  `VERIFYING` ones whose latest run was inconclusive or crashed (a run in
  progress is skipped), and on `DISPUTED`/`ESCALATED` ones with nothing
  captured and no split accepted by both parties (-> `EXPIRED`; if PayPal
  answers that the hold was already captured, the capture is replayed and
  refunded in full),
- settles `PASSED` contracts whose contest window has elapsed, including
  retrying a payout that failed after capture, checking a pending payout
  (-> `PAID` once PayPal reports it `SUCCESS`), and sending a payout PayPal
  returned again (-> `SETTLED` with the payer refunded after the third),
- resumes split settlements where both parties accepted (-> `SETTLED`).

A contract another request is working on is skipped. 200:

```json
{ "expired": Contract[], "settled": Contract[],
  "errors": [ { "contract_id": string, "action": "expire" | "settle_pass" | "settle_split", "code": string, "message": string } ] }
```

`expired` and `settled` list only the contracts this sweep moved to
`EXPIRED`, and to `PAID` or `SETTLED`. Call it on a timer from the page (e.g.
every 30 s) or from a cron.

### `GET /api/evidence/[submissionId]/[file]`

A screenshot the verifier stored as evidence. A verdict's
`evidence.screenshots` holds paths relative to the project root,
`data/evidence/<submissionId>/<file>`; the image URL is
`/api/evidence/<submissionId>/<file>` (drop the `data/evidence/` prefix).

200: the image bytes with `Content-Type` `image/jpeg`, `image/png` or
`image/webp` (from the extension), `X-Content-Type-Options: nosniff`, and a
private one-day cache (file names carry a per-run stamp, so a stored image
never changes). Only files inside `data/evidence/` are read. Errors:
`VALIDATION_ERROR` (400) when either segment is not a plain file name (a
separator, a leading dot, `..`, or any character outside `A-Z a-z 0-9 . _ -`),
`NOT_FOUND` (404) for a missing file, a file that is not an image, or a path
that resolves outside the evidence directory (e.g. through a symlink). No
party check, like the rest of the demo.

### `GET /api/ledger`

200: `{ "entries": (LedgerEntry & { "contract_title": string, "contract_state": ContractState, "currency": string })[] }`,
oldest first, each without `raw`. A `PAID_OUT` row
is written when PayPal reports the payout item `SUCCESS`, not when the batch
is accepted; its `paypal_ref` is the payout batch id.

### `GET /api/config`

200: `{ "paypalClientId": string }`. Errors: `NOT_CONFIGURED`.
