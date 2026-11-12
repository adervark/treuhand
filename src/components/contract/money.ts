/**
 * Where a contract's money is, derived from its ledger (the record of what
 * PayPal actually did) with the contract state as a fallback when the ledger
 * has not caught up yet.
 */
import type { Contract, Dispute, LedgerEntry, LedgerKind } from "@/lib/types";
import type { ContractBundle, PayoutStatus } from "../api";
import { formatCents, type Tone } from "../format";

/** The actions `POST /api/sweep` runs again (runSweep in src/lib/contract/service-money.ts). */
export const SWEPT_ACTIONS = new Set(["settle_pass", "settle_split", "expire"]);

/** Both parties accepted the mediator's proposal (isSplitAgreed in src/lib/contract/service-rules.ts). */
export function splitAgreed(dispute: Dispute | null): boolean {
  return dispute?.state === "PROPOSED" && dispute.proposed_worker_cents !== null && dispute.payer_accepted === true && dispute.worker_accepted === true;
}

/** States whose hold the sweep releases once the deadline passes (expireDenial in src/lib/contract/service-rules.ts). */
const EXPIRES_AT_DEADLINE = new Set(["FUNDED", "FAILED", "VERIFYING", "DISPUTED", "ESCALATED"]);

const PASS_STALLED: Record<string, string> = {
  capture: "Every test passed, but PayPal refused to capture the hold. Proviso tries again automatically.",
  payout: "Every test passed and the hold was captured, but the payout has not reached the worker. Proviso keeps trying automatically.",
  payout_status: "Every test passed and the payout was sent, but PayPal did not report its status. Proviso checks again automatically.",
  refund: "PayPal could not deliver the payout, and the refund to the payer did not go through. Proviso tries again automatically.",
};

/**
 * What the track headline and "Your move" say when the state's own words would
 * mislead: a money step whose last attempt failed (which step, and that the
 * sweep retries it; DEF-10, DEF-12), a split both parties accepted, a deadline
 * that passed before the sweep released the hold (DEF-14), or a contract that
 * lapsed unsigned or unfunded at its deadline (DEF-15). `now` is null before
 * hydration. Null when the state's own words are right.
 */
export function contractNotice(
  bundle: Pick<ContractBundle, "contract" | "activity" | "dispute">,
  now: number | null,
): { text: string; tone: Tone } | null {
  const { contract, activity, dispute } = bundle;
  const failure = activity.last_failure;
  if (failure && SWEPT_ACTIONS.has(failure.action)) {
    if (failure.action === "settle_pass") {
      return { tone: "disputed", text: PASS_STALLED[failure.step] ?? "Every test passed, but paying the worker did not start. Proviso tries again automatically." };
    }
    if (failure.action === "settle_split") {
      return { tone: "disputed", text: "Both accepted the split, but PayPal did not complete the settlement. It is being retried automatically." };
    }
    return {
      tone: "disputed",
      text:
        failure.step === "void"
          ? "The deadline passed, but PayPal did not release the hold. Proviso tries again automatically."
          : "The deadline passed, but returning the money to the payer did not go through. Proviso tries again automatically.",
    };
  }
  if (contract.state === "DISPUTED" && splitAgreed(dispute)) {
    return { tone: "disputed", text: "Both accepted the split. It is being settled with PayPal." };
  }
  const pastDeadline = now !== null && now >= Date.parse(contract.deadline_at);
  if (!pastDeadline) return null;
  if (contract.state === "DRAFT") {
    return { tone: "fail", text: "The deadline passed before both parties signed, so this draft lapsed and can no longer be signed. No money moved." };
  }
  if (contract.state === "SIGNED") {
    return { tone: "fail", text: "The deadline passed before the payer funded it, so this contract lapsed. No money moved." };
  }
  // A verification still running is never interrupted; the sweep releases the hold after it.
  if (EXPIRES_AT_DEADLINE.has(contract.state) && contract.paypal_authorization_id && !contract.paypal_capture_id && activity.in_progress !== "verify") {
    return { tone: "returned", text: "The deadline passed. The hold is being released to the payer." };
  }
  return null;
}

export type MoneyStage = "unfunded" | "held" | "sending" | "paid" | "split" | "released" | "refunded";

export interface MoneyPosition {
  stage: MoneyStage;
  currency: string;
  amount: number;
  totals: Record<LedgerKind, number>;
  held: number;
  paidOut: number;
  refunded: number;
  released: number;
  /** A payout PayPal accepted but has not confirmed. */
  inFlight: number;
  headline: string;
  detail: string;
  /** Set when PayPal reported a payout problem (UNCLAIMED, FAILED, RETURNED, BLOCKED, ...). */
  problem: string | null;
}

/** Payout item statuses that mean the money did not reach the worker (docs/paypal-notes.md, Payouts). */
const PAYOUT_PROBLEMS = new Set(["UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "REVERSED", "ONHOLD"]);

/** The API leaves out `raw` (PayPal's response body). */
type Entry = Omit<LedgerEntry, "raw">;

export function sumLedger(entries: Entry[]): Record<LedgerKind, number> {
  const totals: Record<LedgerKind, number> = { AUTHORIZED: 0, CAPTURED: 0, PAID_OUT: 0, VOIDED: 0, REFUNDED: 0 };
  for (const e of entries) totals[e.kind] += e.amount_cents;
  return totals;
}

/** Money still sitting with PayPal or the platform for these entries. */
export function heldFrom(totals: Record<LedgerKind, number>): number {
  const inflow = Math.max(totals.AUTHORIZED, totals.CAPTURED);
  return Math.max(0, inflow - totals.VOIDED - totals.PAID_OUT - totals.REFUNDED);
}

const HELD_STATES = new Set(["FUNDED", "SUBMITTED", "VERIFYING", "PASSED", "FAILED", "DISPUTED", "ESCALATED"]);

export function moneyPosition(
  contract: Contract,
  ledger: Entry[],
  payout: PayoutStatus | null = null,
  failure: ContractBundle["activity"]["last_failure"] = null,
): MoneyPosition {
  const { amount_cents: amount, currency } = contract;
  const fmt = (c: number) => formatCents(c, currency);
  const totals = sumLedger(ledger);
  let held = heldFrom(totals);
  let paidOut = totals.PAID_OUT;
  const refunded = totals.REFUNDED;
  let released = totals.VOIDED;

  // The ledger is written by the money module; until a row lands, trust the state.
  if (ledger.length === 0) {
    if (HELD_STATES.has(contract.state) && (contract.paypal_authorization_id || contract.paypal_capture_id)) held = amount;
    if (contract.state === "PAID" && contract.paypal_payout_batch_id) paidOut = amount;
    if (contract.state === "EXPIRED" && contract.paypal_authorization_id) released = amount;
  }

  const base = { currency, amount, totals, held, paidOut, refunded, released, problem: null, inFlight: 0 };

  // A payout PayPal accepted is not yet money in the worker's account: the
  // PAID_OUT ledger row lands only when the payout item succeeds; until then it is in flight.
  // SETTLED with a payout that never succeeded: every attempt came back and the payer was refunded.
  if (payout && payout.status.toUpperCase() !== "SUCCESS" && contract.state !== "SETTLED") {
    const status = payout.status.toUpperCase();
    const sent = fmt(payout.amount_cents);
    if (PAYOUT_PROBLEMS.has(status)) {
      return {
        ...base,
        held: 0,
        inFlight: payout.amount_cents,
        stage: "sending",
        headline: `Payout ${status.toLowerCase()}`,
        detail:
          status === "UNCLAIMED"
            ? `PayPal is holding the ${sent} payout for ${contract.worker_email}, which has no PayPal account yet. It lands when they claim it.`
            : status === "ONHOLD"
              ? `PayPal put the ${sent} payout to ${contract.worker_email} on hold for review. Proviso waits for it and does not send it again.`
              : `PayPal reported the ${sent} payout to ${contract.worker_email} as ${status} and returned the money. Proviso sends it again, up to 3 attempts in all, then refunds the payer.`,
        problem: status,
      };
    }
    return {
      ...base,
      held: 0,
      inFlight: payout.amount_cents,
      stage: "sending",
      headline: `${sent} payout sent`,
      detail: `PayPal accepted the payout to ${contract.worker_email} (status: ${status.toLowerCase()}). It counts as paid once PayPal confirms it arrived.`,
    };
  }
  if (paidOut > 0 && refunded > 0) {
    return {
      ...base,
      stage: "split",
      headline: `${fmt(paidOut)} paid to worker`,
      detail: `${fmt(refunded)} refunded to the payer under the agreed split.`,
    };
  }
  if (paidOut > 0) {
    return {
      ...base,
      stage: "paid",
      headline: `${fmt(paidOut)} paid to worker`,
      detail: "PayPal sent the payout to the worker's email once every test passed.",
    };
  }
  if (held > 0) {
    const captured = totals.CAPTURED > 0;
    return {
      ...base,
      stage: "held",
      headline: `${fmt(held)} held by PayPal`,
      detail: captured
        ? SWEPT_ACTIONS.has(failure?.action ?? "")
          ? "Captured from the payer, but the next PayPal step did not go through. Proviso tries again automatically."
          : "Captured from the payer. The payout to the worker is on its way."
        : failure?.action === "settle_split"
          ? "Reserved on the payer's account, not yet charged. Both accepted the split; settling it with PayPal did not go through yet, and Proviso tries again automatically."
          : contract.state === "DISPUTED" || contract.state === "ESCALATED"
          ? "Reserved on the payer's account, not yet charged. How the dispute ends decides whether PayPal captures it or releases it to the payer."
          : "Reserved on the payer's account, not yet charged. PayPal captures it and pays the worker only when every test passes.",
    };
  }
  if (released > 0) {
    return {
      ...base,
      stage: "released",
      headline: `${fmt(released)} hold released to payer`,
      detail: `The ${fmt(released)} hold went back to the payer, who was never charged.`,
    };
  }
  if (refunded > 0) {
    return {
      ...base,
      stage: "refunded",
      headline: `${fmt(refunded)} refunded to payer`,
      detail: "The money went back to the payer.",
    };
  }
  return {
    ...base,
    stage: "unfunded",
    headline: "No money has moved",
    detail: `${fmt(amount)} will be held by PayPal when the payer funds the signed contract.`,
  };
}
