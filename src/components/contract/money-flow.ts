/**
 * The money-flow model behind the contract page's diagram (docs/design.md,
 * "The money flow"): five places the contract's money can be and the five
 * legs between them, each with its state, amount, time and PayPal reference.
 * Derived only from what `GET /api/contracts/[id]` returns: the ledger rows
 * (what PayPal did), the contract state, `activity`, `payout` and the events.
 */
import type { ContractState, LedgerKind } from "@/lib/types";
import type { ContractBundle } from "../api";
import { splitAgreed, sumLedger, SWEPT_ACTIONS } from "./money";

export type PlaceKey = "payer" | "hold" | "capture" | "worker" | "returned";
export type LegKey = "fund" | "capture" | "payout" | "release" | "refund";

/** done: PayPal moved money along it. moving: money is on it now. possible: it can still happen. closed: it no longer can. failed: it was tried and did not arrive. */
export type LegStatus = "done" | "moving" | "possible" | "closed" | "failed";
/** current: money sits here now. incoming: money is on its way here. visited: money passed through. possible: money may still come. closed: money will never come. */
export type PlaceStatus = "current" | "incoming" | "visited" | "possible" | "closed";
export type FlowTone = "neutral" | "held" | "paid" | "returned" | "disputed" | "fail";

export interface LegModel {
  key: LegKey;
  /** Said when the leg can no longer be taken: "no refund". */
  closedText: string;
  from: PlaceKey;
  to: PlaceKey;
  status: LegStatus;
  tone: FlowTone;
  /** What the movement is called: "Hold placed", "Captured", ... */
  verb: string;
  cents: number | null;
  at: string | null;
  ref: string | null;
  refLabel: string;
  /** For possible legs: what would make the money move ("all 3 tests pass"). */
  trigger: string | null;
  /** A time that belongs to the trigger (the deadline). */
  when: string | null;
  /** In-between detail: "sent · waiting for PayPal to confirm". */
  note: string | null;
  /** Which payout attempt this is, once PayPal has returned one: "attempt 2 of 3". */
  attempt: string | null;
}

export interface PlaceModel {
  key: PlaceKey;
  status: PlaceStatus;
  tone: FlowTone;
  title: string;
  /** Money here now (current), on its way (incoming) or that would come (possible); null shows no figure. */
  cents: number | null;
  /** One or two words: "reserved", "received", "never charged". */
  word: string;
}

export interface MoneyFlow {
  currency: string;
  amount: number;
  places: Record<PlaceKey, PlaceModel>;
  legs: Record<LegKey, LegModel>;
  /** Where the money is: one place, two places (a split), or a leg (a payout PayPal has not confirmed). */
  now: { places: PlaceKey[]; leg: LegKey | null };
}

export const PLACE_ORDER: PlaceKey[] = ["payer", "hold", "capture", "worker", "returned"];
export const LEG_ORDER: LegKey[] = ["fund", "capture", "payout", "release", "refund"];

const TERMINAL: ContractState[] = ["PAID", "EXPIRED", "SETTLED"];
const PAYOUT_PROBLEMS = new Set(["UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "REVERSED", "ONHOLD", "CANCELED"]);

type Row = ContractBundle["ledger"][number];

function lastOf(rows: Row[], kind: LedgerKind): Row | null {
  return rows.findLast((r) => r.kind === kind) ?? null;
}

/** The leg's PayPal step failed last time and the sweep retries it: nothing is moving on it. */
function markFailed(leg: LegModel, verb: string): void {
  leg.status = "failed";
  leg.verb = verb;
  leg.tone = "disputed";
  leg.note = "Treuhand tries again automatically";
}

export function moneyFlow(bundle: ContractBundle): MoneyFlow {
  const { contract, ledger, activity, payout, events, dispute, conditions } = bundle;
  const { state, amount_cents: amount, currency } = contract;
  const totals = sumLedger(ledger);
  const terminal = TERMINAL.includes(state);
  const busy = activity.in_progress;
  const failedStep = activity.last_failure?.step ?? null;

  // The ledger is the record of what PayPal did; the state is a fallback while a row has not landed.
  const authorized = totals.AUTHORIZED > 0 || totals.CAPTURED > 0 || Boolean(contract.paypal_authorization_id);
  const captured = totals.CAPTURED > 0 || Boolean(contract.paypal_capture_id);
  const voided = totals.VOIDED > 0 || (state === "EXPIRED" && authorized && !captured);
  const paidOut = totals.PAID_OUT > 0 ? totals.PAID_OUT : state === "PAID" && contract.paypal_payout_batch_id && ledger.length === 0 ? amount : 0;
  const refunded = totals.REFUNDED;
  const capturedCents = totals.CAPTURED || (captured ? amount : 0);

  const abandoned = events.some((e) => e.kind === "PAYOUT_ABANDONED");
  const retries = events.filter((e) => e.kind === "PAYOUT_RETRIED");
  const attempt = retries.length + 1;
  const inFlight = payout && payout.status.toUpperCase() !== "SUCCESS" && state !== "SETTLED" ? payout : null;
  const inFlightStatus = inFlight?.status.toUpperCase() ?? null;
  const inFlightProblem = inFlightStatus !== null && PAYOUT_PROBLEMS.has(inFlightStatus);
  const inFlightCents = inFlight?.amount_cents ?? 0;

  const inCapture = Math.max(0, capturedCents - paidOut - refunded - inFlightCents);
  const inHold = authorized && !captured && !voided ? amount : 0;

  const tests = conditions.length;
  const allPass = tests === 1 ? "the test passes" : `all ${tests} tests pass`;
  // A mediator's proposal that both parties may still accept (a declined one is ESCALATED and a person decides).
  const split = dispute && dispute.proposed_worker_cents !== null && state === "DISPUTED" ? dispute.proposed_worker_cents : null;
  const escalated = state === "ESCALATED";
  const settling = busy === "settle_pass" || busy === "settle_split";
  // Both parties accepted the proposal: it is being settled, no longer "if both accept" (DEF-13).
  const agreed = split !== null && splitAgreed(dispute);
  // A 0 worker share is settled by voiding the hold, never by capture then refund (settleSplit in service-money.ts).
  const zeroSplit = split === 0 && !captured;
  const ifSplit = agreed ? "on settlement" : "if both accept";
  const splitTrigger = agreed ? "the agreed split is settled" : "both accept the split";
  // A step the sweep retries failed last time: its leg shows the failure, never money moving (DEF-10).
  const retried = SWEPT_ACTIONS.has(activity.last_failure?.action ?? "");

  // ---- legs -----------------------------------------------------------------
  const authRow = lastOf(ledger, "AUTHORIZED");
  const fund: LegModel = {
    key: "fund",
    closedText: "never funded",
    from: "payer",
    to: "hold",
    verb: "Hold placed",
    tone: "held",
    refLabel: "authorization",
    status: authorized ? "done" : busy === "fund" ? "moving" : terminal ? "closed" : "possible",
    cents: authorized ? (authRow?.amount_cents ?? amount) : amount,
    at: authRow?.created_at ?? null,
    ref: authRow?.paypal_ref ?? contract.paypal_authorization_id,
    trigger: state === "DRAFT" ? "both sign, then the payer approves in PayPal" : "the payer approves in PayPal",
    when: null,
    note: busy === "fund" ? "PayPal is placing the hold" : null,
    attempt: null,
  };

  const capRow = lastOf(ledger, "CAPTURED");
  const captureTrigger =
    state === "ESCALATED"
      ? "a person at Treuhand decides"
      : state === "DISPUTED"
        ? split !== null
          ? agreed
            ? "the agreed split is settled"
            : "both accept the mediator's split"
          : "a split is agreed"
        : state === "FAILED"
          ? `a resubmission passes ${tests === 1 ? "the test" : `all ${tests} tests`}`
          : allPass;
  const capture: LegModel = {
    key: "capture",
    closedText: zeroSplit ? "not captured" : "never captured",
    from: "hold",
    to: "capture",
    verb: "Captured",
    tone: "held",
    refLabel: "capture",
    status: captured
      ? "done"
      : zeroSplit
        ? "closed"
        : authorized && !voided && (settling || state === "PASSED")
        ? "moving"
        : voided || terminal
          ? "closed"
          : "possible",
    cents: captured ? capturedCents : amount,
    at: capRow?.created_at ?? null,
    ref: capRow?.paypal_ref ?? contract.paypal_capture_id,
    trigger: captureTrigger,
    when: null,
    note: !captured ? "PayPal is capturing the hold" : null,
    attempt: null,
  };
  if (retried && failedStep === "capture" && authorized && !captured) markFailed(capture, "Capture refused");

  const paidRow = lastOf(ledger, "PAID_OUT");
  const payoutLeg: LegModel = {
    key: "payout",
    closedText: "no payout",
    from: "capture",
    to: "worker",
    verb: "Paid out",
    tone: "paid",
    refLabel: "payout batch",
    status: paidOut > 0 ? "done" : inFlight ? "moving" : abandoned ? "failed" : captured && settling && inCapture > 0 ? "moving" : voided || terminal || zeroSplit ? "closed" : "possible",
    cents: paidOut > 0 ? paidOut : inFlight ? inFlightCents : split !== null ? split : abandoned ? capturedCents : amount,
    at: paidRow?.created_at ?? inFlight?.at ?? null,
    ref: paidRow?.paypal_ref ?? inFlight?.payout_batch_id ?? (abandoned ? contract.paypal_payout_batch_id : null),
    trigger: split !== null ? splitTrigger : "the hold is captured",
    when: null,
    note: null,
    attempt: null,
  };
  if (payoutLeg.status === "moving") {
    payoutLeg.verb = inFlight ? "Sent" : "Paying out";
    payoutLeg.tone = inFlightProblem ? "disputed" : "paid";
    payoutLeg.note = inFlightProblem
      ? `PayPal says ${inFlightStatus!.toLowerCase()}`
      : inFlight
        ? "waiting for PayPal"
        : "PayPal is sending it";
    if (attempt > 1) payoutLeg.attempt = `attempt ${attempt} of 3`;
  } else if (payoutLeg.status === "failed") {
    payoutLeg.verb = "Returned 3×";
    payoutLeg.tone = "fail";
    payoutLeg.note = "PayPal could not deliver it";
  } else if (payoutLeg.status === "done" && (retries.length > 0 || failedStep === "payout")) {
    payoutLeg.attempt = retries.length > 0 ? `on attempt ${attempt} of 3` : null;
  } else if (payoutLeg.status === "possible" && retried && failedStep === "payout" && captured) {
    markFailed(payoutLeg, "Payout failed");
  }

  const voidRow = lastOf(ledger, "VOIDED");
  const releasing = busy === "expire" || (zeroSplit && busy === "settle_split");
  const release: LegModel = {
    key: "release",
    closedText: "no release",
    from: "hold",
    to: "returned",
    verb: "Hold released",
    tone: "returned",
    refLabel: "authorization",
    status: voided ? "done" : releasing && authorized && !captured ? "moving" : captured || terminal ? "closed" : "possible",
    cents: voided ? (voidRow?.amount_cents ?? amount) : amount,
    at: voidRow?.created_at ?? null,
    ref: voidRow?.paypal_ref ?? (voided ? contract.paypal_authorization_id : null),
    trigger: zeroSplit
      ? splitTrigger
      : state === "DRAFT" || state === "SIGNED"
        ? "it is funded and nothing passes by the deadline"
        : "nothing passes by the deadline",
    when: zeroSplit ? null : contract.deadline_at,
    note: releasing ? "PayPal is releasing the hold" : null,
    attempt: null,
  };
  if (retried && failedStep === "void" && authorized && !voided && !captured) markFailed(release, "Release refused");

  const refundRows = ledger.filter((r) => r.kind === "REFUNDED");
  const refundMoving = !refunded && captured && ((busy === "settle_split" && split !== null && split < amount) || busy === "expire");
  const refund: LegModel = {
    key: "refund",
    closedText: "no refund",
    from: "capture",
    to: "returned",
    verb: "Refunded",
    tone: "returned",
    refLabel: refundRows.length > 1 ? `refund (${refundRows.length})` : "refund",
    status: refunded > 0 ? "done" : refundMoving ? "moving" : voided || terminal || zeroSplit ? "closed" : "possible",
    cents: refunded > 0 ? refunded : split !== null ? amount - split : null,
    at: refundRows.at(-1)?.created_at ?? null,
    ref: refundRows.at(-1)?.paypal_ref ?? null,
    trigger:
      split !== null
        ? splitTrigger
        : attempt > 1
          ? "payout attempt 3 comes back too"
          : "a split is agreed, or 3 payouts come back",
    when: null,
    note: refunded > 0 && abandoned ? "the payout never arrived" : refunded > 0 && paidOut > 0 ? "the payer's share" : refundMoving ? "PayPal is refunding" : null,
    attempt: null,
  };
  if (retried && failedStep === "refund" && captured && refund.status === "possible") markFailed(refund, "Refund failed");

  // ---- places ---------------------------------------------------------------
  const payer: PlaceModel = {
    key: "payer",
    title: "Payer's PayPal",
    tone: "neutral",
    status: authorized ? "visited" : terminal ? "closed" : "current",
    cents: authorized ? null : amount,
    word: !authorized ? (state === "DRAFT" ? "not held yet" : "ready to fund") : voided && !captured ? "never charged" : captured ? "charged" : "reserved, not charged",
  };
  const hold: PlaceModel = {
    key: "hold",
    title: "PayPal hold",
    tone: "held",
    status: inHold > 0 ? "current" : authorized ? "visited" : terminal ? "closed" : "possible",
    cents: inHold > 0 ? inHold : null,
    word: inHold > 0 ? "held · not charged" : captured ? "captured" : voided ? "released" : "on funding",
  };
  const capturePlace: PlaceModel = {
    key: "capture",
    title: "Captured",
    tone: "held",
    status: inCapture > 0 ? "current" : captured ? "visited" : voided || terminal || zeroSplit ? "closed" : "possible",
    cents: inCapture > 0 ? inCapture : null,
    word: inCapture > 0 ? (retried ? "charged · step being retried" : "charged · paying out") : !captured && (voided || terminal || zeroSplit) ? "never captured" : captured ? (paidOut > 0 && refunded > 0 ? "split two ways" : paidOut > 0 ? "paid to the worker" : refunded > 0 ? "refunded" : inFlight ? "sent to the worker" : "emptied") : split !== null ? ifSplit : "on a pass",
  };
  const workerTone: FlowTone = inFlightProblem ? "disputed" : "paid";
  const worker: PlaceModel = {
    key: "worker",
    title: "Worker's PayPal",
    tone: workerTone,
    status: paidOut > 0 ? "current" : inFlight || payoutLeg.status === "moving" ? "incoming" : voided || terminal || zeroSplit ? "closed" : "possible",
    cents: paidOut > 0 ? paidOut : inFlight ? inFlightCents : voided || terminal || zeroSplit ? null : (split ?? amount),
    word:
      paidOut > 0
        ? "received"
        : inFlight
          ? `${inFlightProblem ? inFlightStatus!.toLowerCase() : "on its way"}${attempt > 1 ? ` · attempt ${attempt} of 3` : ""}`
          : abandoned
            ? "never arrived"
            : voided || terminal || (zeroSplit && agreed)
              ? "nothing paid"
              : zeroSplit
                ? "nothing, if both accept"
                : split !== null
                  ? ifSplit
                  : escalated
                  ? "if Treuhand decides so"
                  : "on a pass",
  };
  const backCents = (voided ? (voidRow?.amount_cents ?? amount) : 0) + refunded;
  const returned: PlaceModel = {
    key: "returned",
    title: "Back to payer",
    tone: "returned",
    status: backCents > 0 ? "current" : terminal ? "closed" : "possible",
    cents: backCents > 0 ? backCents : split !== null ? amount - split : null,
    word:
      backCents > 0
        ? voided
          ? "released · never charged"
          : abandoned
            ? "refunded in full"
            : "refunded"
        : terminal
          ? "nothing returned"
          : split !== null
            ? zeroSplit && agreed
              ? retried
                ? "release being retried"
                : "hold being released"
              : ifSplit
            : escalated
              ? "if Treuhand decides so"
              : captured
              ? "if the payout never arrives"
              : "if no pass",
  };

  const places = { payer, hold, capture: capturePlace, worker, returned };
  const nowPlaces = PLACE_ORDER.filter((k) => places[k].status === "current");
  return {
    currency,
    amount,
    places,
    legs: { fund, capture, payout: payoutLeg, release, refund },
    now: { places: nowPlaces, leg: payoutLeg.status === "moving" ? "payout" : null },
  };
}
