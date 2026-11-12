/**
 * Signed verification receipts and contract terms hashes (migration 3). A
 * receipt is stored exactly as issued and never changed; a re-run issues a
 * new one, so a submission keeps one receipt per finished run.
 */
import type { SignedReceipt } from "@/lib/verifier/receipt-core";
import { getDb, nowIso } from "./index";

export function getTermsHash(contractId: string): string | null {
  const row = getDb().prepare(`SELECT terms_hash FROM contracts WHERE id = ?`).get(contractId) as
    | { terms_hash: string | null }
    | undefined;
  return row?.terms_hash ?? null;
}

/** Stores the terms hash unless one is already stored; returns the stored value. */
export function setTermsHashOnce(contractId: string, hash: string): string {
  getDb().prepare(`UPDATE contracts SET terms_hash = ? WHERE id = ? AND terms_hash IS NULL`).run(hash, contractId);
  return getTermsHash(contractId) ?? hash;
}

export function saveReceipt(signed: SignedReceipt): void {
  getDb()
    .prepare(
      `INSERT INTO receipts (receipt_sha256, submission_id, contract_id, signed, created_at)
       VALUES (@receipt_sha256, @submission_id, @contract_id, @signed, @created_at)`,
    )
    .run({
      receipt_sha256: signed.receipt_sha256,
      submission_id: signed.receipt.submission_id,
      contract_id: signed.receipt.contract_id,
      signed: JSON.stringify(signed),
      created_at: nowIso(),
    });
}

/** Newest first. */
export function listReceiptsForContract(contractId: string): SignedReceipt[] {
  return (
    getDb()
      .prepare(`SELECT signed FROM receipts WHERE contract_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(contractId) as { signed: string }[]
  ).map((row) => JSON.parse(row.signed) as SignedReceipt);
}

/** Newest first. */
export function listReceiptsForSubmission(submissionId: string): SignedReceipt[] {
  return (
    getDb()
      .prepare(`SELECT signed FROM receipts WHERE submission_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(submissionId) as { signed: string }[]
  ).map((row) => JSON.parse(row.signed) as SignedReceipt);
}
