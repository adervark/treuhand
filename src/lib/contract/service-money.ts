/**
 * Money actions: fund, settle a pass, expire, settle a dispute split, sweep.
 *
 * Double settlement: every PayPal-calling action runs under the contract's
 * claim (service-claims.ts), taken in an IMMEDIATE transaction together with
 * the state preconditions before the first PayPal call, so a racing request
 * gets BUSY instead of repeating a money step. Each step re-reads what is
 * already recorded (PayPal ids on the contract, ledger rows) and skips what
 * is done; the result of every PayPal call is recorded at once in one DB
 * transaction (refs, ledger, event), never left to a webhook. PayPal's own
 * idempotency keys (src/lib/paypal) are the second line, covering a call that
 * succeeded at PayPal but whose response was lost.
 *
 * Partial failure: if a later step fails, the contract stays in a state from
 * which the same action resumes at the failed step (capture is skipped once a
 * capture id is stored; a payout is never sent twice once a batch id is
 * stored). Payouts are asynchronous: the contract becomes PAID (or SETTLED)
 * only when PayPal reports the payout item SUCCESS; until then it stays
 * PASSED (or DISPUTED) and the sweep polls the batch. A payout PayPal returns
 * (`payoutReturned`) is sent again as a new attempt, up to
 * MAX_PAYOUT_ATTEMPTS; after the last one the worker's share is refunded to
 * the payer and the contract is SETTLED with nothing paid to the worker.
 */
import { contestWindowSeconds, MissingEnvError } from "@/lib/env";
import { getContract, listContracts, setPaypalRefs } from "@/lib/db/contracts";
import { getActiveDispute, updateDispute } from "@/lib/db/disputes";
import { listEvents, recordEvent } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { listLedgerEntries, recordLedgerEntry } from "@/lib/db/ledger";
import {
  authorizeOrder,
  captureAuthorization,
  createAuthorizedOrder,
  getPayoutBatch,
  payout,
  payoutOutcome,
  payoutReturned,
  PayPalError,
  refundCapture,
  voidAuthorization,
  type PayoutItemStatus,
  type PayoutResult,
} from "@/lib/paypal";
import type { Actor, Contract, ContractState, Dispute, LedgerKind, Party } from "@/lib/types";
import { IllegalTransitionError, transition, type TransitionOptions } from "./machine";
import { type ClaimAction, withClaim } from "./service-claims";
import { errorMessage, ServiceError, throwIfDenied } from "./service-errors";
import { expireDenial, fundDenial, isSplitAgreed, settlePassDenial } from "./service-rules";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

function load(contractId: string): Contract {
  return getContract(contractId)!;
}

/**
 * Records a failed step on the audit trail (shown as `activity.last_failure`).
 * A failure identical to the newest event is not repeated, so a sweep that
 * retries a step every 30 seconds does not flood the trail.
 */
export function recordFailure(contractId: string, action: ClaimAction, step: string, err: unknown): void {
  const message = errorMessage(err);
  const last = listEvents(contractId).at(-1);
  if (
    last?.kind === "ACTION_FAILED" &&
    last.detail.action === action &&
    last.detail.step === step &&
    last.detail.message === message
  ) {
    return;
  }
  recordEvent({
    contract_id: contractId,
    kind: "ACTION_FAILED",
    detail: { actor: "system", action, step, message, ...(err instanceof Error ? { error: err.name } : {}) },
  });
}

/**
 * Runs one PayPal call. A throw is recorded as ACTION_FAILED and surfaces as
 * PAYPAL_ERROR (MissingEnvError passes through so the route answers
 * NOT_CONFIGURED). No throw means PayPal accepted the action (src/lib/paypal).
 */
async function paypalStep<T>(contractId: string, action: ClaimAction, step: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    recordFailure(contractId, action, step, err);
    if (err instanceof MissingEnvError) throw err;
    throw new ServiceError("PAYPAL_ERROR", `PayPal ${step.replace(/_/g, " ")} failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function hasLedger(contractId: string, kind: LedgerKind, ref?: string | null): boolean {
  return listLedgerEntries({ contract_id: contractId }).some(
    (e) => e.kind === kind && (ref === undefined || e.paypal_ref === ref),
  );
}

/**
 * Moves the contract to `to`. If it is already there (a PayPal webhook got
 * there first), that counts as done.
 */
function transitionOrAlready(contractId: string, to: ContractState, opts: TransitionOptions): Contract {
  try {
    return transition(contractId, to, opts);
  } catch (err) {
    const current = getContract(contractId);
    if (err instanceof IllegalTransitionError && current?.state === to) return current;
    throw err;
  }
}

/** When the contract last entered PASSED, from the machine's STATE_CHANGED events. */
export function passedAt(contractId: string): string | null {
  const events = listEvents(contractId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "STATE_CHANGED" && e.detail.to === "PASSED") return e.created_at;
  }
  return null;
}

/** Captures the full contract amount unless a capture is already recorded. */
async function ensureCaptured(contractId: string, action: ClaimAction): Promise<Contract> {
  const contract = load(contractId);
  if (contract.paypal_capture_id) return contract;
  const capture = await paypalStep(contractId, action, "capture", () =>
    captureAuthorization({
      authorizationId: contract.paypal_authorization_id!,
      amountCents: contract.amount_cents,
      currency: contract.currency,
    }),
  );
  return inTx(() => {
    const updated = setPaypalRefs(contractId, { paypal_capture_id: capture.captureId });
    recordLedgerEntry({
      contract_id: contractId,
      kind: "CAPTURED",
      amount_cents: capture.amountCents,
      paypal_ref: capture.captureId,
      raw: capture.raw,
    });
    recordEvent({
      contract_id: contractId,
      kind: "FUNDS_CAPTURED",
      detail: {
        actor: "system",
        action,
        capture_id: capture.captureId,
        amount_cents: capture.amountCents,
        status: capture.status,
      },
    });
    return updated;
  });
}

/** How many payouts one share gets before its money goes back to the payer. */
export const MAX_PAYOUT_ATTEMPTS = 3;

/** The attempt the contract's payout belongs to: 1, or the one the last PAYOUT_RETRIED event started. */
export function payoutAttempt(contractId: string): number {
  const retried = listEvents(contractId).findLast((e) => e.kind === "PAYOUT_RETRIED");
  return typeof retried?.detail.attempt === "number" ? retried.detail.attempt : 1;
}

/**
 * The batch of a payout PayPal created but DENIED at once (`payout` throws
 * for it). It is recorded like any sent batch, so the status check sends the
 * next attempt instead of replaying this one under the same key forever.
 */
function deniedBatch(err: unknown): PayoutResult | null {
  if (!(err instanceof PayPalError) || err.paypalName !== "PAYOUT_BATCH_DENIED") return null;
  const id = (err.body as { batch_header?: { payout_batch_id?: unknown } } | null)?.batch_header?.payout_batch_id;
  return typeof id === "string" && id ? { payoutBatchId: id, batchStatus: "DENIED", raw: err.body } : null;
}

/**
 * Sends `amountCents` to the worker unless a payout batch is already recorded,
 * under the current attempt's key. Once a batch id is stored no other payout
 * is sent for this contract until `payWorker` finds that PayPal returned it.
 */
async function ensurePayoutSent(contractId: string, action: ClaimAction, amountCents: number): Promise<Contract> {
  const contract = load(contractId);
  if (contract.paypal_payout_batch_id) return contract;
  const attempt = payoutAttempt(contractId);
  const result = await paypalStep(contractId, action, "payout", async () => {
    try {
      return await payout({
        contractId,
        receiverEmail: contract.worker_email,
        amountCents,
        currency: contract.currency,
        note: `Proviso: ${contract.title}`,
        attempt,
      });
    } catch (err) {
      const denied = deniedBatch(err);
      if (denied) return denied;
      throw err;
    }
  });
  return inTx(() => {
    const updated = setPaypalRefs(contractId, { paypal_payout_batch_id: result.payoutBatchId });
    recordEvent({
      contract_id: contractId,
      kind: "PAYOUT_SENT",
      detail: {
        actor: "system",
        action,
        payout_batch_id: result.payoutBatchId,
        amount_cents: amountCents,
        receiver: contract.worker_email,
        batch_status: result.batchStatus,
        attempt,
        // Sent by an earlier call whose response was lost; PayPal refused the resend and `payout` read it back.
        ...(result.recovered ? { recovered: true } : {}),
      },
    });
    return updated;
  });
}

/** The payout status last recorded for this batch (PAYOUT_STATUS, else the batch status at sending). */
export function lastPayoutStatus(contractId: string, batchId: string): string | null {
  const events = listEvents(contractId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.detail.payout_batch_id !== batchId) continue;
    if (e.kind === "PAYOUT_STATUS") return String(e.detail.status);
    if (e.kind === "PAYOUT_SENT") return String(e.detail.batch_status);
  }
  return null;
}

/** What a payout's status means for the next step. */
type PayoutCheck =
  | { outcome: "PAID"; item: PayoutItemStatus }
  /** PayPal is still working on it, or holds it UNCLAIMED for the worker: wait, never send again. */
  | { outcome: "WAITING" }
  /** PayPal gave the money back (`payoutReturned`): the share may be sent again. */
  | { outcome: "RETURNED"; batchId: string; status: string };

/**
 * Reads the payout batch and records a status change on the audit trail. A
 * batch `payoutOutcome` calls NOT_PAID (the worker does not
 * have the money, now or, for UNCLAIMED, yet) is also recorded as
 * ACTION_FAILED, saying what happens next.
 */
async function checkPayout(contractId: string, action: ClaimAction): Promise<PayoutCheck> {
  const contract = load(contractId);
  const batchId = contract.paypal_payout_batch_id!;
  const batch = await paypalStep(contractId, action, "payout_status", () => getPayoutBatch(batchId));
  const item = batch.items[0] ?? null;
  const status = item?.transactionStatus ?? batch.batchStatus;
  const outcome = payoutOutcome(batch);
  const returned = payoutReturned(batch);
  const previous = lastPayoutStatus(contractId, batchId);
  if (status !== previous) {
    inTx(() => {
      recordEvent({
        contract_id: contractId,
        kind: "PAYOUT_STATUS",
        detail: {
          actor: "system",
          action,
          payout_batch_id: batchId,
          payout_item_id: item?.payoutItemId ?? null,
          status,
          previous,
          ...(item?.errors ? { errors: item.errors } : {}),
        },
      });
      if (outcome === "NOT_PAID") {
        const attempt = payoutAttempt(contractId);
        const why = !returned
          ? "the email has no PayPal account yet; it completes if the worker claims it"
          : attempt < MAX_PAYOUT_ATTEMPTS
            ? `PayPal returned the money, so it is sent again (attempt ${attempt + 1} of ${MAX_PAYOUT_ATTEMPTS})`
            : `PayPal returned the money on all ${MAX_PAYOUT_ATTEMPTS} attempts, so it is refunded to the payer`;
        recordFailure(contractId, action, "payout", new Error(`The payout to ${contract.worker_email} is ${status}: ${why}.`));
      }
    });
  }
  if (outcome === "PAID") return { outcome: "PAID", item: item! };
  return returned ? { outcome: "RETURNED", batchId, status } : { outcome: "WAITING" };
}

/**
 * Pays the worker's share: sends it unless a payout is recorded, then reads
 * its status. A payout PayPal returned is recorded (PAYOUT_RETRIED, with the
 * returned batch id) and the share is sent again as the next attempt, up to
 * MAX_PAYOUT_ATTEMPTS; a payout still pending or UNCLAIMED is never sent
 * again. Answers RETURNED only when the last attempt came back too.
 */
async function payWorker(contractId: string, action: ClaimAction, amountCents: number): Promise<PayoutCheck> {
  for (;;) {
    await ensurePayoutSent(contractId, action, amountCents);
    const check = await checkPayout(contractId, action);
    const attempt = payoutAttempt(contractId);
    if (check.outcome !== "RETURNED" || attempt >= MAX_PAYOUT_ATTEMPTS) return check;
    inTx(() => {
      recordEvent({
        contract_id: contractId,
        kind: "PAYOUT_RETRIED",
        detail: {
          actor: "system",
          action,
          payout_batch_id: check.batchId,
          status: check.status,
          attempt: attempt + 1,
          max_attempts: MAX_PAYOUT_ATTEMPTS,
        },
      });
      setPaypalRefs(contractId, { paypal_payout_batch_id: null });
    });
  }
}

/** Records the PAID_OUT ledger row (keyed by batch id, as the webhook handler does). Caller holds the transaction. */
function recordPaidOut(contract: Contract, item: PayoutItemStatus): void {
  recordLedgerEntry({
    contract_id: contract.id,
    kind: "PAID_OUT",
    amount_cents: item.amountCents,
    paypal_ref: contract.paypal_payout_batch_id!,
    raw: item.raw,
  });
}

/** PayPal issues on a void meaning no hold remains to release. */
const NO_HOLD_LEFT = new Set(["AUTHORIZATION_VOIDED", "AUTHORIZATION_EXPIRED"]);

/** PayPal issues on a void meaning the authorization was captured (docs/paypal-notes.md, void). */
const ALREADY_CAPTURED = new Set(["PREVIOUSLY_CAPTURED", "AUTHORIZATION_ALREADY_CAPTURED"]);

/**
 * Voids the contract's authorization unless a void of it is already recorded.
 * Returns false, recording nothing, when PayPal answers that the
 * authorization was already captured (a capture whose response was lost):
 * the caller then captures, which PayPal replays under the same key and so
 * returns the capture id, and refunds.
 */
async function ensureVoided(contractId: string, action: ClaimAction): Promise<boolean> {
  const contract = load(contractId);
  const authorizationId = contract.paypal_authorization_id!;
  if (hasLedger(contractId, "VOIDED", authorizationId)) return true;
  const result = await paypalStep(contractId, action, "void", async () => {
    try {
      return await voidAuthorization(authorizationId);
    } catch (err) {
      if (err instanceof PayPalError && err.issue && NO_HOLD_LEFT.has(err.issue)) {
        return { authorizationId, status: err.issue, raw: err.body };
      }
      if (err instanceof PayPalError && err.issue && ALREADY_CAPTURED.has(err.issue)) return null;
      throw err;
    }
  });
  if (!result) return false;
  inTx(() => {
    recordLedgerEntry({
      contract_id: contractId,
      kind: "VOIDED",
      amount_cents: contract.amount_cents,
      paypal_ref: authorizationId,
      raw: result.raw,
    });
    recordEvent({
      contract_id: contractId,
      kind: "AUTHORIZATION_VOIDED",
      detail: { actor: "system", action, authorization_id: authorizationId, status: result.status },
    });
  });
  return true;
}

/**
 * Refunds `amountCents` of the capture to the payer unless a refund is already
 * recorded. With `reason` (a second refund of the same capture, after a
 * split's payer share) only a refund recorded with that reason counts.
 */
async function ensureRefunded(
  contractId: string,
  action: ClaimAction,
  amountCents: number,
  reason?: "payout_returned",
): Promise<void> {
  const contract = load(contractId);
  const done = reason
    ? listEvents(contractId).some((e) => e.kind === "REFUND_SENT" && e.detail.reason === reason)
    : hasLedger(contractId, "REFUNDED");
  if (done) return;
  const why = reason ? "the payout could not be delivered" : action === "expire" ? "deadline passed" : "dispute split";
  const refund = await paypalStep(contractId, action, "refund", () =>
    refundCapture({
      captureId: contract.paypal_capture_id!,
      amountCents,
      currency: contract.currency,
      note: `Proviso: ${contract.title} (${why})`,
      ...(reason ? { reason } : {}),
    }),
  );
  inTx(() => {
    recordLedgerEntry({
      contract_id: contractId,
      kind: "REFUNDED",
      amount_cents: refund.amountCents,
      paypal_ref: refund.refundId,
      raw: refund.raw,
    });
    recordEvent({
      contract_id: contractId,
      kind: "REFUND_SENT",
      detail: {
        actor: "system",
        action,
        refund_id: refund.refundId,
        amount_cents: refund.amountCents,
        receiver: contract.payer_email,
        status: refund.status,
        ...(reason ? { reason } : {}),
      },
    });
  });
}

/**
 * Every payout attempt came back: refunds the worker's share to the payer and
 * ends the contract (and, for a split, its dispute) SETTLED with nothing paid
 * to the worker.
 */
async function refundReturnedShare(
  contractId: string,
  action: ClaimAction,
  workerCents: number,
  dispute: Dispute | null,
): Promise<Contract> {
  await ensureRefunded(contractId, action, workerCents, "payout_returned");
  return inTx(() => {
    const current = load(contractId);
    recordEvent({
      contract_id: contractId,
      kind: "PAYOUT_ABANDONED",
      detail: {
        actor: "system",
        action,
        payout_batch_id: current.paypal_payout_batch_id,
        attempts: MAX_PAYOUT_ATTEMPTS,
        amount_cents: workerCents,
      },
    });
    if (dispute) updateDispute(dispute.id, { state: "SETTLED" });
    return transitionOrAlready(contractId, "SETTLED", {
      actor: "system",
      detail: {
        reason: `PayPal returned all ${MAX_PAYOUT_ATTEMPTS} payouts; the worker's share was refunded to the payer`,
        worker_cents: 0,
        refund_cents: current.amount_cents,
        ...(dispute ? { dispute_id: dispute.id } : {}),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * Creates the PayPal AUTHORIZE order for a SIGNED contract (payer only), for
 * exactly the contract's amount and tagged with its id.
 */
export async function createFundingOrder(contractId: string, party: Party, now: Date = new Date()): Promise<string> {
  return withClaim(
    contractId,
    "fund",
    (c) => throwIfDenied(fundDenial(c, party, now)),
    async (contract) => {
      const order = await paypalStep(contractId, "fund", "create_order", () =>
        createAuthorizedOrder({
          contractId,
          amountCents: contract.amount_cents,
          currency: contract.currency,
          description: contract.title,
        }),
      );
      // PayPal replays the same order for a repeated request (idempotency key);
      // record it once.
      if (contract.paypal_order_id === order.orderId) return order.orderId;
      inTx(() => {
        setPaypalRefs(contractId, { paypal_order_id: order.orderId });
        recordEvent({
          contract_id: contractId,
          kind: "ORDER_CREATED",
          detail: {
            actor: party,
            order_id: order.orderId,
            status: order.status,
            amount_cents: contract.amount_cents,
            currency: contract.currency,
          },
        });
      });
      return order.orderId;
    },
    now,
  );
}

/** The contract id PayPal echoes on the authorized order (reference_id / custom_id), if present. */
function orderContractIds(raw: unknown): string[] {
  const unit = (raw as { purchase_units?: { reference_id?: unknown; custom_id?: unknown }[] } | null)
    ?.purchase_units?.[0];
  return [unit?.reference_id, unit?.custom_id].filter((v): v is string => typeof v === "string");
}

const AUTHORIZATION_HELD = new Set(["CREATED", "PENDING"]);

/**
 * Authorizes the approved order and moves the contract to FUNDED (payer only).
 * The order must be the one created for this contract, PayPal's copy of it
 * must carry this contract's id, and the authorized amount and currency must
 * equal the contract's; a mismatched hold is voided. Repeating the call after
 * success with the same order id returns the contract.
 */
export async function confirmFunding(
  contractId: string,
  party: Party,
  orderId: string,
  now: Date = new Date(),
): Promise<Contract> {
  const existing = getContract(contractId);
  if (existing && party === "payer" && existing.state !== "SIGNED" && existing.paypal_order_id === orderId) {
    if (existing.paypal_authorization_id) return existing;
  }
  return withClaim(
    contractId,
    "fund",
    (c) => {
      throwIfDenied(fundDenial(c, party, now));
      if (!c.paypal_order_id || c.paypal_order_id !== orderId) {
        throw new ServiceError(
          "ORDER_MISMATCH",
          "This PayPal order was not created for this contract. Start funding again.",
        );
      }
    },
    async (contract) => {
      const auth = await paypalStep(contractId, "fund", "authorize", () => authorizeOrder(orderId));
      const ids = orderContractIds(auth.raw);
      const mismatch =
        auth.orderId !== orderId
          ? `authorization belongs to order ${auth.orderId}`
          : ids.some((id) => id !== contractId)
            ? `order is tagged for contract ${ids.find((id) => id !== contractId)}`
            : auth.amountCents !== contract.amount_cents ||
                auth.currency.toUpperCase() !== contract.currency.toUpperCase()
              ? `authorized ${auth.amountCents} ${auth.currency}, contract is ${contract.amount_cents} ${contract.currency}`
              : !AUTHORIZATION_HELD.has(auth.status.toUpperCase())
                ? `authorization status is ${auth.status}`
                : null;
      if (mismatch) {
        await releaseMismatchedHold(contract, auth.authorizationId, auth.amountCents, auth.raw, mismatch);
        throw new ServiceError(
          "ORDER_MISMATCH",
          `The PayPal hold did not match the contract (${mismatch}); it was released. Start funding again.`,
        );
      }
      return inTx(() => {
        const funded = transitionOrAlready(contractId, "FUNDED", {
          actor: party,
          paypal: { paypal_order_id: orderId, paypal_authorization_id: auth.authorizationId },
        });
        if (funded.paypal_authorization_id !== auth.authorizationId) {
          throw new ServiceError(
            "ILLEGAL_TRANSITION",
            `The contract is already funded by authorization ${funded.paypal_authorization_id}.`,
          );
        }
        recordLedgerEntry({
          contract_id: contractId,
          kind: "AUTHORIZED",
          amount_cents: auth.amountCents,
          paypal_ref: auth.authorizationId,
          raw: auth.raw,
        });
        recordEvent({
          contract_id: contractId,
          kind: "FUNDS_AUTHORIZED",
          detail: {
            actor: party,
            order_id: orderId,
            authorization_id: auth.authorizationId,
            amount_cents: auth.amountCents,
            status: auth.status,
            expires_at: auth.expiresAt,
          },
        });
        return funded;
      });
    },
    now,
  );
}

/** Records a hold that does not match the contract and voids it; the contract stays SIGNED. */
async function releaseMismatchedHold(
  contract: Contract,
  authorizationId: string,
  amountCents: number,
  raw: unknown,
  reason: string,
): Promise<void> {
  inTx(() => {
    recordLedgerEntry({
      contract_id: contract.id,
      kind: "AUTHORIZED",
      amount_cents: amountCents,
      paypal_ref: authorizationId,
      raw,
    });
    recordFailure(contract.id, "fund", "authorize", new Error(`The PayPal hold does not match the contract: ${reason}.`));
  });
  try {
    const result = await voidAuthorization(authorizationId);
    inTx(() => {
      recordLedgerEntry({
        contract_id: contract.id,
        kind: "VOIDED",
        amount_cents: amountCents,
        paypal_ref: authorizationId,
        raw: result.raw,
      });
      recordEvent({
        contract_id: contract.id,
        kind: "AUTHORIZATION_VOIDED",
        detail: { actor: "system", action: "fund", authorization_id: authorizationId, reason },
      });
    });
  } catch (err) {
    recordFailure(contract.id, "fund", "void_mismatched_hold", err);
  }
}

// ---------------------------------------------------------------------------
// Settle a pass: capture, payout, PAID once the payout item is SUCCESS
// ---------------------------------------------------------------------------

/**
 * Pays the worker for a PASSED contract once the contest window has elapsed:
 * capture (skipped if already captured), payout (skipped if a batch is already
 * recorded), then a payout status check. The contract becomes PAID only when
 * PayPal reports the payout item SUCCESS; otherwise it is returned still
 * PASSED and the next call (the sweep) checks again. On a failed step the
 * contract stays PASSED with whatever succeeded recorded, and the next call
 * resumes from the failed step. A payout PayPal returns is sent again
 * (`payWorker`); if the last attempt comes back too, the payer is refunded in
 * full and the contract is SETTLED.
 */
export async function settlePass(contractId: string, now: Date = new Date()): Promise<Contract> {
  return withClaim(
    contractId,
    "settle_pass",
    (c) => throwIfDenied(settlePassDenial(c, passedAt(contractId), contestWindowSeconds(), now)),
    async (contract) => {
      await ensureCaptured(contractId, "settle_pass");
      const paid = await payWorker(contractId, "settle_pass", contract.amount_cents);
      if (paid.outcome === "WAITING") return load(contractId);
      if (paid.outcome === "RETURNED") return refundReturnedShare(contractId, "settle_pass", contract.amount_cents, null);
      const item = paid.item;
      return inTx(() => {
        const current = load(contractId);
        recordPaidOut(current, item);
        return transitionOrAlready(contractId, "PAID", {
          actor: "system",
          paypal: { paypal_payout_batch_id: current.paypal_payout_batch_id! },
          detail: { capture_id: current.paypal_capture_id, payout_batch_id: current.paypal_payout_batch_id },
        });
      });
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Expire: void, EXPIRED
// ---------------------------------------------------------------------------

/**
 * Voids the hold on a FUNDED, FAILED or VERIFYING contract past its deadline
 * and marks it EXPIRED. A VERIFYING contract qualifies only when no
 * verification run holds it (its latest run ended without a verdict); a run
 * in progress holds the claim, so this answers BUSY and the run is never
 * interrupted. A DISPUTED or ESCALATED contract qualifies unless both parties
 * accepted a split. If PayPal answers that the hold was already captured (a
 * capture whose response was lost), the capture is replayed and refunded.
 */
export async function expireContract(contractId: string, now: Date = new Date()): Promise<Contract> {
  return withClaim(
    contractId,
    "expire",
    (c) => throwIfDenied(expireDenial(c, now, getActiveDispute(contractId))),
    async (contract) => {
      if (!(await ensureVoided(contractId, "expire"))) {
        await ensureCaptured(contractId, "expire");
        await ensureRefunded(contractId, "expire", contract.amount_cents);
      }
      const dispute = getActiveDispute(contractId);
      return transitionOrAlready(contractId, "EXPIRED", {
        actor: "system",
        detail: {
          reason: "deadline passed",
          deadline_at: contract.deadline_at,
          ...(dispute ? { dispute_id: dispute.id } : {}),
        },
      });
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Settle a split: capture, refund the payer's share, pay out the worker's, SETTLED
// ---------------------------------------------------------------------------

/**
 * Settles the agreed split of a DISPUTED contract. A 0 worker share voids the
 * hold (or, if PayPal answers it was already captured, captures and refunds it
 * in full); otherwise capture the full amount, refund the payer's share and pay
 * out the worker's. The dispute and the contract become SETTLED once nothing
 * is left to move: no worker share, the worker's payout item is SUCCESS, or
 * every payout attempt came back and the worker's share was refunded too.
 * Each step is skipped if already recorded, so a retry after a partial failure
 * resumes where it stopped, and the sweep finishes a pending payout.
 */
export async function settleSplit(contractId: string, actor: Actor, now: Date = new Date()): Promise<Contract> {
  return withClaim(
    contractId,
    "settle_split",
    (c) => {
      if (c.state !== "DISPUTED") {
        throw new ServiceError("ILLEGAL_TRANSITION", `Cannot settle a split while the contract is ${c.state}.`);
      }
      if (!isSplitAgreed(getActiveDispute(contractId))) {
        throw new ServiceError("DISPUTE_STATE", "Both parties must accept the proposal before it is settled.");
      }
      if (!c.paypal_authorization_id) {
        throw new ServiceError("ILLEGAL_TRANSITION", "Cannot settle: no PayPal authorization is recorded.");
      }
    },
    async (contract) => {
      const dispute = getActiveDispute(contractId)!;
      const workerCents = dispute.proposed_worker_cents!;
      const refundCents = contract.amount_cents - workerCents;
      let item: PayoutItemStatus | null = null;
      const voided = workerCents === 0 && !contract.paypal_capture_id && (await ensureVoided(contractId, "settle_split"));
      if (!voided) {
        await ensureCaptured(contractId, "settle_split");
        if (refundCents > 0) await ensureRefunded(contractId, "settle_split", refundCents);
        if (workerCents > 0) {
          const paid = await payWorker(contractId, "settle_split", workerCents);
          if (paid.outcome === "WAITING") return load(contractId);
          if (paid.outcome === "RETURNED") return refundReturnedShare(contractId, "settle_split", workerCents, dispute);
          item = paid.item;
        }
      }
      return inTx(() => {
        if (item) recordPaidOut(load(contractId), item);
        updateDispute(dispute.id, { state: "SETTLED" });
        return transitionOrAlready(contractId, "SETTLED", {
          actor,
          detail: { dispute_id: dispute.id, worker_cents: workerCents, refund_cents: refundCents },
        });
      });
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepError {
  contract_id: string;
  action: "expire" | "settle_pass" | "settle_split";
  code: string;
  message: string;
}

export interface SweepResult {
  /** Contracts this sweep moved to EXPIRED. */
  expired: Contract[];
  /** Contracts this sweep moved to PAID or SETTLED. */
  settled: Contract[];
  errors: SweepError[];
}

/**
 * Time-based and retry work: expire FUNDED/FAILED contracts past their
 * deadline (and VERIFYING ones whose latest run ended without a verdict; a
 * run in progress is BUSY and skipped; and DISPUTED/ESCALATED ones with no
 * split accepted by both), settle PASSED contracts whose contest window has elapsed
 * (retrying a payout that failed after capture, polling a pending payout,
 * and sending a returned one again), and resume agreed splits. A contract
 * another request is already working on (BUSY) is skipped.
 */
export async function runSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { expired: [], settled: [], errors: [] };
  const attempt = async (contractId: string, action: SweepError["action"], run: () => Promise<Contract>) => {
    try {
      const contract = await run();
      if (contract.state === "EXPIRED") result.expired.push(contract);
      else if (contract.state === "PAID" || contract.state === "SETTLED") result.settled.push(contract);
    } catch (err) {
      if (err instanceof ServiceError && err.code === "BUSY") return;
      const code =
        err instanceof ServiceError ? err.code : err instanceof MissingEnvError ? "NOT_CONFIGURED" : "INTERNAL";
      result.errors.push({ contract_id: contractId, action, code, message: errorMessage(err) });
    }
  };

  const expirable = (["FUNDED", "FAILED", "VERIFYING", "DISPUTED", "ESCALATED"] as const).flatMap((state) =>
    listContracts({ state }),
  );
  for (const c of expirable) {
    if (!expireDenial(c, now, getActiveDispute(c.id))) await attempt(c.id, "expire", () => expireContract(c.id, now));
  }

  const windowSeconds = contestWindowSeconds();
  for (const c of listContracts({ state: "PASSED" })) {
    if (!settlePassDenial(c, passedAt(c.id), windowSeconds, now)) {
      await attempt(c.id, "settle_pass", () => settlePass(c.id, now));
    }
  }

  for (const c of listContracts({ state: "DISPUTED" })) {
    if (isSplitAgreed(getActiveDispute(c.id))) {
      await attempt(c.id, "settle_split", () => settleSplit(c.id, "system", now));
    }
  }
  return result;
}
