/**
 * The verifier's work log: one step per thing the verifier did while checking
 * a submission (looked up an address, loaded a page, took a screenshot, asked
 * a reviewer), with when it started and how long it took. Steps are written
 * as they happen, so the contract page can show a run while it is running,
 * and each check's finished steps are copied into its verdict's evidence
 * (`evidence.trace`), which the run's signed receipt hashes.
 *
 * Types only: this file is imported by the browser bundle (type-only) and by
 * the server. The recorder is src/lib/verifier/trace.ts; storage is
 * src/lib/db/steps.ts; the API serves steps as `trace` on
 * `GET /api/contracts/[id]` (docs/api.md).
 */

/** What kind of work a step was. The page groups its metrics by this. */
export const TRACE_STEP_KINDS = [
  /** A safety decision: is this address public, is this URL allowed. */
  "guard",
  /** A request made without a browser (plain HTTP, the GitHub API). */
  "network",
  /** Starting the isolated browser, loading or interacting with the page in it. */
  "browser",
  /** Reading or measuring the loaded page (DOM lookups, layout widths, visible text). */
  "measure",
  /** Capturing a screenshot as evidence. */
  "screenshot",
  /** One AI reviewer being asked and answering. */
  "model",
  /** A conclusion: the panel's decision, the check's verdict. Shown only once the row has its verdict. */
  "decision",
  /** Run-level record keeping: signing the receipt. */
  "record",
] as const;
export type TraceStepKind = (typeof TRACE_STEP_KINDS)[number];

/** "running" until the step ends; "failed" when it threw, timed out or was cut off when its check ended. */
export type TraceStepStatus = "running" | "done" | "failed";

/** Small facts about a step. Values may come from the submitted page: render them as text, never as markup. */
export type TraceFacts = Record<string, string | number | boolean | null>;

export interface TraceStep {
  id: string;
  submission_id: string;
  /** The condition whose check did this; null for run-level steps (kind "record"). */
  condition_id: string | null;
  /** 1-based, in the order steps started within one run of one submission. */
  seq: number;
  kind: TraceStepKind;
  /**
   * What the verifier did, as a short plain phrase written by the verifier's
   * code (never taken from the page), e.g. "Load the page in an isolated
   * browser". The page shows it as is.
   */
  label: string;
  status: TraceStepStatus;
  /** ISO time, server clock. */
  started_at: string;
  /** Null while the step is running. */
  duration_ms: number | null;
  /**
   * Neutral facts, safe to show while the check is still running: host, HTTP
   * status, bytes, viewport width, attempt count, reviewer name. Never
   * anything that gives away the check's result.
   */
  detail: TraceFacts;
  /**
   * Facts that reveal how the check is going to end: a reviewer's vote and
   * confidence, the panel's decision, the verdict. The page shows these only
   * once the row has its verdict, so the work log never announces a result
   * before the run log does.
   */
  result: TraceFacts;
}

/** `trace` on `GET /api/contracts/[id]`. */
export interface ContractTrace {
  /** The server's clock when the response was built, so the page can time running steps without trusting its own clock. */
  now: string;
  /** Every step of every submission's latest run, ordered by submission (oldest first) then `seq`. */
  steps: TraceStep[];
}
