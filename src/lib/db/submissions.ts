import { SubmissionSchema, type Submission } from "@/lib/types";
import { getDb, newId, nowIso } from "./index";

export function createSubmission(input: { contract_id: string; url: string }): Submission {
  const submission = SubmissionSchema.parse({ id: newId(), ...input, created_at: nowIso() });
  getDb()
    .prepare(
      `INSERT INTO submissions (id, contract_id, url, created_at)
       VALUES (@id, @contract_id, @url, @created_at)`,
    )
    .run(submission);
  return submission;
}

export function getSubmission(id: string): Submission | null {
  const row = getDb().prepare(`SELECT * FROM submissions WHERE id = ?`).get(id);
  return row ? SubmissionSchema.parse(row) : null;
}

/** Newest first. */
export function listSubmissions(contractId: string): Submission[] {
  return getDb()
    .prepare(`SELECT * FROM submissions WHERE contract_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(contractId)
    .map((row) => SubmissionSchema.parse(row));
}

export function getLatestSubmission(contractId: string): Submission | null {
  return listSubmissions(contractId)[0] ?? null;
}
