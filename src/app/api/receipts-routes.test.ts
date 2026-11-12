/**
 * `GET /api/verifier/public-key` and `GET /api/contracts/[id]/receipts`, and
 * the receipt and terms hash added to `GET /api/contracts/[id]`, against a
 * temp database with PayPal and the verifier mocked (docs/api.md).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fund, installPayPalFakes, newContract, seedIdentities, submitAndVerify } from "@/lib/contract/service-testkit";
import { checkReceipt, publicKeyFingerprint, termsSha256 } from "@/lib/verifier/receipt-core";
import { getViewerRole } from "@/lib/viewer";
import { withTempDb } from "@/test/helpers";
import * as detailRoute from "./contracts/[id]/route";
import * as receiptsRoute from "./contracts/[id]/receipts/route";
import * as publicKeyRoute from "./verifier/public-key/route";

vi.mock("@/lib/viewer", () => ({ getViewerRole: vi.fn() }));
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
  vi.unstubAllEnvs();
  seedIdentities();
  installPayPalFakes();
  vi.mocked(getViewerRole).mockResolvedValue("worker");
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = () => new Request("http://clause.test/api");

async function call(res: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await res;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET /api/verifier/public-key", () => {
  it("returns the signing key as PEM and JWK with its fingerprint, the same on every call", async () => {
    const first = await call(publicKeyRoute.GET());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      algorithm: "Ed25519",
      public_key_pem: expect.stringMatching(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/),
      public_key_jwk: { kty: "OKP", crv: "Ed25519", x: expect.any(String) },
    });
    expect(first.body.fingerprint).toBe(publicKeyFingerprint(first.body.public_key_pem as string));
    expect((await call(publicKeyRoute.GET())).body).toEqual(first.body);
  });
});

describe("GET /api/contracts/[id]/receipts", () => {
  it("lists the contract's receipts, which check against the public key and the contract detail", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "3600");
    await submitAndVerify(contract.id, "failed");

    const { status, body } = await call(receiptsRoute.GET(get(), params(contract.id)));
    expect(status).toBe(200);
    const receipts = body.receipts as { receipt: { outcome: string; contract_id: string } }[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receipt).toMatchObject({ outcome: "failed", contract_id: contract.id });

    const detail = (await call(detailRoute.GET(get(), params(contract.id)))).body;
    expect(body.terms_sha256).toBe(detail.terms_sha256);
    expect(detail.terms_sha256).toBe(termsSha256(detail as never));
    expect(detail.receipt).toEqual(receipts[0]);
    const key = (await call(publicKeyRoute.GET())).body.public_key_pem as string;
    expect(checkReceipt(receipts[0], key, detail as never).filter((c) => c.ok !== true)).toEqual([]);
  });

  it("answers NOT_FOUND for an unknown contract, and an empty list before any run", async () => {
    const missing = await call(receiptsRoute.GET(get(), params("nope")));
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    const contract = newContract();
    expect((await call(receiptsRoute.GET(get(), params(contract.id)))).body).toEqual({
      contract_id: contract.id,
      terms_sha256: null,
      receipts: [],
    });
  });
});
