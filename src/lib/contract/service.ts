/**
 * The contract service: one function per business action, called by the
 * route handlers in src/app/api (docs/api.md is the HTTP contract). The
 * acting party is passed in by the caller (from the "view as" cookie); every
 * action checks it. State changes only through the machine (machine.ts);
 * every money action writes ledger rows and audit events (service-money.ts).
 *
 * The front end imports the response types from here with `import type`.
 */
import { draftContract, type DraftResult } from "@/lib/ai/drafter";
import { listConditions } from "@/lib/db/conditions";
import { createContract, getContract, listContracts } from "@/lib/db/contracts";
import { getActiveDispute, listDisputes } from "@/lib/db/disputes";
import { listEvents, recordEvent } from "@/lib/db/events";
import { getIdentity } from "@/lib/db/identities";
import { getDb } from "@/lib/db/index";
import { listLedgerEntries } from "@/lib/db/ledger";
import { listReceiptsForContract } from "@/lib/db/receipts";
import { listStepsForContract } from "@/lib/db/steps";
import { listSubmissions } from "@/lib/db/submissions";
import { listVerdictsForContract } from "@/lib/db/verdicts";
import { MissingEnvError, requirePayPalClientId } from "@/lib/env";
import { ensureTermsHash } from "@/lib/verifier/receipt";
import type { SignedReceipt } from "@/lib/verifier/receipt-core";
import type { ContractTrace } from "@/lib/verifier/trace-types";
import type {
  ClauseEvent,
  Condition,
  ConditionInput,
  Contract,
  ContractType,
  Dispute,
  Identity,
  LedgerEntry,
  Party,
  Submission,
  Verdict,
} from "@/lib/types";
import { ContractNotFoundError, editConditions, signOff } from "./machine";
import { type ClaimAction, liveClaim } from "./service-claims";
import { errorMessage, ServiceError, throwIfDenied } from "./service-errors";
import { lastPayoutStatus } from "./service-money";
import { allowedActions, signDenial, type AllowedAction } from "./service-rules";

export { ServiceError, type ServiceErrorCode } from "./service-errors";
export { ALLOWED_ACTIONS, type AllowedAction } from "./service-rules";
export type { ClaimAction } from "./service-claims";
export {
  confirmFunding,
  createFundingOrder,
  expireContract,
  runSweep,
  settlePass,
  settleSplit,
  type SweepError,
  type SweepResult,
} from "./service-money";
export { answerProposal, openDispute, respondToDispute, type AcceptResult } from "./service-dispute";
export { rerunVerification, submitWork, type VerificationJob } from "./service-verify";
export type { ReceiptBody, ReceiptVerdict, SignedReceipt } from "@/lib/verifier/receipt-core";
export type { VerifierPublicKey } from "@/lib/verifier/signing-key";
export type { ContractTrace, TraceFacts, TraceStep, TraceStepKind, TraceStepStatus } from "@/lib/verifier/trace-types";

// ---------------------------------------------------------------------------
// Response types (docs/api.md)
// ---------------------------------------------------------------------------

export interface VerificationStatus {
  status: "running" | "passed" | "failed" | "inconclusive" | "error";
  submission_id: string;
  /** Why it was inconclusive, what failed, or what errored. */
  message: string | null;
  at: string;
}

export interface ActivityStatus {
  /** The action holding the contract right now, if any. */
  in_progress: ClaimAction | null;
  /** The latest failed money or mediation step not followed by progress or a state change. */
  last_failure: null | { action: string; step: string; message: string; at: string };
}

export interface PayoutStatus {
  payout_batch_id: string;
  amount_cents: number;
  /** PayPal's payout item status (SUCCESS, PENDING, UNCLAIMED, FAILED, ...) or the batch status before the item has one. */
  status: string;
  at: string;
}

/**
 * A ledger row as the API returns it: without `raw`, the stored PayPal
 * response body, which can hold the payer's name, email and address.
 */
export type PublicLedgerEntry = Omit<LedgerEntry, "raw">;

export interface ContractDetail {
  contract: Contract;
  conditions: Condition[];
  submissions: Submission[];
  verdicts: Verdict[];
  ledger: PublicLedgerEntry[];
  events: ClauseEvent[];
  dispute: Dispute | null;
  /** The drafter's notes from when the contract was created from a draft. */
  notes: string[];
  viewer: { role: Party };
  allowed_actions: AllowedAction[];
  verification: VerificationStatus | null;
  activity: ActivityStatus;
  payout: PayoutStatus | null;
  /** (Addition) SHA-256 of the canonical agreed terms (src/lib/verifier/receipt-core.ts); null while DRAFT. */
  terms_sha256: string | null;
  /** (Addition) The newest signed verification receipt for this contract, if any run has finished. */
  receipt: SignedReceipt | null;
  /** (Addition) The verifier's work log, step by step, written while a run is in progress (src/lib/verifier/trace-types.ts). */
  trace: ContractTrace;
}

/** `GET /api/contracts/[id]/receipts`. */
export interface ContractReceipts {
  contract_id: string;
  terms_sha256: string | null;
  /** Newest first: one per finished verification run, re-runs included. */
  receipts: SignedReceipt[];
}

export type LedgerRow = PublicLedgerEntry & { contract_title: string; contract_state: Contract["state"]; currency: string };

function withoutRaw({ raw: _raw, ...entry }: LedgerEntry): PublicLedgerEntry {
  return entry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

function requireContract(contractId: string): Contract {
  const contract = getContract(contractId);
  if (!contract) throw new ContractNotFoundError(contractId);
  return contract;
}

function requirePayer(party: Party, what: string): void {
  if (party !== "payer") {
    throw new ServiceError("FORBIDDEN", `Only the payer can ${what}. You are viewing as the worker.`);
  }
}

function requireIdentities(): { payer: Identity; worker: Identity } {
  const payer = getIdentity("payer");
  const worker = getIdentity("worker");
  if (!payer || !worker) {
    throw new ServiceError("IDENTITIES_MISSING", "The demo identities are not seeded. Run `pnpm db:seed`.");
  }
  return { payer, worker };
}

// ---------------------------------------------------------------------------
// Drafting and creating
// ---------------------------------------------------------------------------

/** Turns the payer's plain-English deal into a proposed contract or a refusal (payer only). */
export async function draftFromPrompt(party: Party, prompt: string, type?: ContractType): Promise<DraftResult> {
  requirePayer(party, "draft a contract");
  const { payer, worker } = requireIdentities();
  try {
    return await draftContract({ prompt, type, payerEmail: payer.email, workerEmail: worker.email });
  } catch (err) {
    if (err instanceof MissingEnvError) throw err;
    throw new ServiceError("AI_ERROR", `The drafter failed: ${errorMessage(err)}`, { cause: err });
  }
}

/** A proposed contract with every term filled in (docs/api.md `POST /api/contracts`). */
export interface NewContractRequest {
  title: string;
  type: ContractType;
  amount_cents: number;
  currency: string;
  deadline_at: string;
  conditions: unknown[];
  notes: string[];
}

/**
 * Creates a DRAFT contract between the seeded payer and worker (payer only).
 * The deadline must be in the future. The drafter's notes are kept on the
 * audit trail and returned as `notes` by `getContractDetail`.
 */
export function createFromProposal(party: Party, input: NewContractRequest, now: Date = new Date()): Contract {
  requirePayer(party, "create a contract");
  const { payer, worker } = requireIdentities();
  if (Date.parse(input.deadline_at) <= now.getTime()) {
    throw new ServiceError("VALIDATION_ERROR", "deadline_at: the deadline must be in the future.");
  }
  return inTx(() => {
    const contract = createContract(
      {
        title: input.title,
        type: input.type,
        payer_email: payer.email,
        worker_email: worker.email,
        amount_cents: input.amount_cents,
        currency: input.currency,
        deadline_at: new Date(input.deadline_at).toISOString(),
        conditions: input.conditions as ConditionInput[],
      },
      party,
    );
    if (input.notes.length > 0) {
      recordEvent({ contract_id: contract.id, kind: "DRAFTER_NOTES", detail: { actor: "system", notes: input.notes } });
    }
    return contract;
  });
}

// ---------------------------------------------------------------------------
// Editing and signing (DRAFT)
// ---------------------------------------------------------------------------

/** Replaces a DRAFT contract's conditions (either party) and clears both sign-offs. */
export function editContractConditions(
  contractId: string,
  party: Party,
  conditions: unknown[],
): { contract: Contract; conditions: Condition[] } {
  const contract = editConditions(contractId, conditions as ConditionInput[], party);
  return { contract, conditions: listConditions(contractId) };
}

/**
 * Signs as `party`; the second signature moves the contract to SIGNED. Signing twice is a no-op.
 * A DRAFT past its deadline cannot be signed (DEADLINE_PASSED).
 */
export function signContract(contractId: string, party: Party, now: Date = new Date()): Contract {
  throwIfDenied(signDenial(requireContract(contractId), now));
  return signOff(contractId, party);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Newest first. */
export function listAllContracts(): Contract[] {
  return listContracts();
}

/** Every ledger entry, oldest first, with its contract's title, state and currency. */
export function listLedger(): LedgerRow[] {
  const contracts = new Map(listContracts().map((c) => [c.id, c]));
  return listLedgerEntries().map((entry) => {
    const contract = contracts.get(entry.contract_id)!;
    return { ...withoutRaw(entry), contract_title: contract.title, contract_state: contract.state, currency: contract.currency };
  });
}

/** The PayPal client id for the browser's checkout button. */
export function paypalConfig(): { paypalClientId: string } {
  return { paypalClientId: requirePayPalClientId() };
}

const VERIFICATION_EVENTS = new Set<ClauseEvent["kind"]>([
  "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED",
  "VERIFICATION_ERROR",
]);

function verificationStatus(
  contract: Contract,
  latest: Submission | null,
  events: ClauseEvent[],
  claim: ClaimAction | null,
): VerificationStatus | null {
  if (!latest) return null;
  const last = events.findLast((e) => VERIFICATION_EVENTS.has(e.kind) && e.detail.submission_id === latest.id);
  const base = { submission_id: latest.id, at: last?.created_at ?? latest.created_at };
  if (!last || last.kind === "VERIFICATION_STARTED") {
    if (claim === "verify") return { ...base, status: "running", message: null };
    if (contract.state !== "VERIFYING" && contract.state !== "SUBMITTED") return null;
    return { ...base, status: "error", message: "Verification was interrupted before it finished. Re-run it." };
  }
  if (last.kind === "VERIFICATION_ERROR") {
    return { ...base, status: "error", message: String(last.detail.message ?? "Verification crashed.") };
  }
  const outcome = last.detail.outcome;
  const status = outcome === "passed" || outcome === "failed" || outcome === "inconclusive" ? outcome : "error";
  return { ...base, status, message: typeof last.detail.message === "string" ? last.detail.message : null };
}

/** Events after which an earlier failure no longer describes the contract. */
const PROGRESS_EVENTS = new Set<ClauseEvent["kind"]>([
  "STATE_CHANGED",
  "ORDER_CREATED",
  "FUNDS_AUTHORIZED",
  "FUNDS_CAPTURED",
  "PAYOUT_SENT",
  "AUTHORIZATION_VOIDED",
  "REFUND_SENT",
  "DISPUTE_PROPOSED",
]);

function lastFailure(events: ClauseEvent[]): ActivityStatus["last_failure"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (PROGRESS_EVENTS.has(e.kind)) return null;
    if (e.kind === "PAYOUT_STATUS" && e.detail.status === "SUCCESS") return null;
    if (e.kind === "ACTION_FAILED") {
      return {
        action: String(e.detail.action),
        step: String(e.detail.step),
        message: String(e.detail.message),
        at: e.created_at,
      };
    }
  }
  return null;
}

function payoutStatus(contract: Contract, events: ClauseEvent[]): PayoutStatus | null {
  const batchId = contract.paypal_payout_batch_id;
  if (!batchId) return null;
  const sent = events.findLast((e) => e.kind === "PAYOUT_SENT" && e.detail.payout_batch_id === batchId);
  const latest = events.findLast(
    (e) => (e.kind === "PAYOUT_SENT" || e.kind === "PAYOUT_STATUS") && e.detail.payout_batch_id === batchId,
  );
  const ledger = listLedgerEntries({ contract_id: contract.id }).find(
    (e) => e.kind === "PAID_OUT" && e.paypal_ref === batchId,
  );
  return {
    payout_batch_id: batchId,
    amount_cents: Number(sent?.detail.amount_cents ?? ledger?.amount_cents ?? contract.amount_cents),
    status: ledger ? "SUCCESS" : (lastPayoutStatus(contract.id, batchId) ?? "PENDING"),
    at: latest?.created_at ?? contract.updated_at,
  };
}

/** Everything the contract page shows, with the viewer's allowed actions derived by the service's own rules. */
export function getContractDetail(contractId: string, party: Party, now: Date = new Date()): ContractDetail {
  const contract = requireContract(contractId);
  const conditions = listConditions(contractId);
  const submissions = listSubmissions(contractId);
  const events = listEvents(contractId);
  const claim = liveClaim(contractId, now)?.action ?? null;
  const notesEvent = events.find((e) => e.kind === "DRAFTER_NOTES");
  return {
    contract,
    conditions,
    submissions,
    verdicts: listVerdictsForContract(contractId),
    ledger: listLedgerEntries({ contract_id: contractId }).map(withoutRaw),
    events,
    dispute: listDisputes(contractId).at(-1) ?? null,
    notes: Array.isArray(notesEvent?.detail.notes) ? notesEvent.detail.notes.map(String) : [],
    viewer: { role: party },
    allowed_actions: allowedActions(
      {
        contract,
        conditionCount: conditions.length,
        dispute: getActiveDispute(contractId),
        busy: claim !== null,
        now,
      },
      party,
    ),
    verification: verificationStatus(contract, submissions[0] ?? null, events, claim),
    activity: { in_progress: claim, last_failure: lastFailure(events) },
    payout: payoutStatus(contract, events),
    terms_sha256: ensureTermsHash(contractId),
    receipt: listReceiptsForContract(contractId)[0] ?? null,
    trace: { now: now.toISOString(), steps: listStepsForContract(contractId) },
  };
}

/** Every signed verification receipt for the contract, newest first, with its terms hash. */
export function getContractReceipts(contractId: string): ContractReceipts {
  requireContract(contractId);
  return {
    contract_id: contractId,
    terms_sha256: ensureTermsHash(contractId),
    receipts: listReceiptsForContract(contractId),
  };
}
