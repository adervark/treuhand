/**
 * Per-contract action claim: the first line of defence against double
 * settlement. An action that awaits PayPal, the verifier or the mediator
 * claims the contract in an IMMEDIATE SQLite transaction (together with its
 * state preconditions) before its first await, and releases it when done.
 * A second request for any claimed action on the same contract gets BUSY.
 *
 * Synchronous actions that must not interleave with a claimed one (opening a
 * dispute, accepting a proposal) call `assertUnclaimed` inside their own
 * transaction instead of claiming.
 *
 * A claim older than CLAIM_STALE_MS is treated as abandoned (the process died
 * mid-action) and can be taken over. Taking over is safe for money because
 * each step first checks what is already recorded on the contract and the
 * ledger, and PayPal calls carry idempotency keys (src/lib/paypal).
 */
import { getContract } from "@/lib/db/contracts";
import { getDb, newId } from "@/lib/db/index";
import { ContractNotFoundError } from "./machine";
import { ServiceError } from "./service-errors";
import type { Contract } from "@/lib/types";

export const CLAIM_ACTIONS = ["fund", "verify", "settle_pass", "expire", "mediate", "settle_split"] as const;
export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

export const CLAIM_STALE_MS = 10 * 60 * 1000;

export interface Claim {
  contractId: string;
  action: ClaimAction;
  token: string;
}

export interface ClaimInfo {
  action: ClaimAction;
  claimed_at: string;
}

type ClaimRow = { claim_action: ClaimAction | null; claim_token: string | null; claimed_at: string | null };

function readClaim(contractId: string): ClaimRow | undefined {
  return getDb()
    .prepare(`SELECT claim_action, claim_token, claimed_at FROM contracts WHERE id = ?`)
    .get(contractId) as ClaimRow | undefined;
}

/** The claim currently held on a contract, ignoring stale ones. */
export function liveClaim(contractId: string, now: Date = new Date()): ClaimInfo | null {
  const row = readClaim(contractId);
  if (!row?.claim_token || !row.claim_action || !row.claimed_at) return null;
  if (now.getTime() - Date.parse(row.claimed_at) >= CLAIM_STALE_MS) return null;
  return { action: row.claim_action, claimed_at: row.claimed_at };
}

const BUSY_MESSAGE: Record<ClaimAction, string> = {
  fund: "A PayPal funding step is already running for this contract.",
  verify: "Verification is already running for this contract.",
  settle_pass: "The payout is already being processed for this contract.",
  expire: "The hold is already being released for this contract.",
  mediate: "The mediator is already working on this dispute.",
  settle_split: "The dispute settlement is already being processed.",
};

/** Throws BUSY if another action holds the contract. Call inside a transaction. */
export function assertUnclaimed(contractId: string, now: Date = new Date()): void {
  const claim = liveClaim(contractId, now);
  if (claim) throw new ServiceError("BUSY", `${BUSY_MESSAGE[claim.action]} Try again in a moment.`);
}

/**
 * Atomically checks that the contract is free, runs `precheck` (which throws
 * to refuse), and claims the contract for `action`. Claims live in real
 * time: the claim is stamped, and an existing one judged stale, by the clock
 * at acquisition, never by the caller's `now` (a long sweep's start time
 * would stamp a claim that is stale the moment it is taken). The caller's
 * clock (`_now`, unused here) belongs in `precheck`'s business rules.
 */
export function acquireClaim(
  contractId: string,
  action: ClaimAction,
  precheck: (contract: Contract) => void,
  _now: Date = new Date(),
): Claim {
  const db = getDb();
  return db
    .transaction(() => {
      const contract = getContract(contractId);
      if (!contract) throw new ContractNotFoundError(contractId);
      const at = new Date();
      assertUnclaimed(contractId, at);
      precheck(contract);
      const token = newId();
      db.prepare(`UPDATE contracts SET claim_action = ?, claim_token = ?, claimed_at = ? WHERE id = ?`).run(
        action,
        token,
        at.toISOString(),
        contractId,
      );
      return { contractId, action, token };
    })
    .immediate();
}

/** Releases the claim if this holder still owns it (a stale takeover changes the token). */
export function releaseClaim(claim: Claim): void {
  getDb()
    .prepare(
      `UPDATE contracts SET claim_action = NULL, claim_token = NULL, claimed_at = NULL
       WHERE id = ? AND claim_token = ?`,
    )
    .run(claim.contractId, claim.token);
}

/**
 * Refreshes `claimed_at` every `everyMs` while the holder still owns the
 * claim, so a run that outlasts CLAIM_STALE_MS (a verification of many
 * checks) is never taken for abandoned and interrupted by a dispute, an
 * expiry or a second run. If the process dies the refreshes stop and the
 * claim goes stale as before. Returns the function that stops refreshing.
 */
export function keepClaimAlive(claim: Claim, everyMs = CLAIM_STALE_MS / 5): () => void {
  const timer = setInterval(() => {
    try {
      getDb()
        .prepare(`UPDATE contracts SET claimed_at = ? WHERE id = ? AND claim_token = ?`)
        .run(new Date().toISOString(), claim.contractId, claim.token);
    } catch (err) {
      console.error(`could not refresh the ${claim.action} claim on contract ${claim.contractId}`, err);
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Claims the contract, runs `fn`, and always releases the claim. */
export async function withClaim<T>(
  contractId: string,
  action: ClaimAction,
  precheck: (contract: Contract) => void,
  fn: (contract: Contract) => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const claim = acquireClaim(contractId, action, precheck, now);
  try {
    return await fn(getContract(contractId)!);
  } finally {
    releaseClaim(claim);
  }
}
