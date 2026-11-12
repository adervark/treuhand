/**
 * The contract state machine. This module is the
 * only code that writes `contracts.state`, the sign-off columns, terms after
 * creation, or conditions after creation. Every state change writes an
 * `events` row in the same SQLite transaction.
 *
 *   DRAFT -> SIGNED -> FUNDED -> SUBMITTED -> VERIFYING -> PASSED -> PAID
 *                        |            ^           |
 *                        |            +-- FAILED -+   (worker may resubmit)
 *                        +-> EXPIRED (authorization voided)
 *   FUNDED/FAILED/PASSED -> DISPUTED -> SETTLED (split) | ESCALATED (human)
 *
 * Choices beyond the diagram: FAILED -> EXPIRED (deadline passes after a
 * failed attempt) and ESCALATED -> SETTLED (the human decides the split).
 * VERIFYING -> DISPUTED and VERIFYING -> EXPIRED, so no contract is stranded
 * in VERIFYING: taken only when the latest verification run ended without a
 * verdict and no run is in progress; the service enforces that.
 * DISPUTED -> EXPIRED and ESCALATED -> EXPIRED: the deadline passed with no
 * split accepted by both parties and nothing captured; the hold is voided.
 * PASSED -> SETTLED: every payout attempt came back from PayPal and the payer
 * was refunded in full (a zero worker share).
 */
import { getContract, PAYPAL_REF_COLUMNS } from "@/lib/db/contracts";
import { listConditions, parseConditionsForType, replaceConditionRows } from "@/lib/db/conditions";
import { recordEvent } from "@/lib/db/events";
import { buildSetClause, getDb, nowIso } from "@/lib/db/index";
import { setTermsHashOnce } from "@/lib/db/receipts";
import { listSubmissions } from "@/lib/db/submissions";
import { termsSha256 } from "@/lib/verifier/receipt-core";
import {
  ContractTermsPatchSchema,
  type Actor,
  type ConditionInput,
  type Contract,
  type ContractState,
  type ContractTermsPatch,
  type Party,
  type PaypalRefs,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContractMachineError extends Error {
  readonly code: "NOT_FOUND" | "ILLEGAL_TRANSITION" | "CONTRACT_LOCKED" = "ILLEGAL_TRANSITION";
  constructor(
    message: string,
    readonly contractId: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ContractNotFoundError extends ContractMachineError {
  override readonly code = "NOT_FOUND";
  constructor(contractId: string) {
    super(`contract ${contractId} not found`, contractId);
  }
}

export class IllegalTransitionError extends ContractMachineError {
  override readonly code = "ILLEGAL_TRANSITION";
  constructor(
    contractId: string,
    readonly from: ContractState,
    readonly to: ContractState,
    readonly reason: string,
  ) {
    super(`contract ${contractId}: cannot go ${from} -> ${to}: ${reason}`, contractId);
  }
}

/** Terms and conditions are immutable once the contract leaves DRAFT. */
export class ContractLockedError extends ContractMachineError {
  override readonly code = "CONTRACT_LOCKED";
  constructor(
    contractId: string,
    readonly state: ContractState,
  ) {
    super(`contract ${contractId} is ${state}: terms and conditions can only change in DRAFT`, contractId);
  }
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

export const TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = {
  DRAFT: ["SIGNED"],
  SIGNED: ["FUNDED"],
  FUNDED: ["SUBMITTED", "EXPIRED", "DISPUTED"],
  SUBMITTED: ["VERIFYING"],
  VERIFYING: ["PASSED", "FAILED", "DISPUTED", "EXPIRED"],
  PASSED: ["PAID", "DISPUTED", "SETTLED"],
  FAILED: ["SUBMITTED", "EXPIRED", "DISPUTED"],
  PAID: [],
  EXPIRED: [],
  DISPUTED: ["SETTLED", "ESCALATED", "EXPIRED"],
  SETTLED: [],
  ESCALATED: ["SETTLED", "EXPIRED"],
};

export function allowedTransitions(from: ContractState): readonly ContractState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ContractState, to: ContractState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ContractState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * Preconditions checked on top of the table, against the contract as it will
 * be after the transition (so PayPal refs passed with the call count).
 * Returns the reason the transition is blocked, or null.
 */
function guard(contract: Contract, to: ContractState): string | null {
  switch (to) {
    case "SIGNED":
      if (!contract.payer_signed_at || !contract.worker_signed_at) return "both parties must sign off";
      if (listConditions(contract.id).length === 0) return "contract has no conditions";
      return null;
    case "FUNDED":
      return contract.paypal_authorization_id || contract.paypal_capture_id
        ? null
        : "no PayPal authorization or capture recorded";
    case "SUBMITTED":
      return listSubmissions(contract.id).length > 0 ? null : "no submission recorded";
    case "PAID":
      return contract.paypal_payout_batch_id ? null : "no PayPal payout recorded";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  actor: Actor;
  /** PayPal references written in the same DB transaction as the state change. */
  paypal?: Partial<PaypalRefs>;
  /** Extra context stored on the STATE_CHANGED event. */
  detail?: Record<string, unknown>;
}

function load(contractId: string): Contract {
  const contract = getContract(contractId);
  if (!contract) throw new ContractNotFoundError(contractId);
  return contract;
}

function transitionInTx(contractId: string, to: ContractState, opts: TransitionOptions): Contract {
  const db = getDb();
  const current = load(contractId);
  const from = current.state;
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(contractId, from, to, "not an allowed transition");
  }
  const paypal = opts.paypal ?? {};
  const blocked = guard({ ...current, ...stripUndefined(paypal) }, to);
  if (blocked) throw new IllegalTransitionError(contractId, from, to, blocked);

  const refsSet = buildSetClause(paypal, PAYPAL_REF_COLUMNS);
  const result = db
    .prepare(
      `UPDATE contracts SET state = @to, updated_at = @ts${refsSet ? `, ${refsSet}` : ""}
       WHERE id = @id AND state = @from`,
    )
    .run({ ...paypal, to, from, ts: nowIso(), id: contractId });
  if (result.changes !== 1) {
    throw new IllegalTransitionError(contractId, from, to, "state changed concurrently");
  }
  recordEvent({
    contract_id: contractId,
    kind: "STATE_CHANGED",
    detail: { ...opts.detail, from, to, actor: opts.actor, ...(refsSet ? { paypal } : {}) },
  });
  return load(contractId);
}

/** Moves a contract to `to`. Throws IllegalTransitionError if the move is not allowed. */
export function transition(contractId: string, to: ContractState, opts: TransitionOptions): Contract {
  return getDb().transaction(() => transitionInTx(contractId, to, opts)).immediate();
}

/**
 * Records one party's sign-off on a DRAFT. When the second party signs, the
 * contract moves to SIGNED in the same DB transaction. Signing twice is a no-op.
 */
export function signOff(contractId: string, party: Party): Contract {
  return getDb()
    .transaction(() => {
      const contract = load(contractId);
      if (contract.state !== "DRAFT") {
        throw new IllegalTransitionError(contractId, contract.state, "SIGNED", "sign-off is only possible in DRAFT");
      }
      if (listConditions(contractId).length === 0) {
        throw new IllegalTransitionError(contractId, "DRAFT", "SIGNED", "contract has no conditions");
      }
      const column = party === "payer" ? "payer_signed_at" : "worker_signed_at";
      if (contract[column]) return contract;

      const ts = nowIso();
      getDb()
        .prepare(`UPDATE contracts SET ${column} = @ts, updated_at = @ts WHERE id = @id`)
        .run({ ts, id: contractId });
      recordEvent({ contract_id: contractId, kind: "SIGNED_OFF", detail: { actor: party, party } });

      const signed = load(contractId);
      if (signed.payer_signed_at && signed.worker_signed_at) {
        // What both parties agreed, fixed at the moment of signing (receipts cite it).
        const terms_sha256 = termsSha256({ contract: signed, conditions: listConditions(contractId) });
        const result = transitionInTx(contractId, "SIGNED", { actor: party, detail: { terms_sha256 } });
        setTermsHashOnce(contractId, terms_sha256);
        return result;
      }
      return signed;
    })
    .immediate();
}

/** Clears both sign-offs; records SIGNOFFS_CLEARED if any were set. Caller holds the transaction. */
function clearSignOffs(contract: Contract, actor: Actor, cause: string): void {
  if (!contract.payer_signed_at && !contract.worker_signed_at) return;
  getDb()
    .prepare(`UPDATE contracts SET payer_signed_at = NULL, worker_signed_at = NULL WHERE id = ?`)
    .run(contract.id);
  recordEvent({ contract_id: contract.id, kind: "SIGNOFFS_CLEARED", detail: { actor, cause } });
}

function loadDraft(contractId: string): Contract {
  const contract = load(contractId);
  if (contract.state !== "DRAFT") throw new ContractLockedError(contractId, contract.state);
  return contract;
}

/**
 * Replaces a DRAFT contract's conditions and clears both sign-offs.
 * Throws ContractLockedError once the contract has left DRAFT.
 */
export function editConditions(contractId: string, conditions: ConditionInput[], actor: Actor): Contract {
  return getDb()
    .transaction(() => {
      const contract = loadDraft(contractId);
      const parsed = parseConditionsForType(contract.type, conditions);
      replaceConditionRows(contractId, parsed);
      getDb().prepare(`UPDATE contracts SET updated_at = ? WHERE id = ?`).run(nowIso(), contractId);
      clearSignOffs(contract, actor, "conditions edited");
      recordEvent({ contract_id: contractId, kind: "CONDITIONS_EDITED", detail: { actor, count: parsed.length } });
      return load(contractId);
    })
    .immediate();
}

const TERM_COLUMNS = [
  "title",
  "type",
  "payer_email",
  "worker_email",
  "amount_cents",
  "currency",
  "deadline_at",
] as const satisfies readonly (keyof ContractTermsPatch)[];

/**
 * Edits a DRAFT contract's terms (title, parties, amount, deadline, type) and
 * clears both sign-offs, since a party signed the old terms.
 * Throws ContractLockedError once the contract has left DRAFT.
 */
export function editTerms(contractId: string, patch: ContractTermsPatch, actor: Actor): Contract {
  return getDb()
    .transaction(() => {
      const contract = loadDraft(contractId);
      const terms = stripUndefined(ContractTermsPatchSchema.parse(patch));
      const set = buildSetClause(terms, TERM_COLUMNS);
      if (!set) return contract;
      if (terms.type && terms.type !== contract.type) {
        // Existing conditions must still be valid for the new type.
        parseConditionsForType(terms.type, listConditions(contractId));
      }
      getDb()
        .prepare(`UPDATE contracts SET ${set}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...terms, updated_at: nowIso(), id: contractId });
      clearSignOffs(contract, actor, "terms edited");
      recordEvent({ contract_id: contractId, kind: "TERMS_EDITED", detail: { actor, fields: Object.keys(terms) } });
      return load(contractId);
    })
    .immediate();
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
