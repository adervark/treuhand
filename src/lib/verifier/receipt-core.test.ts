/**
 * Receipts, the pure part: canonical JSON, the terms hash, and checking a
 * signed receipt (any change to a verdict, the terms or an evidence hash
 * breaks it). Ends with the standalone checker, scripts/verify-receipt.ts,
 * run as a real process.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalTerms,
  checkReceipt,
  publicKeyFingerprint,
  RECEIPT_SCHEMA,
  receiptHolds,
  sha256Hex,
  termsSha256,
  type ContractEvidence,
  type ReceiptBody,
  type SignedReceipt,
} from "./receipt-core";

describe("canonicalJson", () => {
  it("sorts keys at every depth, keeps array order, and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,1,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("is the same whatever order the keys were inserted in", () => {
    const one = { url: "https://a.example/", nested: { k2: 2, k1: 1 }, list: ["b", "a"] };
    const two = { list: ["b", "a"], nested: { k1: 1, k2: 2 }, url: "https://a.example/" };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it("encodes values as JSON does, so a value and its JSON round trip encode the same", () => {
    const value = { skip: undefined, nan: Number.NaN, inf: -Infinity, negZero: -0, list: [undefined, 1.5], date: new Date(0), s: 'q"\n\u2028' };
    expect(canonicalJson(value)).toBe(
      '{"date":"1970-01-01T00:00:00.000Z","inf":null,"list":[null,1.5],"nan":null,"negZero":0,"s":"q\\"\\n\u2028"}',
    );
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value));
  });

  it("orders keys by UTF-16 code unit, as RFC 8785 does", () => {
    expect(canonicalJson({ b: 1, B: 2, "é": 3, a: 4, "10": 5, "9": 6 })).toBe('{"10":5,"9":6,"B":2,"a":4,"b":1,"é":3}');
  });

  it("refuses values JSON cannot hold", () => {
    expect(() => canonicalJson(BigInt(1))).toThrow(/BigInt/);
    expect(() => canonicalJson(undefined)).toThrow(/no JSON form/);
  });
});

const CONTRACT = {
  id: "c1",
  title: "not part of the terms hash",
  type: "website_milestone",
  payer_email: "p@x.test",
  worker_email: "w@x.test",
  amount_cents: 20000,
  currency: "USD",
  deadline_at: "2026-11-14T00:00:00.000Z",
  state: "SIGNED",
};
const CONDITIONS = [
  { id: "k2", position: 1, text: "Has a form", check_kind: "dom_assert", check_params: { text: "Send", selector: "form" } },
  { id: "k1", position: 0, text: "Loads", check_kind: "http_ok", check_params: {} },
];

describe("termsSha256", () => {
  it("hashes exactly the agreed terms, conditions in position order, as canonical JSON", () => {
    const expected =
      '{"amount_cents":20000,"conditions":[{"check_kind":"http_ok","check_params":{},"text":"Loads"},' +
      '{"check_kind":"dom_assert","check_params":{"selector":"form","text":"Send"},"text":"Has a form"}],' +
      '"contract_id":"c1","currency":"USD","deadline_at":"2026-11-14T00:00:00.000Z","payer_email":"p@x.test",' +
      '"schema":"proviso.terms/1","type":"website_milestone","worker_email":"w@x.test"}';
    expect(canonicalJson(canonicalTerms({ contract: CONTRACT, conditions: CONDITIONS }))).toBe(expected);
    // Pinned with `printf '%s' '<expected>' | sha256sum`.
    expect(termsSha256({ contract: CONTRACT, conditions: CONDITIONS })).toBe(
      "bba1e2a8a960c66a1627f84a0cd7bf8d5c0c9769251a4e42542bba8622601f9a",
    );
  });

  it("ignores fields outside the terms (title, state, ids) and changes with any agreed term", () => {
    const base = termsSha256({ contract: CONTRACT, conditions: CONDITIONS });
    const renamed = { ...CONTRACT, title: "Renamed", state: "PAID" };
    expect(termsSha256({ contract: renamed, conditions: CONDITIONS.map((c) => ({ ...c, id: "x" })) })).toBe(base);
    expect(termsSha256({ contract: { ...CONTRACT, amount_cents: 20001 }, conditions: CONDITIONS })).not.toBe(base);
    expect(termsSha256({ contract: { ...CONTRACT, deadline_at: "2026-11-15T00:00:00.000Z" }, conditions: CONDITIONS })).not.toBe(base);
    expect(termsSha256({ contract: CONTRACT, conditions: [{ ...CONDITIONS[0], text: "Has a contact form" }, CONDITIONS[1]] })).not.toBe(base);
    expect(termsSha256({ contract: CONTRACT, conditions: [{ ...CONDITIONS[0], check_params: { selector: "form" } }, CONDITIONS[1]] })).not.toBe(base);
    expect(
      termsSha256({ contract: CONTRACT, conditions: [{ ...CONDITIONS[0], position: 0 }, { ...CONDITIONS[1], position: 1 }] }),
    ).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Signed receipts
// ---------------------------------------------------------------------------

const verifierKey = generateKeyPairSync("ed25519");
const publicKeyPem = verifierKey.publicKey.export({ type: "spki", format: "pem" }) as string;

const EVIDENCE_1 = { outcome: "pass", http_status: 200, check_kind: "http_ok" };
const EVIDENCE_2 = { outcome: "fail", selector: "form", found: 0, screenshots: ["data/evidence/s1/0-dom.jpg"] };
const SHOT = Buffer.from("a screenshot's bytes");

function contractJson(): ContractEvidence {
  return {
    contract: { ...CONTRACT },
    conditions: CONDITIONS.map((c) => ({ ...c })),
    verdicts: [
      { id: "v1", condition_id: "k1", passed: true, confidence: 1, reasoning: "The page answered 200.", evidence: { ...EVIDENCE_1 } },
      { id: "v2", condition_id: "k2", passed: false, confidence: 1, reasoning: "No form on the page.", evidence: { ...EVIDENCE_2 } },
    ],
  };
}

function receiptBody(): ReceiptBody {
  const json = contractJson();
  return {
    schema: RECEIPT_SCHEMA,
    contract_id: "c1",
    submission_id: "s1",
    submitted_url: "https://bakery.example/",
    terms_sha256: termsSha256(json),
    outcome: "failed",
    verdicts: json.verdicts!.map((v, i) => ({
      verdict_id: v.id,
      condition_id: v.condition_id,
      check_kind: i === 0 ? "http_ok" : "dom_assert",
      outcome: v.passed ? "pass" : "fail",
      confidence: v.confidence,
      reasoning_sha256: sha256Hex(v.reasoning),
      evidence_sha256: sha256Hex(canonicalJson(v.evidence)),
      screenshots: i === 1 ? [{ path: "data/evidence/s1/0-dom.jpg", sha256: sha256Hex(SHOT) }] : [],
    })),
    verifier: { name: "clause", version: "0.1.0", model: "test-model" },
    started_at: "2026-11-12T10:00:00.000Z",
    finished_at: "2026-11-12T10:00:05.000Z",
    issued_at: "2026-11-12T10:00:05.100Z",
  };
}

/** Signs as the verifier does (independently of receipt.ts): Ed25519 over the hash's 32 bytes. */
function signBody(body: ReceiptBody, key: { privateKey: KeyObject; publicKey: KeyObject } = verifierKey): SignedReceipt {
  const hash = sha256Hex(canonicalJson(body));
  return {
    receipt: body,
    receipt_sha256: hash,
    signature: {
      algorithm: "Ed25519",
      key_fingerprint: sha256Hex(key.publicKey.export({ type: "spki", format: "der" })),
      value: sign(null, Buffer.from(hash, "hex"), key.privateKey).toString("base64"),
    },
  };
}

const failed = (checks: { check: string; ok: boolean | null }[]) => checks.filter((c) => c.ok === false).map((c) => c.check);

describe("checkReceipt", () => {
  it("a valid receipt holds against the key and the contract it is about", () => {
    const checks = checkReceipt(signBody(receiptBody()), publicKeyPem, contractJson());
    expect(checks.map((c) => [c.check, c.ok])).toEqual([
      ["receipt hash", true],
      ["signing key", true],
      ["signature", true],
      ["contract id", true],
      ["terms hash", true],
      ["verdict 1 (http_ok)", true],
      ["verdict 2 (dom_assert)", true],
    ]);
    expect(receiptHolds(checks)).toBe(true);
    expect(publicKeyFingerprint(publicKeyPem)).toBe(signBody(receiptBody()).signature.key_fingerprint);
  });

  it("survives a JSON round trip with keys in another order (as an API response)", () => {
    const signed = signBody(receiptBody());
    const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, receipt_sha256: signed.receipt_sha256, receipt: { ...signed.receipt } }));
    expect(receiptHolds(checkReceipt(reordered, publicKeyPem, JSON.parse(JSON.stringify(contractJson()))))).toBe(true);
  });

  it.each([
    ["a verdict's outcome", (r: SignedReceipt) => void (r.receipt.verdicts[1].outcome = "pass")],
    ["a verdict's confidence", (r: SignedReceipt) => void (r.receipt.verdicts[0].confidence = 0.99)],
    ["the run's outcome", (r: SignedReceipt) => void (r.receipt.outcome = "passed")],
    ["an evidence hash", (r: SignedReceipt) => void (r.receipt.verdicts[0].evidence_sha256 = sha256Hex("other evidence"))],
    ["a screenshot hash", (r: SignedReceipt) => void (r.receipt.verdicts[1].screenshots[0].sha256 = sha256Hex("other image"))],
    ["the terms hash", (r: SignedReceipt) => void (r.receipt.terms_sha256 = sha256Hex("other terms"))],
    ["the submitted URL", (r: SignedReceipt) => void (r.receipt.submitted_url = "https://elsewhere.example/")],
    ["a dropped verdict", (r: SignedReceipt) => void r.receipt.verdicts.pop()],
  ])("changing %s after signing breaks the hash and the signature", (_what, tamper) => {
    const signed = signBody(receiptBody());
    tamper(signed);
    const checks = checkReceipt(signed, publicKeyPem);
    expect(failed(checks)).toEqual(["receipt hash", "signature"]);
    expect(receiptHolds(checks)).toBe(false);
  });

  it("a receipt whose hash was recomputed after tampering still fails its signature", () => {
    const signed = signBody(receiptBody());
    signed.receipt.verdicts[1].outcome = "pass";
    signed.receipt_sha256 = sha256Hex(canonicalJson(signed.receipt));
    expect(failed(checkReceipt(signed, publicKeyPem))).toEqual(["signature"]);
  });

  it("a receipt re-signed with another key fails against the verifier's key", () => {
    const body = receiptBody();
    body.outcome = "passed";
    const forged = signBody(body, generateKeyPairSync("ed25519"));
    expect(failed(checkReceipt(forged, publicKeyPem))).toEqual(["signing key", "signature"]);
  });

  it("detects terms that differ from what was signed", () => {
    const json = contractJson();
    json.contract.amount_cents = 1;
    expect(failed(checkReceipt(signBody(receiptBody()), publicKeyPem, json))).toEqual(["terms hash"]);
    const reworded = contractJson();
    reworded.conditions[0].text = "Has any form";
    expect(failed(checkReceipt(signBody(receiptBody()), publicKeyPem, reworded))).toEqual(["terms hash"]);
  });

  it("detects stored evidence or reasoning that differs from what was signed", () => {
    const json = contractJson();
    (json.verdicts![1].evidence as Record<string, unknown>).found = 1;
    json.verdicts![0].reasoning = "Edited later.";
    const checks = checkReceipt(signBody(receiptBody()), publicKeyPem, json);
    expect(failed(checks)).toEqual(["verdict 1 (http_ok)", "verdict 2 (dom_assert)"]);
    expect(checks.find((c) => c.check === "verdict 1 (http_ok)")?.detail).toContain("reasoning");
    expect(checks.find((c) => c.check === "verdict 2 (dom_assert)")?.detail).toContain("evidence");
  });

  it("does not compare verdicts a later re-run replaced, and still holds", () => {
    const json = contractJson();
    json.verdicts = [];
    const checks = checkReceipt(signBody(receiptBody()), publicKeyPem, json);
    expect(checks.filter((c) => c.ok === null).map((c) => c.check)).toEqual(["verdict 1 (http_ok)", "verdict 2 (dom_assert)"]);
    expect(receiptHolds(checks)).toBe(true);
  });

  it("rejects things that are not receipts, and keys that are not Ed25519", () => {
    expect(checkReceipt({ hello: "world" }, publicKeyPem)).toEqual([{ check: "receipt format", ok: false, detail: "no `receipt` object" }]);
    expect(failed(checkReceipt({ ...signBody(receiptBody()), receipt_sha256: "abc" }, publicKeyPem))).toEqual(["receipt format"]);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(failed(checkReceipt(signBody(receiptBody()), rsa))).toEqual(["public key"]);
  });
});

// ---------------------------------------------------------------------------
// scripts/verify-receipt.ts as a real process
// ---------------------------------------------------------------------------

describe("scripts/verify-receipt.ts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clause-verify-receipt-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(name: string, data: unknown): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    return file;
  }

  function run(...args: string[]) {
    const root = process.cwd();
    return spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "scripts", "verify-receipt.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  const key = write("key.pem", publicKeyPem);
  const contract = write("contract.json", contractJson());

  it("exits 0 for valid receipts, checking the terms against the contract", () => {
    const list = write("receipts.json", { contract_id: "c1", terms_sha256: termsSha256(contractJson()), receipts: [signBody(receiptBody())] });
    const result = run(list, "--key", key, "--contract", contract);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok +terms hash/);
    expect(result.stdout).toContain("=> HOLDS");
    expect(result.stdout).toContain("every receipt holds");
  }, 30_000);

  it("exits 1 when a verdict was changed, naming the failed checks", () => {
    const signed = signBody(receiptBody());
    signed.receipt.verdicts[1].outcome = "pass";
    const result = run(write("tampered.json", signed), "--key", key);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/FAIL +receipt hash/);
    expect(result.stdout).toMatch(/FAIL +signature/);
    expect(result.stdout).toContain("DOES NOT HOLD");
  }, 30_000);

  it("exits 1 when the contract's terms differ from the signed terms hash", () => {
    const json = contractJson();
    json.contract.amount_cents = 1;
    const result = run(write("one.json", signBody(receiptBody())), "--key", key, "--contract", write("changed-contract.json", json));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/FAIL +terms hash/);
  }, 30_000);

  it("exits 2 without a key or app URL", () => {
    const result = run(write("lonely.json", signBody(receiptBody())));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--key");
  }, 30_000);
});
