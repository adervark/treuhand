/**
 * The recorder for the verifier's work log (types and rules in
 * trace-types.ts, storage in src/lib/db/steps.ts).
 *
 * `runWithTrace` puts a recorder in scope with AsyncLocalStorage, so the
 * check runners call `step` and `note` without passing anything around.
 * Every step is written when it starts and again when it ends, so the
 * contract page can show a run while it is running. When the scope's
 * function settles, the scope is closed: a step still running (a runner the
 * per-check time limit left behind) is ended as failed with
 * `detail.cut_off = true`, and anything that scope records later is ignored.
 *
 * Outside a scope `step` just runs its function and `note` does nothing, so
 * runners called directly (unit tests) behave as before. The recorder never
 * makes a check fail or changes its result: a database error while writing a
 * step is logged once per scope and the check carries on.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { finishStep, startStep } from "@/lib/db/steps";
import { clip, describeError } from "./result";
import type { TraceFacts, TraceStep, TraceStepKind, TraceStepStatus } from "./trace-types";

/** Facts as callers pass them. `undefined` values are left out; strings are clipped; a non-finite number becomes null. */
export type FactsInput = Record<string, string | number | boolean | null | undefined>;

/** A finished step as copied into a verdict's `evidence.trace`. */
export type EvidenceTraceStep = Pick<TraceStep, "seq" | "kind" | "label" | "status" | "started_at" | "duration_ms" | "detail" | "result">;

export interface StepHandle {
  /** Adds neutral facts (safe to show while the check runs). */
  detail(facts: FactsInput): void;
  /** Adds facts that reveal how the check will end; the page shows them once the verdict is in. */
  result(facts: FactsInput): void;
  /** Ends the step as failed when its function returns: it did not throw, but did not do what it set out to. */
  fail(): void;
}

const MAX_FACT_CHARS = 160;

function addFacts(into: TraceFacts, facts: FactsInput | undefined): TraceFacts {
  if (!facts) return into;
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === "string") into[key] = clip(value, MAX_FACT_CHARS);
    else if (typeof value === "number") into[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "boolean" || value === null) into[key] = value;
  }
  return into;
}

interface OpenStep {
  step: TraceStep;
  startedAt: number;
  failed: boolean;
}

class Recorder {
  private closed = false;
  private loggedError = false;
  private readonly open = new Set<OpenStep>();
  private readonly ended: TraceStep[] = [];

  constructor(
    private readonly submissionId: string,
    private readonly conditionId: string | null,
  ) {}

  begin(kind: TraceStepKind, label: string, detail: FactsInput | undefined): OpenStep | null {
    if (this.closed) return null;
    try {
      const step = startStep({
        submission_id: this.submissionId,
        condition_id: this.conditionId,
        kind,
        label,
        started_at: new Date().toISOString(),
        detail: addFacts({}, detail),
      });
      const open: OpenStep = { step: { ...step, detail: { ...step.detail }, result: {} }, startedAt: performance.now(), failed: false };
      this.open.add(open);
      return open;
    } catch (error) {
      this.writeFailed(error);
      return null;
    }
  }

  isOpen(open: OpenStep): boolean {
    return this.open.has(open);
  }

  end(open: OpenStep, status: Exclude<TraceStepStatus, "running">): void {
    if (!this.open.delete(open)) return; // already ended (the scope was closed)
    const duration_ms = Math.max(0, Math.round(performance.now() - open.startedAt));
    const ended: TraceStep = { ...open.step, status, duration_ms, detail: { ...open.step.detail }, result: { ...open.step.result } };
    this.ended.push(ended);
    try {
      finishStep(ended.id, { status, duration_ms, detail: ended.detail, result: ended.result });
    } catch (error) {
      this.writeFailed(error);
    }
  }

  handle(open: OpenStep): StepHandle {
    return {
      detail: (facts) => {
        if (this.isOpen(open)) addFacts(open.step.detail, facts);
      },
      result: (facts) => {
        if (this.isOpen(open)) addFacts(open.step.result, facts);
      },
      fail: () => {
        open.failed = true;
      },
    };
  }

  /** Ends every running step as cut off and ignores anything recorded from now on. */
  close(): TraceStep[] {
    this.closed = true;
    for (const open of [...this.open]) {
      open.step.detail.cut_off = true;
      this.end(open, "failed");
    }
    return [...this.ended].sort((a, b) => a.seq - b.seq);
  }

  private writeFailed(error: unknown): void {
    if (this.loggedError) return;
    this.loggedError = true;
    console.error(`the verifier's work log for submission ${this.submissionId} could not be written; the check carries on`, error);
  }
}

const NO_OP: StepHandle = { detail: () => undefined, result: () => undefined, fail: () => undefined };

const scope = new AsyncLocalStorage<Recorder>();

/**
 * Runs `fn` with a recorder for this submission and condition (null for
 * run-level steps) in scope, then closes it and returns what `fn` returned
 * with the steps it recorded, in order. If `fn` throws, the scope is still
 * closed and the error rethrown.
 */
export async function runWithTrace<T>(
  submissionId: string,
  conditionId: string | null,
  fn: () => Promise<T>,
): Promise<{ value: T; steps: TraceStep[] }> {
  const recorder = new Recorder(submissionId, conditionId);
  try {
    const value = await scope.run(recorder, fn);
    return { value, steps: recorder.close() };
  } finally {
    recorder.close(); // idempotent; covers a throwing `fn`
  }
}

/**
 * Records a step around `fn`: running while it runs, then done, or failed if
 * it throws (the same error is rethrown) or called `handle.fail()`. `label`
 * is a phrase written in the verifier's code, never text from the page.
 */
export async function step<T>(
  kind: TraceStepKind,
  label: string,
  fn: (handle: StepHandle) => Promise<T> | T,
  detail?: FactsInput,
): Promise<T> {
  const recorder = scope.getStore();
  const open = recorder?.begin(kind, label, detail) ?? null;
  if (!recorder || !open) return fn(NO_OP);
  try {
    const value = await fn(recorder.handle(open));
    recorder.end(open, open.failed ? "failed" : "done");
    return value;
  } catch (error) {
    if (recorder.isOpen(open)) open.step.result.error = clip(describeError(error).message, MAX_FACT_CHARS);
    recorder.end(open, "failed");
    throw error;
  }
}

/** Records an instantaneous, finished step. */
export function note(kind: TraceStepKind, label: string, detail?: FactsInput, result?: FactsInput): void {
  const recorder = scope.getStore();
  const open = recorder?.begin(kind, label, detail) ?? null;
  if (!recorder || !open) return;
  addFacts(open.step.result, result);
  recorder.end(open, "done");
}

/** The fields of finished steps that go into a verdict's `evidence.trace`. */
export function toEvidenceTrace(steps: TraceStep[]): EvidenceTraceStep[] {
  return steps.map(({ seq, kind, label, status, started_at, duration_ms, detail, result }) => ({
    seq,
    kind,
    label,
    status,
    started_at,
    duration_ms,
    detail,
    result,
  }));
}
