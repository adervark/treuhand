/**
 * Turns the API's verdict rows into what the checklist shows: one outcome per
 * condition for the chosen attempt (submission), plus a summary line.
 * Pure; the page passes in what `GET /api/contracts/[id]` returned.
 */
import type { Condition, Submission, Verdict } from "@/lib/types";
import type { ContractBundle } from "../api";

export type Outcome = "pass" | "fail" | "inconclusive" | "checking" | "queued" | "not_run";

export interface ConditionRow {
  condition: Condition;
  verdict: Verdict | null;
  outcome: Outcome;
  /**
   * Set only while a verdict that arrived with the page open is being played in
   * (staged-rows.ts): its review panel's votes shown so far. The row reads as
   * still checking until the votes are in.
   */
  voting?: number;
}

/**
 * A check that could not complete is neither a pass nor a fail.
 * The verifier marks it on the verdict's evidence.
 */
export function isInconclusive(v: Verdict): boolean {
  const e = v.evidence as Record<string, unknown>;
  return (
    e.inconclusive === true ||
    e.outcome === "inconclusive" ||
    e.status === "inconclusive" ||
    e.result === "inconclusive"
  );
}

export function verdictOutcome(v: Verdict): Outcome {
  if (isInconclusive(v)) return "inconclusive";
  return v.passed ? "pass" : "fail";
}

/** The latest verdict per condition for one submission (verdicts arrive oldest first; a re-run wins). */
export function latestVerdicts(verdicts: Verdict[], submissionId: string): Map<string, Verdict> {
  const map = new Map<string, Verdict>();
  for (const v of verdicts) if (v.submission_id === submissionId) map.set(v.condition_id, v);
  return map;
}

export function conditionRows(bundle: ContractBundle, submission: Submission | null): ConditionRow[] {
  const verdicts = submission ? latestVerdicts(bundle.verdicts, submission.id) : new Map<string, Verdict>();
  const latest = bundle.submissions[0] ?? null;
  const isLatest = submission !== null && latest !== null && submission.id === latest.id;
  const running =
    isLatest &&
    (bundle.contract.state === "SUBMITTED" ||
      (bundle.verification?.status === "running" && bundle.verification.submission_id === submission?.id));

  let checkingAssigned = false;
  return bundle.conditions.map((condition) => {
    const verdict = verdicts.get(condition.id) ?? null;
    if (verdict) return { condition, verdict, outcome: verdictOutcome(verdict) };
    if (running && bundle.contract.state !== "SUBMITTED" && !checkingAssigned) {
      checkingAssigned = true;
      return { condition, verdict, outcome: "checking" as const };
    }
    return { condition, verdict, outcome: running ? ("queued" as const) : ("not_run" as const) };
  });
}

export function summarize(rows: ConditionRow[]): {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  pending: number;
} {
  const count = (o: Outcome[]) => rows.filter((r) => o.includes(r.outcome)).length;
  return {
    total: rows.length,
    passed: count(["pass"]),
    failed: count(["fail"]),
    inconclusive: count(["inconclusive"]),
    pending: count(["checking", "queued", "not_run"]),
  };
}

/** Pass/fail tally for one attempt, for the attempt switcher. */
export function attemptTally(bundle: ContractBundle, submissionId: string): { passed: number; failed: number; other: number } {
  const map = latestVerdicts(bundle.verdicts, submissionId);
  let passed = 0;
  let failed = 0;
  let other = 0;
  for (const v of map.values()) {
    const o = verdictOutcome(v);
    if (o === "pass") passed++;
    else if (o === "fail") failed++;
    else other++;
  }
  return { passed, failed, other };
}
