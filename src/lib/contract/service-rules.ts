/**
 * Who may do what, and when. Pure functions over loaded rows, shared by the
 * service (which throws on a denial) and `allowedActions` (which tells the
 * page which buttons to show), so the two can never disagree.
 * State legality itself is still enforced by the machine on every transition.
 */
import type { Contract, ContractState, Dispute, Party } from "@/lib/types";
import type { Denial } from "./service-errors";

export const ALLOWED_ACTIONS = [
  "edit_conditions",
  "sign",
  "fund",
  "submit",
  "rerun_verification",
  "dispute",
  "respond",
  "accept",
  "decline",
] as const;
export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

const PARTY_LABEL: Record<Party, string> = { payer: "payer", worker: "worker" };

function requireParty(party: Party, required: Party, what: string): Denial {
  return party === required
    ? null
    : { code: "FORBIDDEN", message: `Only the ${PARTY_LABEL[required]} can ${what}. You are viewing as the ${PARTY_LABEL[party]}.` };
}

function requireState(contract: Contract, allowed: readonly ContractState[], what: string): Denial {
  return allowed.includes(contract.state)
    ? null
    : {
        code: "ILLEGAL_TRANSITION",
        message: `Cannot ${what} while the contract is ${contract.state} (allowed: ${allowed.join(", ")}).`,
      };
}

function requireBeforeDeadline(contract: Contract, now: Date, what: string): Denial {
  return now.getTime() < Date.parse(contract.deadline_at)
    ? null
    : { code: "DEADLINE_PASSED", message: `Cannot ${what}: the deadline (${contract.deadline_at}) has passed.` };
}

function first(...denials: Denial[]): Denial {
  return denials.find((d) => d !== null) ?? null;
}

/** A draft not signed by its deadline lapses: signed, it could never be funded or expired. */
export function signDenial(contract: Contract, now: Date): Denial {
  return contract.state === "DRAFT" ? requireBeforeDeadline(contract, now, "sign") : null;
}

export function fundDenial(contract: Contract, party: Party, now: Date): Denial {
  return first(
    requireParty(party, "payer", "fund the contract"),
    requireState(contract, ["SIGNED"], "fund the contract"),
    requireBeforeDeadline(contract, now, "fund the contract"),
  );
}

export function submitDenial(contract: Contract, party: Party, now: Date): Denial {
  return first(
    requireParty(party, "worker", "submit work"),
    requireState(contract, ["FUNDED", "FAILED"], "submit work"),
    requireBeforeDeadline(contract, now, "submit work"),
  );
}

/** After the deadline a new run could still lead to payment; the sweep expires the contract instead. */
export function rerunVerificationDenial(contract: Contract, now: Date): Denial {
  return first(
    requireState(contract, ["VERIFYING"], "re-run verification"),
    requireBeforeDeadline(contract, now, "re-run verification"),
  );
}

/**
 * VERIFYING is allowed because a contract may not be stranded there: callers
 * check that no verification run holds the contract, and a VERIFYING contract
 * no run holds has a latest run that ended without a verdict (inconclusive,
 * crashed or interrupted), since a pass or fail leaves VERIFYING in the same
 * transaction that records it.
 */
export function openDisputeDenial(contract: Contract): Denial {
  return first(
    requireState(contract, ["FUNDED", "FAILED", "PASSED", "VERIFYING"], "open a dispute"),
    contract.paypal_capture_id
      ? { code: "ILLEGAL_TRANSITION", message: "Cannot open a dispute: the payout has already started." }
      : null,
  );
}

function requireDispute(dispute: Dispute | null): Denial {
  return dispute ? null : { code: "NOT_FOUND", message: "This contract has no open dispute." };
}

export function argueDenial(dispute: Dispute | null): Denial {
  return first(
    requireDispute(dispute),
    dispute && dispute.state !== "OPEN"
      ? { code: "DISPUTE_STATE", message: `The dispute is ${dispute.state}; arguments can only be added while it is OPEN.` }
      : null,
  );
}

function bothAccepted(dispute: Dispute): boolean {
  return dispute.payer_accepted === true && dispute.worker_accepted === true;
}

export function acceptDenial(dispute: Dispute | null): Denial {
  return first(
    requireDispute(dispute),
    dispute && dispute.state !== "PROPOSED"
      ? { code: "DISPUTE_STATE", message: `The dispute is ${dispute.state}; there is no proposal to accept yet.` }
      : null,
  );
}

export function declineDenial(dispute: Dispute | null, party: Party): Denial {
  const accepted = party === "payer" ? dispute?.payer_accepted : dispute?.worker_accepted;
  return first(
    acceptDenial(dispute),
    accepted === true
      ? { code: "DISPUTE_STATE", message: "You have already accepted this proposal." }
      : null,
  );
}

/** Both parties accepted the mediator's proposal: the split can be settled. */
export function isSplitAgreed(dispute: Dispute | null): dispute is Dispute & { proposed_worker_cents: number } {
  return !!dispute && dispute.state === "PROPOSED" && dispute.proposed_worker_cents !== null && bothAccepted(dispute);
}

/**
 * VERIFYING: see `openDisputeDenial`; `expireContract` claims the contract, so a run in progress answers BUSY.
 * DISPUTED and ESCALATED: a dispute nobody finishes must not hold the money forever, so past the
 * deadline the hold is voided unless both parties accepted a split (`dispute` is the active one).
 */
export function expireDenial(contract: Contract, now: Date, dispute: Dispute | null = null): Denial {
  return first(
    requireState(contract, ["FUNDED", "FAILED", "VERIFYING", "DISPUTED", "ESCALATED"], "expire the contract"),
    now.getTime() >= Date.parse(contract.deadline_at)
      ? null
      : { code: "ILLEGAL_TRANSITION", message: "Cannot expire the contract before its deadline." },
    contract.paypal_authorization_id && !contract.paypal_capture_id
      ? null
      : { code: "ILLEGAL_TRANSITION", message: "Cannot expire: there is no uncaptured authorization to void." },
    isSplitAgreed(dispute)
      ? { code: "ILLEGAL_TRANSITION", message: "Cannot expire: both parties accepted a split, which is being settled." }
      : null,
  );
}

/** `passedAt` is when the contract last entered PASSED. */
export function settlePassDenial(contract: Contract, passedAt: string | null, windowSeconds: number, now: Date): Denial {
  return first(
    requireState(contract, ["PASSED"], "pay out"),
    contract.paypal_authorization_id
      ? null
      : { code: "ILLEGAL_TRANSITION", message: "Cannot pay out: no PayPal authorization is recorded." },
    passedAt && now.getTime() >= Date.parse(passedAt) + windowSeconds * 1000
      ? null
      : { code: "ILLEGAL_TRANSITION", message: "Cannot pay out yet: the contest window is still open." },
  );
}

export interface ActionContext {
  contract: Contract;
  conditionCount: number;
  /** The active (OPEN or PROPOSED) dispute, if any. */
  dispute: Dispute | null;
  /** Another action holds the contract's claim. */
  busy: boolean;
  now: Date;
}

/** What `party` may do right now, by the same rules the service enforces. */
export function allowedActions(ctx: ActionContext, party: Party): AllowedAction[] {
  const { contract, dispute, now } = ctx;
  const actions: AllowedAction[] = [];
  if (contract.state === "DRAFT") {
    actions.push("edit_conditions");
    const signed = party === "payer" ? contract.payer_signed_at : contract.worker_signed_at;
    if (!signed && ctx.conditionCount > 0 && !signDenial(contract, now)) actions.push("sign");
  }
  if (ctx.busy) return actions;
  if (!fundDenial(contract, party, now)) actions.push("fund");
  if (!submitDenial(contract, party, now)) actions.push("submit");
  if (!rerunVerificationDenial(contract, now)) actions.push("rerun_verification");
  if (!openDisputeDenial(contract)) actions.push("dispute");
  if (contract.state === "DISPUTED" && dispute) {
    const own = party === "payer" ? dispute.payer_argument : dispute.worker_argument;
    const bothArgued = dispute.payer_argument !== null && dispute.worker_argument !== null;
    // Respond to add your argument, or to retry mediation after it failed.
    if (!argueDenial(dispute) && (own === null || bothArgued)) actions.push("respond");
    const accepted = party === "payer" ? dispute.payer_accepted : dispute.worker_accepted;
    // Not offered again to a party who accepted: a split settlement that failed part-way is
    // resumed by the sweep (accepting again over the API also resumes it; answerProposal).
    if (!acceptDenial(dispute) && accepted !== true) actions.push("accept");
    if (!declineDenial(dispute, party) && !isSplitAgreed(dispute)) actions.push("decline");
  }
  return actions;
}
