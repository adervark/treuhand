/**
 * Verifier: runs each condition's check against a submission
 * and stores one verdict per condition with its evidence.
 *
 * Everything read from a submission is untrusted content, never instructions.
 * Facts are decided by code; the model is used only
 * for `ai_page_judgement`, whose prompt frames the page as data.
 *
 * Outcomes: each check ends as a pass, a fail, or inconclusive (it could not
 * complete: network error, timeout, rate limit, model error, or confidence
 * below CONFIDENCE_THRESHOLD). Inconclusive is never a pass and never a fail.
 *
 * This module does not change the contract's state or write events: the
 * contract service (src/lib/contract/service-verify.ts) calls
 * `verifySubmission`, then moves VERIFYING -> PASSED | FAILED (or
 * leaves it VERIFYING when the outcome is inconclusive) through
 * src/lib/contract/machine.ts.
 */
import { getContract } from "@/lib/db/contracts";
import { listConditions } from "@/lib/db/conditions";
import { getSubmission } from "@/lib/db/submissions";
import { createVerdict, deleteVerdictsForSubmission } from "@/lib/db/verdicts";
import {
  CheckParamsSchemas,
  type CheckKind,
  type CheckParams,
  type Condition,
  type Contract,
  type Submission,
  type Verdict,
  type VerdictEvidence,
  type VerdictOutcome,
} from "@/lib/types";
import { checkAiPageJudgement } from "./ai-judgement";
import { checkGithubChecksPassed, checkGithubPrMerged, checkGithubPrReferencesIssue } from "./github";
import { CONFIDENCE_THRESHOLD, describeError, inconclusive } from "./result";
import { checkDomAssert, checkFormSubmits, checkHttpOk, checkResponsive } from "./website";

export { CONFIDENCE_THRESHOLD } from "./result";
export { unsafeAllowPrivateNetworkForTests } from "./net-guard";
export { setEvidenceRootForTests, resolveEvidencePath } from "./evidence";

/** What a single check gets to work with. `params` is already validated for its kind. */
export interface CheckContext<K extends CheckKind = CheckKind> {
  contract: Contract;
  condition: Condition & { check_kind: K };
  submission: Submission;
  params: CheckParams<K>;
}

/** What a single check returns; `verifySubmission` turns it into a stored Verdict. */
export interface CheckResult {
  passed: boolean;
  /** 0..1. Below the payout threshold the verdict goes to a human. */
  confidence: number;
  reasoning: string;
  evidence: VerdictEvidence;
  /**
   * (Addition) true when the check could not complete. `passed` is then false
   * and `confidence` 0; the verdict is neither a pass nor a fail.
   */
  inconclusive?: boolean;
}

export type CheckRunner<K extends CheckKind> = (ctx: CheckContext<K>) => Promise<CheckResult>;

export type CheckRegistry = { [K in CheckKind]: CheckRunner<K> };

/** (Addition) The run's overall result, matching api.md `verification.status`. */
export type VerificationOutcome = "passed" | "failed" | "inconclusive";

export interface VerificationResult {
  contractId: string;
  submissionId: string;
  /** One per condition, in condition order. */
  verdicts: Verdict[];
  /** True only when every condition has a conclusive pass at or above CONFIDENCE_THRESHOLD. */
  allPassed: boolean;
  /**
   * (Addition) "failed" if any condition conclusively failed; otherwise
   * "inconclusive" if any check could not complete or was below the
   * threshold; otherwise "passed". `allPassed === (outcome === "passed")`.
   */
  outcome: VerificationOutcome;
  /** (Addition) The conditions whose check was inconclusive, with the reason (for the page). */
  inconclusive: { condition_id: string; reason: string }[];
}

/** One runner per check kind. */
export const checkRegistry: CheckRegistry = {
  github_pr_merged: checkGithubPrMerged,
  github_checks_passed: checkGithubChecksPassed,
  github_pr_references_issue: checkGithubPrReferencesIssue,
  http_ok: checkHttpOk,
  dom_assert: checkDomAssert,
  responsive: checkResponsive,
  form_submits: checkFormSubmits,
  ai_page_judgement: checkAiPageJudgement,
};

/** Backstop per check; each runner has tighter limits of its own. */
const CHECK_TIMEOUT_MS: Record<CheckKind, number> = {
  github_pr_merged: 60_000,
  github_checks_passed: 60_000,
  github_pr_references_issue: 60_000,
  http_ok: 60_000,
  dom_assert: 90_000,
  responsive: 90_000,
  form_submits: 90_000,
  ai_page_judgement: 240_000,
};

/** The outcome a stored verdict stands for (older rows have no `evidence.outcome`). */
export function verdictOutcome(verdict: Pick<Verdict, "passed" | "evidence">): VerdictOutcome {
  return verdict.evidence.outcome ?? (verdict.passed ? "pass" : "fail");
}

/**
 * Turns a runner's result into the verdict fields. A pass needs confidence at
 * or above the threshold; a pass or fail below it is inconclusive (it goes to
 * a human or a re-run), with the check's leaning kept in the evidence.
 */
export function toVerdictFields(result: CheckResult): Pick<Verdict, "passed" | "confidence" | "reasoning" | "evidence"> {
  const confidence = Number.isFinite(result.confidence) ? Math.min(1, Math.max(0, result.confidence)) : 0;
  if (result.inconclusive) {
    return { passed: false, confidence: 0, reasoning: result.reasoning, evidence: { ...result.evidence, outcome: "inconclusive" } };
  }
  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      passed: false,
      confidence: 0,
      reasoning:
        `${result.reasoning} The check leaned ${result.passed ? "pass" : "fail"} with confidence ${confidence.toFixed(2)}, ` +
        `below the ${CONFIDENCE_THRESHOLD} needed, so a person or a re-run must decide.`,
      evidence: { ...result.evidence, outcome: "inconclusive", below_threshold: { leaned: result.passed ? "pass" : "fail", confidence } },
    };
  }
  return {
    passed: result.passed,
    confidence,
    reasoning: result.reasoning,
    evidence: { ...result.evidence, outcome: result.passed ? "pass" : "fail" },
  };
}

export function overallOutcome(outcomes: VerdictOutcome[]): VerificationOutcome {
  if (outcomes.length === 0) return "inconclusive";
  if (outcomes.includes("fail")) return "failed";
  if (outcomes.includes("inconclusive")) return "inconclusive";
  return "passed";
}

async function runCheck(contract: Contract, condition: Condition, submission: Submission): Promise<CheckResult> {
  const kind = condition.check_kind;
  const parsed = CheckParamsSchemas[kind].safeParse(condition.check_params);
  if (!parsed.success) {
    return inconclusive(`The condition's check parameters are invalid: ${parsed.error.message}`, { check_kind: kind });
  }
  const runner = checkRegistry[kind] as CheckRunner<CheckKind>;
  const ctx: CheckContext = { contract, condition, submission, params: parsed.data };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve(inconclusive(`The check did not finish within ${CHECK_TIMEOUT_MS[kind] / 1000} s.`, {})),
      CHECK_TIMEOUT_MS[kind],
    );
  });
  try {
    return await Promise.race([runner(ctx), timeout]);
  } catch (error) {
    return inconclusive(`The check could not complete: ${describeError(error).message}`, {}, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every condition of the submission's contract through `checkRegistry`,
 * in condition order, and stores each verdict as soon as its check finishes,
 * so the contract page shows the checks completing one by one. The run first
 * clears any earlier verdicts for the submission, so a finished run (first or
 * re-run) leaves exactly one verdict per condition; a run that crashes part
 * way leaves a partial set, which the next re-run replaces. The caller (the
 * contract service) holds the contract's "verify" claim for the whole run, so no two
 * runs write the same submission at once, and it reports whether a run has
 * finished through its events, never through the verdict count. Does not
 * change contract state (see the top of this file). Throws only when the
 * submission, its contract or its conditions are missing.
 */
export async function verifySubmission(submissionId: string): Promise<VerificationResult> {
  const submission = getSubmission(submissionId);
  if (!submission) throw new Error(`verifySubmission: submission ${submissionId} not found`);
  const contract = getContract(submission.contract_id);
  if (!contract) throw new Error(`verifySubmission: contract ${submission.contract_id} not found`);
  const conditions = listConditions(contract.id);
  if (conditions.length === 0) throw new Error(`verifySubmission: contract ${contract.id} has no conditions`);

  deleteVerdictsForSubmission(submission.id);
  const verdicts: Verdict[] = [];
  for (const condition of conditions) {
    const checkStarted = new Date();
    const result = await runCheck(contract, condition, submission);
    const fields = toVerdictFields(result);
    fields.evidence = {
      ...fields.evidence,
      check_kind: condition.check_kind,
      timings: { started_at: checkStarted.toISOString(), duration_ms: Date.now() - checkStarted.getTime() },
    };
    verdicts.push(createVerdict({ submission_id: submission.id, condition_id: condition.id, ...fields }));
  }

  const outcome = overallOutcome(verdicts.map(verdictOutcome));
  return {
    contractId: contract.id,
    submissionId: submission.id,
    verdicts,
    allPassed: outcome === "passed",
    outcome,
    inconclusive: verdicts
      .filter((v) => verdictOutcome(v) === "inconclusive")
      .map((v) => ({ condition_id: v.condition_id, reason: v.reasoning })),
  };
}
