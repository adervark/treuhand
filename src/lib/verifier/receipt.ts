/**
 * Issuing signed verification receipts. When a verification run finishes,
 * the contract service calls `issueReceipt`, which records what was verified
 * (the submission and its URL), against what (the agreed terms hash), what
 * each check concluded and on which evidence (hashes of the evidence JSON and
 * of each screenshot file), and by which verifier; then hashes and signs it
 * (receipt-core.ts says how) and stores it with the submission.
 *
 * A receipt is a record, never a gate: settlement does not read it.
 */
import fs from "node:fs/promises";
import packageJson from "../../../package.json";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { getTermsHash, saveReceipt, setTermsHashOnce } from "@/lib/db/receipts";
import { getSubmission } from "@/lib/db/submissions";
import { clauseModel } from "@/lib/env";
import type { Verdict } from "@/lib/types";
import { resolveEvidencePath } from "./evidence";
import type { VerificationOutcome } from "./index";
import {
  canonicalJson,
  RECEIPT_SCHEMA,
  receiptSha256,
  sha256Hex,
  SIGNATURE_ALGORITHM,
  termsSha256,
  type ReceiptBody,
  type ReceiptVerdict,
  type SignedReceipt,
} from "./receipt-core";
import { getSigningKey, signDigest } from "./signing-key";

/**
 * The contract's terms hash: the one stored when it became SIGNED, or, for a
 * contract signed before receipts existed, computed now and stored (terms
 * cannot change after DRAFT, so it is the same value). Null while DRAFT.
 */
export function ensureTermsHash(contractId: string): string | null {
  const stored = getTermsHash(contractId);
  if (stored) return stored;
  const contract = getContract(contractId);
  if (!contract || contract.state === "DRAFT") return null;
  return setTermsHashOnce(contractId, termsSha256({ contract, conditions: listConditions(contractId) }));
}

/** SHA-256 of a screenshot file's bytes, or null if it cannot be read. */
async function fileSha256(stored: string): Promise<string | null> {
  try {
    return sha256Hex(await fs.readFile(resolveEvidencePath(stored)));
  } catch {
    return null;
  }
}

async function receiptVerdict(verdict: Verdict, checkKind: string): Promise<ReceiptVerdict> {
  const screenshots = Array.isArray(verdict.evidence.screenshots) ? verdict.evidence.screenshots.map(String) : [];
  return {
    verdict_id: verdict.id,
    condition_id: verdict.condition_id,
    check_kind: checkKind,
    outcome: verdict.evidence.outcome ?? (verdict.passed ? "pass" : "fail"),
    confidence: verdict.confidence,
    reasoning_sha256: sha256Hex(verdict.reasoning),
    evidence_sha256: sha256Hex(canonicalJson(verdict.evidence)),
    screenshots: await Promise.all(screenshots.map(async (p) => ({ path: p, sha256: await fileSha256(p) }))),
  };
}

/** Builds, signs and stores the receipt for a finished run, and returns it. */
export async function issueReceipt(input: {
  submissionId: string;
  outcome: VerificationOutcome;
  verdicts: Verdict[];
  startedAt: Date;
  finishedAt: Date;
}): Promise<SignedReceipt> {
  const submission = getSubmission(input.submissionId);
  if (!submission) throw new Error(`issueReceipt: submission ${input.submissionId} not found`);
  const conditions = listConditions(submission.contract_id);
  const kinds = new Map(conditions.map((c) => [c.id, c.check_kind as string]));
  const key = getSigningKey();

  const receipt: ReceiptBody = {
    schema: RECEIPT_SCHEMA,
    contract_id: submission.contract_id,
    submission_id: submission.id,
    submitted_url: submission.url,
    terms_sha256: ensureTermsHash(submission.contract_id),
    outcome: input.outcome,
    verdicts: await Promise.all(
      input.verdicts.map((v) => receiptVerdict(v, kinds.get(v.condition_id) ?? String(v.evidence.check_kind ?? "unknown"))),
    ),
    verifier: { name: packageJson.name, version: packageJson.version, model: clauseModel() },
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    issued_at: new Date().toISOString(),
  };
  const receipt_sha256 = receiptSha256(receipt);
  const signed: SignedReceipt = {
    receipt,
    receipt_sha256,
    signature: { algorithm: SIGNATURE_ALGORITHM, key_fingerprint: key.fingerprint, value: signDigest(receipt_sha256, key) },
  };
  saveReceipt(signed);
  return signed;
}
