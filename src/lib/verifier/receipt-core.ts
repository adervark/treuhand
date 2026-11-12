/**
 * Signed verification receipts: the pure part. The app (receipt.ts) and the
 * standalone checker (scripts/verify-receipt.ts) both use this file. It needs
 * only `node:crypto`, so an auditor can read this one file to know exactly
 * what a receipt commits to and how it is checked.
 *
 * - Canonical JSON: object keys sorted by UTF-16 code unit (as RFC 8785),
 *   no whitespace, values encoded as `JSON.stringify` encodes them (so a
 *   value and its JSON round trip encode the same).
 * - Terms hash: SHA-256 (hex) of the canonical JSON of what both parties
 *   signed: contract id, type, payer and worker emails, amount, currency,
 *   deadline, and the conditions in order (text, check kind, params).
 * - Receipt hash: SHA-256 (hex) of the canonical JSON of the receipt body.
 * - Signature: Ed25519 over the 32 bytes of the receipt hash, base64.
 * - Key fingerprint: SHA-256 (hex) of the public key's DER SPKI encoding.
 *
 * A receipt is a record of what the verifier concluded. Nothing reads it to
 * decide whether money moves.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export const TERMS_SCHEMA = "proviso.terms/1";
export const RECEIPT_SCHEMA = "proviso.receipt/1";
export const SIGNATURE_ALGORITHM = "Ed25519";

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: sorted keys, no whitespace. Throws for values JSON cannot hold (BigInt, a bare undefined). */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined) throw new TypeError("canonicalJson: the value has no JSON form");
  return encoded;
}

function encode(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("canonicalJson: BigInt has no JSON form");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => encode(item) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = encode(record[key]);
    if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${members.join(",")}}`;
}

/** SHA-256 as lowercase hex; a string is hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** The contract and conditions as `GET /api/contracts/[id]` returns them (extra fields are ignored). */
export interface TermsSource {
  contract: {
    id: string;
    type: string;
    payer_email: string;
    worker_email: string;
    amount_cents: number;
    currency: string;
    deadline_at: string;
  };
  conditions: { position: number; text: string; check_kind: string; check_params: unknown }[];
}

/** What both parties agreed, as the object whose canonical JSON is hashed. */
export function canonicalTerms({ contract, conditions }: TermsSource) {
  return {
    schema: TERMS_SCHEMA,
    contract_id: contract.id,
    type: contract.type,
    payer_email: contract.payer_email,
    worker_email: contract.worker_email,
    amount_cents: contract.amount_cents,
    currency: contract.currency,
    deadline_at: contract.deadline_at,
    conditions: [...conditions]
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ text: c.text, check_kind: c.check_kind, check_params: c.check_params })),
  };
}

export function termsSha256(source: TermsSource): string {
  return sha256Hex(canonicalJson(canonicalTerms(source)));
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface ReceiptVerdict {
  verdict_id: string;
  condition_id: string;
  check_kind: string;
  outcome: "pass" | "fail" | "inconclusive";
  confidence: number;
  /** SHA-256 of the verdict's reasoning text (UTF-8). */
  reasoning_sha256: string;
  /** SHA-256 of the canonical JSON of the verdict's `evidence`. */
  evidence_sha256: string;
  /** Each screenshot named in the evidence, with the SHA-256 of its bytes (null if the file was missing). */
  screenshots: { path: string; sha256: string | null }[];
}

export interface ReceiptBody {
  schema: typeof RECEIPT_SCHEMA;
  contract_id: string;
  submission_id: string;
  submitted_url: string;
  terms_sha256: string | null;
  outcome: "passed" | "failed" | "inconclusive";
  /** In condition order. */
  verdicts: ReceiptVerdict[];
  verifier: { name: string; version: string; model: string };
  started_at: string;
  finished_at: string;
  issued_at: string;
}

export interface SignedReceipt {
  receipt: ReceiptBody;
  /** SHA-256 of the canonical JSON of `receipt`. */
  receipt_sha256: string;
  signature: {
    algorithm: typeof SIGNATURE_ALGORITHM;
    /** SHA-256 of the signing public key's DER SPKI. */
    key_fingerprint: string;
    /** Ed25519 over the 32 bytes of `receipt_sha256`, base64. */
    value: string;
  };
}

export function receiptSha256(body: ReceiptBody): string {
  return sha256Hex(canonicalJson(body));
}

export function publicKeyFingerprint(key: KeyObject | string): string {
  const publicKey = typeof key === "string" ? createPublicKey(key) : key;
  return sha256Hex(publicKey.export({ type: "spki", format: "der" }));
}

// ---------------------------------------------------------------------------
// Checking a receipt
// ---------------------------------------------------------------------------

/** One check's result; `ok: null` means it could not be made (e.g. the evidence was replaced by a re-run). */
export interface ReceiptCheck {
  check: string;
  ok: boolean | null;
  detail: string;
}

/** The contract as `GET /api/contracts/[id]` returns it, for the terms and per-verdict checks. */
export interface ContractEvidence extends TermsSource {
  verdicts?: { id: string; condition_id: string; passed?: boolean; reasoning: string; evidence: unknown; confidence: number }[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function shapeProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "not a JSON object";
  const signed = value as Partial<SignedReceipt>;
  if (!signed.receipt || typeof signed.receipt !== "object") return "no `receipt` object";
  if (signed.receipt.schema !== RECEIPT_SCHEMA) return `receipt.schema is not "${RECEIPT_SCHEMA}"`;
  if (!Array.isArray(signed.receipt.verdicts)) return "receipt.verdicts is not an array";
  if (typeof signed.receipt_sha256 !== "string" || !HEX64.test(signed.receipt_sha256)) return "receipt_sha256 is not 64 hex digits";
  const sig = signed.signature;
  if (!sig || sig.algorithm !== SIGNATURE_ALGORITHM || typeof sig.value !== "string" || typeof sig.key_fingerprint !== "string") {
    return "signature is not an Ed25519 signature object";
  }
  return null;
}

/**
 * Checks a signed receipt against a public key and, when given, the contract
 * it is about. Every failed check is `ok: false`; the receipt holds only if
 * none is. The signature is checked over the hash recomputed from the
 * receipt's content, so it fails for any change to the content.
 */
export function checkReceipt(value: unknown, publicKeyPem: string, contract?: ContractEvidence): ReceiptCheck[] {
  const problem = shapeProblem(value);
  if (problem) return [{ check: "receipt format", ok: false, detail: problem }];
  const signed = value as SignedReceipt;
  const { receipt } = signed;
  const checks: ReceiptCheck[] = [];

  const recomputed = receiptSha256(receipt);
  checks.push({
    check: "receipt hash",
    ok: recomputed === signed.receipt_sha256,
    detail: recomputed === signed.receipt_sha256 ? recomputed : `recomputed ${recomputed}, receipt says ${signed.receipt_sha256}`,
  });

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`a ${publicKey.asymmetricKeyType} key, not Ed25519`);
  } catch (error) {
    checks.push({ check: "public key", ok: false, detail: `unusable public key: ${(error as Error).message}` });
    return checks;
  }
  const fingerprint = publicKeyFingerprint(publicKey);
  checks.push({
    check: "signing key",
    ok: fingerprint === signed.signature.key_fingerprint,
    detail:
      fingerprint === signed.signature.key_fingerprint
        ? `fingerprint ${fingerprint}`
        : `the key given has fingerprint ${fingerprint}; the receipt was signed by ${signed.signature.key_fingerprint}`,
  });
  let valid = false;
  try {
    valid = verify(null, Buffer.from(recomputed, "hex"), publicKey, Buffer.from(signed.signature.value, "base64"));
  } catch {
    valid = false;
  }
  checks.push({
    check: "signature",
    ok: valid,
    detail: valid ? "Ed25519 signature valid for this content" : "Ed25519 signature does not match this content and key",
  });

  if (!contract) return checks;
  const sameContract = contract.contract.id === receipt.contract_id;
  checks.push({
    check: "contract id",
    ok: sameContract,
    detail: sameContract ? receipt.contract_id : `receipt is for ${receipt.contract_id}, contract JSON is ${contract.contract.id}`,
  });
  const terms = termsSha256(contract);
  checks.push({
    check: "terms hash",
    ok: terms === receipt.terms_sha256,
    detail: terms === receipt.terms_sha256 ? terms : `recomputed from the contract ${terms}, receipt says ${receipt.terms_sha256}`,
  });

  if (!contract.verdicts) return checks;
  const byId = new Map(contract.verdicts.map((v) => [v.id, v]));
  receipt.verdicts.forEach((rv, i) => {
    const name = `verdict ${i + 1} (${rv.check_kind})`;
    const stored = byId.get(rv.verdict_id);
    if (!stored) {
      checks.push({ check: name, ok: null, detail: "not in the contract JSON (a later re-run replaced it); not compared" });
      return;
    }
    const mismatches: string[] = [];
    if (stored.condition_id !== rv.condition_id) mismatches.push("condition");
    if (sha256Hex(canonicalJson(stored.evidence)) !== rv.evidence_sha256) mismatches.push("evidence");
    if (sha256Hex(stored.reasoning) !== rv.reasoning_sha256) mismatches.push("reasoning");
    if (stored.confidence !== rv.confidence) mismatches.push("confidence");
    const storedOutcome =
      (stored.evidence as { outcome?: unknown } | null)?.outcome ?? (stored.passed === undefined ? undefined : stored.passed ? "pass" : "fail");
    if (storedOutcome !== undefined && storedOutcome !== rv.outcome) mismatches.push("outcome");
    checks.push({
      check: name,
      ok: mismatches.length === 0,
      detail: mismatches.length === 0 ? "evidence, reasoning and outcome match the receipt" : `differs from the receipt in: ${mismatches.join(", ")}`,
    });
  });
  return checks;
}

/** True when no check failed. */
export function receiptHolds(checks: ReceiptCheck[]): boolean {
  return checks.every((c) => c.ok !== false);
}
