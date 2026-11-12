import { VerdictSchema, type Verdict } from "@/lib/types";
import { fromSqlBool, getDb, newId, nowIso } from "./index";

type VerdictRow = Omit<Verdict, "passed" | "evidence"> & { passed: number; evidence: string };

function fromRow(row: VerdictRow): Verdict {
  return VerdictSchema.parse({ ...row, passed: fromSqlBool(row.passed), evidence: JSON.parse(row.evidence) });
}

export function createVerdict(input: Omit<Verdict, "id" | "created_at">): Verdict {
  const verdict = VerdictSchema.parse({ id: newId(), ...input, created_at: nowIso() });
  getDb()
    .prepare(
      `INSERT INTO verdicts (id, submission_id, condition_id, passed, confidence, reasoning, evidence, created_at)
       VALUES (@id, @submission_id, @condition_id, @passed, @confidence, @reasoning, @evidence, @created_at)`,
    )
    .run({ ...verdict, passed: verdict.passed ? 1 : 0, evidence: JSON.stringify(verdict.evidence) });
  return verdict;
}

export function getVerdict(id: string): Verdict | null {
  const row = getDb().prepare(`SELECT * FROM verdicts WHERE id = ?`).get(id) as VerdictRow | undefined;
  return row ? fromRow(row) : null;
}

/** Oldest first. */
export function listVerdictsForSubmission(submissionId: string): Verdict[] {
  const rows = getDb()
    .prepare(`SELECT * FROM verdicts WHERE submission_id = ? ORDER BY created_at, rowid`)
    .all(submissionId) as VerdictRow[];
  return rows.map(fromRow);
}

/**
 * Removes a submission's verdicts, so a re-run can replace them. Called by
 * the verifier at the start of a run, inside the contract's "verify" claim;
 * the new verdicts are then saved one at a time as each check finishes.
 */
export function deleteVerdictsForSubmission(submissionId: string): number {
  return getDb().prepare(`DELETE FROM verdicts WHERE submission_id = ?`).run(submissionId).changes;
}

/** Every verdict on every submission of a contract, oldest first. */
export function listVerdictsForContract(contractId: string): Verdict[] {
  const rows = getDb()
    .prepare(
      `SELECT v.* FROM verdicts v JOIN submissions s ON s.id = v.submission_id
       WHERE s.contract_id = ? ORDER BY v.created_at, v.rowid`,
    )
    .all(contractId) as VerdictRow[];
  return rows.map(fromRow);
}
