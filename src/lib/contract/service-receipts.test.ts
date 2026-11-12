/**
 * Receipts through the contract service: every finished run issues a signed
 * receipt that the audit trail and the contract detail cite, and a receipt
 * that cannot be issued never changes the outcome or the money flow. PayPal
 * and the verifier are mocked as in service.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContract } from "@/lib/db/contracts";
import { getDb } from "@/lib/db/index";
import { listEvents } from "@/lib/db/events";
import { listLedgerEntries } from "@/lib/db/ledger";
import { checkReceipt, termsSha256 } from "@/lib/verifier/receipt-core";
import { verifierPublicKey } from "@/lib/verifier/signing-key";
import { withTempDb } from "@/test/helpers";
import { getContractDetail, getContractReceipts, rerunVerification, signContract } from "./service";
import { fund, installPayPalFakes, newContract, seedIdentities, submitAndVerify, verifierAnswers } from "./service-testkit";

vi.mock("@/lib/paypal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paypal")>();
  return {
    ...actual,
    createAuthorizedOrder: vi.fn(),
    authorizeOrder: vi.fn(),
    captureAuthorization: vi.fn(),
    voidAuthorization: vi.fn(),
    payout: vi.fn(),
    getPayoutBatch: vi.fn(),
    refundCapture: vi.fn(),
  };
});
vi.mock("@/lib/verifier", () => ({ verifySubmission: vi.fn() }));
vi.mock("@/lib/ai/mediator", () => ({ proposeSplit: vi.fn() }));
vi.mock("@/lib/ai/drafter", () => ({ draftContract: vi.fn() }));

withTempDb();

beforeEach(() => {
  vi.resetAllMocks();
  seedIdentities();
  installPayPalFakes();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const completed = (contractId: string) => listEvents(contractId).filter((e) => e.kind === "VERIFICATION_COMPLETED");
/** The detail as the API serialises it. */
const detailJson = (contractId: string) => JSON.parse(JSON.stringify(getContractDetail(contractId, "payer")));

describe("terms hash in the contract detail", () => {
  it("is null while DRAFT and fixed at signing, matching the terms the detail shows", () => {
    const contract = newContract();
    expect(getContractDetail(contract.id, "payer").terms_sha256).toBeNull();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const detail = detailJson(contract.id);
    expect(detail.terms_sha256).toBe(termsSha256(detail));
    expect(getContractReceipts(contract.id)).toEqual({ contract_id: contract.id, terms_sha256: detail.terms_sha256, receipts: [] });
  });

  it("is computed for a contract signed before receipts existed", async () => {
    const contract = newContract();
    await fund(contract.id);
    const atSigning = getContractDetail(contract.id, "payer").terms_sha256;
    getDb().prepare(`UPDATE contracts SET terms_hash = NULL WHERE id = ?`).run(contract.id);
    expect(getContractDetail(contract.id, "payer").terms_sha256).toBe(atSigning);
  });
});

describe("receipts for verification runs", () => {
  it("issues a signed receipt per finished run, cited by the audit trail and the detail", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "3600");
    await submitAndVerify(contract.id, "inconclusive");
    verifierAnswers("passed");
    await rerunVerification(contract.id, "payer").run();
    expect(getContract(contract.id)!.state).toBe("PASSED");

    const { receipts } = getContractReceipts(contract.id);
    expect(receipts.map((r) => r.receipt.outcome)).toEqual(["passed", "inconclusive"]);
    expect(completed(contract.id).map((e) => e.detail.receipt_sha256)).toEqual([receipts[1].receipt_sha256, receipts[0].receipt_sha256]);

    const detail = detailJson(contract.id);
    expect(detail.receipt).toEqual(receipts[0]);
    const checks = checkReceipt(detail.receipt, verifierPublicKey().public_key_pem, detail);
    expect(checks.filter((c) => c.ok !== true)).toEqual([]);
    // The older run's receipt still holds.
    expect(checkReceipt(receipts[1], verifierPublicKey().public_key_pem, detail).filter((c) => c.ok === false)).toEqual([]);
  });

  it("a receipt that cannot be issued changes nothing else: the pass stands and is paid", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VERIFIER_SIGNING_KEY", "not a key");
    const contract = newContract();
    await fund(contract.id);
    await submitAndVerify(contract.id, "passed");

    expect(getContract(contract.id)!.state).toBe("PAID");
    expect(listLedgerEntries({ contract_id: contract.id }).map((e) => e.kind)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    const [event] = completed(contract.id);
    expect(event.detail).toMatchObject({ outcome: "passed", receipt_error: expect.stringContaining("VERIFIER_SIGNING_KEY") });
    expect(event.detail.receipt_sha256).toBeUndefined();
    expect(getContractReceipts(contract.id).receipts).toEqual([]);
    expect(errorLog).toHaveBeenCalled();
  });
});
