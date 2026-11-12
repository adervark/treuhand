/**
 * Issuing receipts against a temp database: the terms hash fixed at signing
 * (and computed lazily for older contracts), the receipt's hashes of
 * evidence and screenshot bytes, and the signing key (env, or generated and
 * kept owner-only beside the database).
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { listEvents } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { getTermsHash, listReceiptsForSubmission } from "@/lib/db/receipts";
import { getLatestSubmission } from "@/lib/db/submissions";
import { createVerdict, listVerdictsForSubmission } from "@/lib/db/verdicts";
import { contractIn, makeContract, step, withTempDb } from "@/test/helpers";
import { ensureTermsHash, issueReceipt } from "./receipt";
import { checkReceipt, publicKeyFingerprint, receiptHolds, sha256Hex, termsSha256 } from "./receipt-core";
import { getSigningKey, KEY_FILE_NAME, signingKeyFile, verifierPublicKey } from "./signing-key";

const db = withTempDb();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The contract as GET /api/contracts/[id] serialises it. */
function contractJson(contractId: string) {
  const submission = getLatestSubmission(contractId)!;
  return JSON.parse(
    JSON.stringify({
      contract: getContract(contractId),
      conditions: listConditions(contractId),
      verdicts: listVerdictsForSubmission(submission.id),
    }),
  );
}

describe("terms hash", () => {
  it("is fixed when the contract becomes SIGNED, and recorded on that state change", () => {
    const contract = makeContract();
    expect(ensureTermsHash(contract.id)).toBeNull();
    step(contract.id, "SIGNED");
    const expected = termsSha256({ contract: getContract(contract.id)!, conditions: listConditions(contract.id) });
    expect(getTermsHash(contract.id)).toBe(expected);
    const signedEvent = listEvents(contract.id).findLast((e) => e.kind === "STATE_CHANGED" && e.detail.to === "SIGNED");
    expect(signedEvent?.detail.terms_sha256).toBe(expected);
  });

  it("is computed lazily, and stored, for a contract signed before receipts existed", () => {
    const contract = contractIn("FUNDED");
    const atSigning = getTermsHash(contract.id);
    getDb().prepare(`UPDATE contracts SET terms_hash = NULL WHERE id = ?`).run(contract.id);
    expect(ensureTermsHash(contract.id)).toBe(atSigning);
    expect(getTermsHash(contract.id)).toBe(atSigning);
  });
});

describe("issueReceipt", () => {
  it("signs what was verified, against what, with hashes of the evidence and screenshot bytes", async () => {
    const contract = contractIn("VERIFYING");
    const submission = getLatestSubmission(contract.id)!;
    const [first, second] = listConditions(contract.id);
    const shotPath = path.join(path.dirname(db.path()), "0-dom-shot.jpg");
    const shot = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    fs.writeFileSync(shotPath, shot);
    const verdicts = [
      createVerdict({ submission_id: submission.id, condition_id: first.id, passed: true, confidence: 1, reasoning: "Answered 200.", evidence: { outcome: "pass", http_status: 200 } }),
      createVerdict({
        submission_id: submission.id,
        condition_id: second.id,
        passed: false,
        confidence: 0,
        reasoning: "The page did not load in time.",
        evidence: { outcome: "inconclusive", screenshots: [shotPath, "data/evidence/gone/missing.jpg"], note: undefined },
      }),
    ];
    vi.stubEnv("CLAUSE_MODEL", "judge-model");
    const startedAt = new Date("2026-11-12T10:00:00.000Z");
    const finishedAt = new Date("2026-11-12T10:00:09.000Z");
    const signed = await issueReceipt({ submissionId: submission.id, outcome: "inconclusive", verdicts, startedAt, finishedAt });

    expect(signed.receipt).toMatchObject({
      schema: "proviso.receipt/1",
      contract_id: contract.id,
      submission_id: submission.id,
      submitted_url: submission.url,
      terms_sha256: getTermsHash(contract.id),
      outcome: "inconclusive",
      verifier: { name: "proviso", version: expect.stringMatching(/^\d+\.\d+\.\d+/), model: "judge-model" },
      started_at: "2026-11-12T10:00:00.000Z",
      finished_at: "2026-11-12T10:00:09.000Z",
    });
    expect(signed.receipt.verdicts).toEqual([
      expect.objectContaining({ verdict_id: verdicts[0].id, condition_id: first.id, check_kind: "http_ok", outcome: "pass", confidence: 1, screenshots: [] }),
      expect.objectContaining({
        verdict_id: verdicts[1].id,
        check_kind: "dom_assert",
        outcome: "inconclusive",
        confidence: 0,
        reasoning_sha256: sha256Hex("The page did not load in time."),
        screenshots: [
          { path: shotPath, sha256: sha256Hex(shot) },
          { path: "data/evidence/gone/missing.jpg", sha256: null },
        ],
      }),
    ]);
    expect(signed.signature.key_fingerprint).toBe(getSigningKey().fingerprint);
    expect(listReceiptsForSubmission(submission.id)).toEqual([signed]);

    // Anyone with the public key and the contract JSON can check it.
    const checks = checkReceipt(JSON.parse(JSON.stringify(signed)), verifierPublicKey().public_key_pem, contractJson(contract.id));
    expect(checks.filter((c) => c.ok !== true)).toEqual([]);
    expect(checks.map((c) => c.check)).toEqual(
      expect.arrayContaining(["receipt hash", "signature", "terms hash", "verdict 1 (http_ok)", "verdict 2 (dom_assert)"]),
    );
  });

  it("a condition edited in the database after signing no longer matches the receipt's terms hash", async () => {
    const contract = contractIn("VERIFYING");
    const submission = getLatestSubmission(contract.id)!;
    const signed = await issueReceipt({ submissionId: submission.id, outcome: "passed", verdicts: [], startedAt: new Date(), finishedAt: new Date() });
    getDb().prepare(`UPDATE conditions SET text = 'Loads, eventually' WHERE contract_id = ? AND position = 0`).run(contract.id);
    const checks = checkReceipt(signed, verifierPublicKey().public_key_pem, contractJson(contract.id));
    expect(checks.filter((c) => c.ok === false).map((c) => c.check)).toEqual(["terms hash"]);
    expect(receiptHolds(checks)).toBe(false);
  });
});

describe("signing key", () => {
  it("is generated on first use beside the database, owner-only, and reused", () => {
    const file = signingKeyFile()!;
    expect(file).toBe(path.join(path.dirname(db.path()), KEY_FILE_NAME));
    expect(fs.existsSync(file)).toBe(false);
    const key = getSigningKey();
    expect(key.source).toBe("file");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(publicKeyFingerprint(fs.readFileSync(file, "utf8"))).toBe(key.fingerprint);
    expect(getSigningKey().fingerprint).toBe(key.fingerprint);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("loads an existing key file, tightening its permissions", () => {
    const file = signingKeyFile()!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(getSigningKey().fingerprint).toBe(publicKeyFingerprint(publicKey));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("uses VERIFIER_SIGNING_KEY when set (newlines may be escaped), writing no file", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    vi.stubEnv("VERIFIER_SIGNING_KEY", (privateKey.export({ type: "pkcs8", format: "pem" }) as string).replace(/\n/g, "\\n"));
    const key = getSigningKey();
    expect(key).toMatchObject({ source: "env", fingerprint: publicKeyFingerprint(publicKey) });
    expect(verifierPublicKey()).toEqual({
      algorithm: "Ed25519",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      public_key_jwk: { kty: "OKP", crv: "Ed25519", x: publicKey.export({ format: "jwk" }).x },
      fingerprint: publicKeyFingerprint(publicKey),
    });
    expect(fs.existsSync(signingKeyFile()!)).toBe(false);
  });

  it("refuses a VERIFIER_SIGNING_KEY that is not an Ed25519 private key", () => {
    vi.stubEnv("VERIFIER_SIGNING_KEY", "not a key");
    expect(() => getSigningKey()).toThrow(/VERIFIER_SIGNING_KEY is not a PEM private key/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    vi.stubEnv("VERIFIER_SIGNING_KEY", rsa);
    expect(() => getSigningKey()).toThrow(/rsa key; the verifier signs with Ed25519/);
  });
});
