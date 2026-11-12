/**
 * Storage for the verifier's work log (src/lib/verifier/trace-types.ts). The
 * recorder (src/lib/verifier/trace.ts) inserts a step when it starts and
 * updates it when it ends, so a reader always sees the run as far as it has
 * got. A re-run of a submission replaces that submission's steps, as it does
 * its verdicts.
 */
import { TRACE_STEP_KINDS, type TraceFacts, type TraceStep, type TraceStepKind, type TraceStepStatus } from "@/lib/verifier/trace-types";
import { getDb, newId } from "./index";

type StepRow = Omit<TraceStep, "detail" | "result"> & { detail: string; result: string };

const KINDS = new Set<string>(TRACE_STEP_KINDS);

function facts(json: string): TraceFacts {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: TraceFacts = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function fromRow(row: StepRow): TraceStep {
  if (!KINDS.has(row.kind)) throw new Error(`verification step ${row.id} has an unknown kind: ${row.kind}`);
  if (row.status !== "running" && row.status !== "done" && row.status !== "failed") {
    throw new Error(`verification step ${row.id} has an unknown status: ${String(row.status)}`);
  }
  return { ...row, detail: facts(row.detail), result: facts(row.result) };
}

/** Inserts a step as running. `seq` is the next number for the submission, assigned here. */
export function startStep(input: {
  submission_id: string;
  condition_id: string | null;
  kind: TraceStepKind;
  label: string;
  started_at: string;
  detail?: TraceFacts;
}): TraceStep {
  const db = getDb();
  const insert = db.transaction((): TraceStep => {
    const { next } = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM verification_steps WHERE submission_id = ?`)
      .get(input.submission_id) as { next: number };
    const step: TraceStep = {
      id: newId(),
      submission_id: input.submission_id,
      condition_id: input.condition_id,
      seq: next,
      kind: input.kind,
      label: input.label,
      status: "running",
      started_at: input.started_at,
      duration_ms: null,
      detail: input.detail ?? {},
      result: {},
    };
    db.prepare(
      `INSERT INTO verification_steps (id, submission_id, condition_id, seq, kind, label, status, started_at, duration_ms, detail, result)
       VALUES (@id, @submission_id, @condition_id, @seq, @kind, @label, @status, @started_at, @duration_ms, @detail, @result)`,
    ).run({ ...step, detail: JSON.stringify(step.detail), result: JSON.stringify(step.result) });
    return step;
  });
  return insert.immediate();
}

/** Ends a running step. Does nothing to a step that has already ended; returns whether it changed one. */
export function finishStep(
  id: string,
  input: { status: Exclude<TraceStepStatus, "running">; duration_ms: number; detail: TraceFacts; result: TraceFacts },
): boolean {
  const changed = getDb()
    .prepare(
      `UPDATE verification_steps
          SET status = @status, duration_ms = @duration_ms, detail = @detail, result = @result
        WHERE id = @id AND status = 'running'`,
    )
    .run({
      id,
      status: input.status,
      duration_ms: Math.max(0, Math.round(input.duration_ms)),
      detail: JSON.stringify(input.detail),
      result: JSON.stringify(input.result),
    }).changes;
  return changed > 0;
}

/** One submission's steps in the order they started. */
export function listStepsForSubmission(submissionId: string): TraceStep[] {
  const rows = getDb()
    .prepare(`SELECT * FROM verification_steps WHERE submission_id = ? ORDER BY seq`)
    .all(submissionId) as StepRow[];
  return rows.map(fromRow);
}

/** Every step on every submission of a contract: submissions oldest first, then `seq`. */
export function listStepsForContract(contractId: string): TraceStep[] {
  const rows = getDb()
    .prepare(
      `SELECT v.* FROM verification_steps v JOIN submissions s ON s.id = v.submission_id
        WHERE s.contract_id = ? ORDER BY s.created_at, s.rowid, v.seq`,
    )
    .all(contractId) as StepRow[];
  return rows.map(fromRow);
}

/** Removes a submission's steps, so a re-run can replace them. Called at the start of a run, inside the "verify" claim. */
export function deleteStepsForSubmission(submissionId: string): number {
  return getDb().prepare(`DELETE FROM verification_steps WHERE submission_id = ?`).run(submissionId).changes;
}
