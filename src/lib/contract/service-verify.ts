/**
 * Submitting work and verifying it. The worker's submission moves the
 * contract SUBMITTED -> VERIFYING in the request; the verifier then runs in
 * the background (the route schedules `job.run` after the response) under the
 * contract's "verify" claim, and the result moves it to PASSED or FAILED. An
 * inconclusive run (a check could not complete) or a crashed run is neither:
 * the contract stays VERIFYING and either party can re-run verification or
 * open a dispute, and past the deadline the sweep expires it (voids the
 * hold), so no contract is stranded there. A run in progress holds the claim
 * (refreshed while it runs), so neither can interrupt it.
 * Nothing in the background is lost: every outcome, including a crash, is
 * written to the audit trail. Each finished run also gets a signed receipt
 * (src/lib/verifier/receipt.ts); settlement never reads it. On a code bounty,
 * when the operator opted in, the finished run's verdict is then posted on
 * the pull request (src/lib/contract/service-pr-comment.ts), also a record
 * only.
 */
import { contestWindowSeconds, MissingEnvError } from "@/lib/env";
import { recordEvent } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { createSubmission, getLatestSubmission } from "@/lib/db/submissions";
import { verifySubmission, type VerificationOutcome, type VerificationResult } from "@/lib/verifier";
import { issueReceipt } from "@/lib/verifier/receipt";
import { SIGNATURE_ALGORITHM } from "@/lib/verifier/receipt-core";
import { runWithTrace, step } from "@/lib/verifier/trace";
import type { Party } from "@/lib/types";
import { transition } from "./machine";
import { acquireClaim, keepClaimAlive, releaseClaim, type Claim } from "./service-claims";
import { errorMessage, ServiceError, throwIfDenied } from "./service-errors";
import { recordFailure, settlePass } from "./service-money";
import { commentOnPullRequest, type FinishedRun } from "./service-pr-comment";
import { rerunVerificationDenial, submitDenial } from "./service-rules";

function inTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

/** A verification run the caller must start (after the HTTP response): `run()` never throws. */
export interface VerificationJob {
  contractId: string;
  submissionId: string;
  run: () => Promise<void>;
}

/**
 * Records the worker's submission (worker only, FUNDED or FAILED, before the
 * deadline) and moves the contract to VERIFYING. Returns the job that runs
 * the verifier; until it finishes the contract stays claimed ("verify").
 */
export function submitWork(contractId: string, party: Party, url: string, now: Date = new Date()): VerificationJob {
  const claim = acquireClaim(contractId, "verify", (c) => throwIfDenied(submitDenial(c, party, now)), now);
  try {
    const submission = inTx(() => {
      const created = createSubmission({ contract_id: contractId, url });
      transition(contractId, "SUBMITTED", { actor: party, detail: { submission_id: created.id } });
      recordEvent({
        contract_id: contractId,
        kind: "SUBMISSION_RECEIVED",
        detail: { actor: party, submission_id: created.id, url },
      });
      transition(contractId, "VERIFYING", { actor: "system", detail: { submission_id: created.id } });
      recordEvent({
        contract_id: contractId,
        kind: "VERIFICATION_STARTED",
        detail: { actor: "system", submission_id: created.id, rerun: false },
      });
      return created;
    });
    return { contractId, submissionId: submission.id, run: () => runVerification(claim, submission.id) };
  } catch (err) {
    releaseClaim(claim);
    throw err;
  }
}

/**
 * Re-runs verification of the latest submission (either party) when the
 * contract is still VERIFYING after an inconclusive, crashed or interrupted
 * run, before the deadline. A run in progress holds the claim, so this
 * answers BUSY meanwhile.
 */
export function rerunVerification(contractId: string, party: Party, now: Date = new Date()): VerificationJob {
  const claim = acquireClaim(
    contractId,
    "verify",
    (c) => {
      throwIfDenied(rerunVerificationDenial(c, now));
      if (!getLatestSubmission(contractId)) {
        throw new ServiceError("NOT_FOUND", "There is no submission to verify.");
      }
    },
    now,
  );
  try {
    const submission = getLatestSubmission(contractId)!;
    recordEvent({
      contract_id: contractId,
      kind: "VERIFICATION_STARTED",
      detail: { actor: party, submission_id: submission.id, rerun: true },
    });
    return { contractId, submissionId: submission.id, run: () => runVerification(claim, submission.id) };
  } catch (err) {
    releaseClaim(claim);
    throw err;
  }
}

/**
 * What a verifier result means for the contract, and why (for the page). A
 * pass needs both `outcome` and `allPassed`; a result where they disagree is
 * treated as inconclusive, so no money moves on it.
 */
export function outcomeOf(result: VerificationResult): { outcome: VerificationOutcome; message: string | null } {
  if (result.outcome === "passed" && result.allPassed) return { outcome: "passed", message: null };
  if (result.outcome === "failed") {
    const notPassed = result.verdicts.filter((v) => !v.passed).length;
    return { outcome: "failed", message: `${notPassed} of ${result.verdicts.length} checks did not pass.` };
  }
  const reasons = result.inconclusive.map((i) => i.reason).filter(Boolean);
  return {
    outcome: "inconclusive",
    message: reasons.length > 0 ? reasons.join(" ") : "A check could not complete.",
  };
}

/**
 * Issues the run's signed receipt (src/lib/verifier/receipt.ts) and returns
 * what the VERIFICATION_COMPLETED event records about it, recording the
 * signing as a run-level step of the work log. Never throws: a receipt is a
 * record, not a gate, so if it cannot be issued the outcome stands and the
 * event says why there is no receipt.
 */
async function receiptFor(
  submissionId: string,
  outcome: VerificationOutcome,
  result: VerificationResult,
  startedAt: Date,
): Promise<{ receipt_sha256: string } | { receipt_error: string }> {
  const traced = await runWithTrace(submissionId, null, () =>
    step(
      "record",
      "Sign the verification receipt",
      async (h): Promise<{ receipt_sha256: string } | { receipt_error: string }> => {
        try {
          const signed = await issueReceipt({ submissionId, outcome, verdicts: result.verdicts, startedAt, finishedAt: new Date() });
          h.detail({ receipt_sha256: signed.receipt_sha256.slice(0, 12), issued: true });
          return { receipt_sha256: signed.receipt_sha256 };
        } catch (err) {
          console.error(`the verification receipt for submission ${submissionId} could not be issued`, err);
          h.detail({ issued: false, problem: errorMessage(err) });
          h.fail();
          return { receipt_error: errorMessage(err) };
        }
      },
      { algorithm: SIGNATURE_ALGORITHM, verdicts: result.verdicts.length },
    ),
  );
  return traced.value;
}

function recordVerificationError(contractId: string, submissionId: string, err: unknown): void {
  try {
    recordEvent({
      contract_id: contractId,
      kind: "VERIFICATION_ERROR",
      detail: { actor: "system", submission_id: submissionId, message: errorMessage(err) },
    });
  } catch (writeErr) {
    // The database itself failed: the log is the last place left to record it.
    console.error(`verification of submission ${submissionId} failed and could not be recorded`, err, writeErr);
  }
}

/**
 * Runs the verifier, applies its outcome, releases the claim, (with a 0
 * contest window) settles a pass at once, and then comments on the pull
 * request if that is enabled. Never throws: every result, including a crash,
 * is written to the contract's audit trail. A crashed run posts nothing.
 */
async function runVerification(claim: Claim, submissionId: string): Promise<void> {
  const { contractId } = claim;
  let finished: FinishedRun | null = null;
  const stopRefreshing = keepClaimAlive(claim);
  try {
    const startedAt = new Date();
    const result = await verifySubmission(submissionId);
    const { outcome, message } = outcomeOf(result);
    const receipt = await receiptFor(submissionId, outcome, result, startedAt);
    inTx(() => {
      recordEvent({
        contract_id: contractId,
        kind: "VERIFICATION_COMPLETED",
        detail: {
          actor: "system",
          submission_id: submissionId,
          outcome,
          message,
          verdict_ids: result.verdicts.map((v) => v.id),
          ...receipt,
        },
      });
      if (outcome === "passed") transition(contractId, "PASSED", { actor: "system", detail: { submission_id: submissionId } });
      if (outcome === "failed") transition(contractId, "FAILED", { actor: "system", detail: { submission_id: submissionId } });
    });
    finished = { contractId, submissionId, outcome, verdicts: result.verdicts, receipt };
  } catch (err) {
    recordVerificationError(contractId, submissionId, err);
  } finally {
    stopRefreshing();
    releaseClaim(claim);
  }

  if (!finished) return;
  if (finished.outcome === "passed") {
    try {
      if (contestWindowSeconds() === 0) await settlePass(contractId);
    } catch (err) {
      // PayPal steps record their own failures (and the sweep retries them);
      // a denial (e.g. a dispute was opened meanwhile) is not a failure.
      if (!(err instanceof ServiceError || err instanceof MissingEnvError)) recordFailure(contractId, "settle_pass", "settle", err);
    }
  }
  // After the claim is released and a pass settled: the comment is a record, never a gate.
  await commentOnPullRequest(finished);
}
