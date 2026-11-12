/**
 * Route handlers: body validation, error mapping and the HTTP shapes in
 * docs/api.md. The service underneath runs for real against a temp database;
 * PayPal, the verifier, the AI roles, the view-as cookie and `after` are
 * mocked at the module boundary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as drafter from "@/lib/ai/drafter";
import { ServiceError } from "@/lib/contract/service-errors";
import * as mediator from "@/lib/ai/mediator";
import { getDb } from "@/lib/db/index";
import { listLedgerEntries } from "@/lib/db/ledger";
import { MissingEnvError } from "@/lib/env";
import * as paypal from "@/lib/paypal";
import type { Party } from "@/lib/types";
import { getViewerRole } from "@/lib/viewer";
import { setEvidenceRootForTests } from "@/lib/verifier/evidence";
import { withTempDb } from "@/test/helpers";
import {
  CONDITIONS,
  daysFromNow,
  fund,
  installPayPalFakes,
  newContract,
  seedIdentities,
  verifierAnswers,
} from "@/lib/contract/service-testkit";
import * as contractsRoute from "./contracts/route";
import * as draftRoute from "./contracts/draft/route";
import * as detailRoute from "./contracts/[id]/route";
import * as conditionsRoute from "./contracts/[id]/conditions/route";
import * as signRoute from "./contracts/[id]/sign/route";
import * as createOrderRoute from "./contracts/[id]/fund/create-order/route";
import * as authorizeRoute from "./contracts/[id]/fund/authorize/route";
import * as submitRoute from "./contracts/[id]/submit/route";
import * as verifyRoute from "./contracts/[id]/verify/route";
import * as disputeRoute from "./contracts/[id]/dispute/route";
import * as respondRoute from "./contracts/[id]/dispute/respond/route";
import * as acceptRoute from "./contracts/[id]/dispute/accept/route";
import * as sweepRoute from "./sweep/route";
import * as ledgerRoute from "./ledger/route";
import * as configRoute from "./config/route";
import * as evidenceRoute from "./evidence/[submissionId]/[file]/route";

const scheduled = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    scheduled.push(task);
  },
}));
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
  scheduled.length = 0;
  seedIdentities();
  installPayPalFakes();
  viewAs("payer");
});

function viewAs(party: Party): void {
  vi.mocked(getViewerRole).mockResolvedValue(party);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function req(body?: unknown, raw?: string): Request {
  return new Request("http://clause.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

async function call(res: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await res;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function expectError(res: Promise<Response>, status: number, code: string, message?: string | RegExp) {
  const { status: got, body } = await call(res);
  expect({ status: got, code: (body.error as { code: string }).code }).toEqual({ status, code });
  expect(typeof (body.error as { message: unknown }).message).toBe("string");
  if (message) expect((body.error as { message: string }).message).toMatch(message);
  return body;
}

const proposal = (overrides: Record<string, unknown> = {}) => ({
  title: "Landing page",
  type: "website_milestone",
  amount_cents: 20000,
  currency: "USD",
  deadline_at: daysFromNow(3),
  conditions: CONDITIONS.website_milestone,
  notes: ["note"],
  ...overrides,
});

describe("POST /api/contracts/draft", () => {
  it("returns the drafter's result unchanged", async () => {
    const result: drafter.DraftResult = {
      kind: "refusal",
      vague_conditions: [{ condition: "nice", reason: "vague", suggested_rewrite: "x" }],
    };
    vi.mocked(drafter.draftContract).mockResolvedValue(result);
    expect(await call(draftRoute.POST(req({ prompt: "make it nice" })))).toEqual({ status: 200, body: result });
  });

  it("validates the body and the party", async () => {
    await expectError(draftRoute.POST(req({})), 400, "VALIDATION_ERROR", /prompt: is required/);
    await expectError(draftRoute.POST(req(undefined, "{not json")), 400, "VALIDATION_ERROR", /not valid JSON/);
    await expectError(draftRoute.POST(req({ prompt: "x", type: "poem" })), 400, "VALIDATION_ERROR", /type/);
    viewAs("worker");
    await expectError(draftRoute.POST(req({ prompt: "x" })), 403, "FORBIDDEN");
  });

  it("maps AI failures to AI_ERROR and a missing key to NOT_CONFIGURED", async () => {
    vi.mocked(drafter.draftContract).mockRejectedValueOnce(new Error("bad gateway"));
    await expectError(draftRoute.POST(req({ prompt: "x" })), 502, "AI_ERROR");
    vi.mocked(drafter.draftContract).mockRejectedValueOnce(new MissingEnvError("AI (DeepSeek)", ["DEEPSEEK_API_KEY"]));
    await expectError(draftRoute.POST(req({ prompt: "x" })), 503, "NOT_CONFIGURED", /DEEPSEEK_API_KEY/);
  });
});

describe("POST /api/contracts and GET", () => {
  it("creates a DRAFT (201) and lists and reads it", async () => {
    const created = await call(contractsRoute.POST(req(proposal({ currency: null }))));
    expect(created.status).toBe(201);
    const contract = created.body.contract as { id: string; state: string; currency: string };
    expect(contract).toMatchObject({ state: "DRAFT", currency: "USD" });

    const list = await call(contractsRoute.GET());
    expect((list.body.contracts as { id: string }[]).map((c) => c.id)).toEqual([contract.id]);

    viewAs("worker");
    const detail = await call(detailRoute.GET(req(), params(contract.id)));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      contract: { id: contract.id },
      viewer: { role: "worker" },
      allowed_actions: ["edit_conditions", "sign"],
      notes: ["note"],
      verification: null,
      activity: { in_progress: null, last_failure: null },
      payout: null,
      dispute: null,
    });
    expect(Object.keys(detail.body).sort()).toEqual(
      ["activity", "allowed_actions", "conditions", "contract", "dispute", "events", "ledger", "notes", "payout", "receipt", "submissions", "terms_sha256", "verdicts", "verification", "viewer"],
    );
  });

  it("names the missing term when the draft left it null", async () => {
    await expectError(contractsRoute.POST(req(proposal({ amount_cents: null }))), 400, "VALIDATION_ERROR", /amount_cents: is required \(the deal did not state an amount\)/);
    await expectError(contractsRoute.POST(req(proposal({ deadline_at: null }))), 400, "VALIDATION_ERROR", /deadline_at: is required/);
    await expectError(contractsRoute.POST(req(proposal({ deadline_at: "2020-01-01T00:00:00Z" }))), 400, "VALIDATION_ERROR", /future/);
    await expectError(contractsRoute.POST(req(proposal({ amount_cents: 12.5 }))), 400, "VALIDATION_ERROR", /amount_cents: must be whole cents/);
    await expectError(contractsRoute.POST(req(proposal({ conditions: [] }))), 400, "VALIDATION_ERROR", /conditions: needs at least one condition/);
    await expectError(
      contractsRoute.POST(req(proposal({ conditions: [{ text: "x", check_kind: "dom_assert", check_params: {} }] }))),
      400,
      "VALIDATION_ERROR",
      /conditions\.0/,
    );
  });

  it("takes USD only and at most $5,000.00, so PayPal never refuses the funding (DEF-18)", async () => {
    for (const currency of ["XYZ", "EUR", "US"]) {
      await expectError(contractsRoute.POST(req(proposal({ currency }))), 400, "VALIDATION_ERROR", /^currency: must be USD: contracts are paid in US dollars only$/);
    }
    for (const amount_cents of [500_001, 9_000_000_000_000]) {
      await expectError(contractsRoute.POST(req(proposal({ amount_cents }))), 400, "VALIDATION_ERROR", /^amount_cents: must be at most 500000 \(\$5,000\.00, the most one contract may hold\)$/);
    }
    const created = await call(contractsRoute.POST(req(proposal({ currency: " usd ", amount_cents: 500_000 }))));
    expect(created.status).toBe(201);
    expect(created.body.contract).toMatchObject({ currency: "USD", amount_cents: 500_000 });
  });

  it("bounds the responsive width and the number of conditions", async () => {
    const responsive = (width: number) => ({ text: "Phone", check_kind: "responsive", check_params: { width } });
    for (const width of [239, 3841]) {
      await expectError(contractsRoute.POST(req(proposal({ conditions: [responsive(width)] }))), 400, "VALIDATION_ERROR", /conditions\.0\.check_params\.width/);
    }
    expect((await call(contractsRoute.POST(req(proposal({ conditions: [responsive(240), responsive(3840)] }))))).status).toBe(201);

    const many = (n: number) => Array.from({ length: n }, () => CONDITIONS.website_milestone[0]);
    await expectError(contractsRoute.POST(req(proposal({ conditions: many(21) }))), 400, "VALIDATION_ERROR", /conditions: has more than 20 conditions/);
    const created = await call(contractsRoute.POST(req(proposal({ conditions: many(20) }))));
    expect(created.status).toBe(201);
    const id = (created.body.contract as { id: string }).id;
    await expectError(conditionsRoute.PATCH(req({ conditions: many(21) }), params(id)), 400, "VALIDATION_ERROR", /more than 20/);
  });

  it("answers INVALID_CONDITION for a check kind of the other contract type", async () => {
    await expectError(contractsRoute.POST(req(proposal({ conditions: CONDITIONS.code_bounty }))), 422, "INVALID_CONDITION");
  });

  it("answers FORBIDDEN for the worker and NOT_FOUND for an unknown id", async () => {
    viewAs("worker");
    await expectError(contractsRoute.POST(req(proposal())), 403, "FORBIDDEN");
    await expectError(detailRoute.GET(req(), params("nope")), 404, "NOT_FOUND");
  });

  it("answers INTERNAL with a safe message for an unexpected error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getViewerRole).mockRejectedValueOnce(new Error("disk on fire"));
    const body = await expectError(detailRoute.GET(req(), params("x")), 500, "INTERNAL");
    expect(JSON.stringify(body)).not.toContain("disk on fire");
    spy.mockRestore();
  });
});

describe("conditions and signing", () => {
  it("edits in DRAFT, then locks after signing", async () => {
    const contract = newContract();
    const edited = await call(
      conditionsRoute.PATCH(req({ conditions: [CONDITIONS.website_milestone[0]] }), params(contract.id)),
    );
    expect(edited.status).toBe(200);
    expect((edited.body.conditions as unknown[]).length).toBe(1);
    await expectError(conditionsRoute.PATCH(req({ conditions: "x" }), params(contract.id)), 400, "VALIDATION_ERROR");

    expect((await call(signRoute.POST(req(), params(contract.id)))).body.contract).toMatchObject({ state: "DRAFT" });
    viewAs("worker");
    expect((await call(signRoute.POST(req(), params(contract.id)))).body.contract).toMatchObject({ state: "SIGNED" });
    await expectError(
      conditionsRoute.PATCH(req({ conditions: CONDITIONS.website_milestone }), params(contract.id)),
      409,
      "CONTRACT_LOCKED",
    );
    await expectError(signRoute.POST(req(), params(contract.id)), 409, "ILLEGAL_TRANSITION");
  });

  it("answers 409 DEADLINE_PASSED for signing a draft past its deadline (DEF-15)", async () => {
    const contract = newContract();
    getDb().prepare(`UPDATE contracts SET deadline_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), contract.id);
    await expectError(signRoute.POST(req(), params(contract.id)), 409, "DEADLINE_PASSED", /^Cannot sign: the deadline .* has passed\.$/);
    const detail = await call(detailRoute.GET(req(), params(contract.id)));
    expect(detail.body).toMatchObject({ contract: { state: "DRAFT", payer_signed_at: null }, allowed_actions: ["edit_conditions"] });
  });

  it("answers 409 ROLE_MISMATCH and signs nothing when another tab switched the role (DEF-20)", async () => {
    const contract = newContract();
    vi.mocked(getViewerRole).mockRejectedValueOnce(new ServiceError("ROLE_MISMATCH", "You switched to the worker in another tab."));
    await expectError(signRoute.POST(req(), params(contract.id)), 409, "ROLE_MISMATCH", /another tab/);
    expect((await call(detailRoute.GET(req(), params(contract.id)))).body.contract).toMatchObject({
      payer_signed_at: null,
      worker_signed_at: null,
    });
  });
});

describe("funding", () => {
  it("creates the order and authorizes it", async () => {
    const contract = newContract();
    await expectError(createOrderRoute.POST(req(), params(contract.id)), 409, "ILLEGAL_TRANSITION");
    viewAs("payer");
    await call(signRoute.POST(req(), params(contract.id)));
    viewAs("worker");
    await call(signRoute.POST(req(), params(contract.id)));
    await expectError(createOrderRoute.POST(req(), params(contract.id)), 403, "FORBIDDEN");

    viewAs("payer");
    const order = await call(createOrderRoute.POST(req(), params(contract.id)));
    expect(order).toEqual({ status: 200, body: { orderId: `ORDER-${contract.id}` } });

    await expectError(authorizeRoute.POST(req({}), params(contract.id)), 400, "VALIDATION_ERROR", /orderId: is required/);
    await expectError(authorizeRoute.POST(req({ orderId: "ORDER-x" }), params(contract.id)), 409, "ORDER_MISMATCH");
    const funded = await call(authorizeRoute.POST(req({ orderId: order.body.orderId }), params(contract.id)));
    expect(funded.status).toBe(200);
    expect(funded.body.contract).toMatchObject({ state: "FUNDED", paypal_authorization_id: `AUTH-${contract.id}` });
  });

  it("maps PayPal failures to PAYPAL_ERROR and missing credentials to NOT_CONFIGURED", async () => {
    const contract = newContract();
    await call(signRoute.POST(req(), params(contract.id)));
    viewAs("worker");
    await call(signRoute.POST(req(), params(contract.id)));
    viewAs("payer");
    vi.mocked(paypal.createAuthorizedOrder).mockRejectedValueOnce(
      new paypal.PayPalError({ operation: "create order", status: 500, paypalName: "INTERNAL_SERVER_ERROR", paypalMessage: "x", debugId: null }),
    );
    await expectError(createOrderRoute.POST(req(), params(contract.id)), 502, "PAYPAL_ERROR");
    vi.mocked(paypal.createAuthorizedOrder).mockRejectedValueOnce(
      new MissingEnvError("PayPal", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]),
    );
    await expectError(createOrderRoute.POST(req(), params(contract.id)), 503, "NOT_CONFIGURED", /PAYPAL_CLIENT_ID/);
  });
});

describe("submitting and verifying", () => {
  it("answers 202 and runs verification after the response", async () => {
    const contract = newContract();
    await fund(contract.id);
    await expectError(submitRoute.POST(req({ url: "ftp://x" }), params(contract.id)), 400, "VALIDATION_ERROR", /url: must be an http or https URL/);
    await expectError(submitRoute.POST(req({ url: "https://site.test/" }), params(contract.id)), 403, "FORBIDDEN");

    viewAs("worker");
    verifierAnswers("passed");
    const submitted = await call(submitRoute.POST(req({ url: "https://site.test/" }), params(contract.id)));
    expect(submitted.status).toBe(202);
    expect(scheduled).toHaveLength(1);
    const during = await call(detailRoute.GET(req(), params(contract.id)));
    expect(during.body).toMatchObject({
      contract: { state: "VERIFYING" },
      verification: { status: "running", submission_id: submitted.body.submissionId },
      activity: { in_progress: "verify" },
    });
    await expectError(submitRoute.POST(req({ url: "https://site.test/" }), params(contract.id)), 409, "BUSY");

    await scheduled[0]();
    const done = await call(detailRoute.GET(req(), params(contract.id)));
    expect(done.body).toMatchObject({ contract: { state: "PAID" }, verification: { status: "passed" } });
  });

  it("re-runs only an unfinished verification", async () => {
    const contract = newContract();
    await fund(contract.id);
    await expectError(verifyRoute.POST(req(), params(contract.id)), 409, "ILLEGAL_TRANSITION");
    viewAs("worker");
    verifierAnswers("inconclusive");
    await call(submitRoute.POST(req({ url: "https://site.test/" }), params(contract.id)));
    await scheduled[0]();
    viewAs("payer");
    const rerun = await call(verifyRoute.POST(req(), params(contract.id)));
    expect(rerun.status).toBe(202);
    expect(scheduled).toHaveLength(2);
  });
});

describe("disputes", () => {
  it("opens, responds, and declines to ESCALATED", async () => {
    const contract = newContract();
    await fund(contract.id);
    await expectError(disputeRoute.POST(req({ argument: "  " }), params(contract.id)), 400, "VALIDATION_ERROR", /argument: is empty/);
    const opened = await call(disputeRoute.POST(req({ argument: "Nothing delivered." }), params(contract.id)));
    expect(opened.body.dispute).toMatchObject({ state: "OPEN", opened_by: "payer" });
    await expectError(acceptRoute.POST(req(), params(contract.id)), 409, "DISPUTE_STATE");

    viewAs("worker");
    vi.mocked(mediator.proposeSplit).mockResolvedValue({ proposed_worker_cents: 5000, reasoning: "Some work." });
    const proposed = await call(respondRoute.POST(req({ argument: "I delivered." }), params(contract.id)));
    expect(proposed.body.dispute).toMatchObject({ state: "PROPOSED", proposed_worker_cents: 5000 });

    await expectError(acceptRoute.POST(req({ accept: "no" }), params(contract.id)), 400, "VALIDATION_ERROR");
    const declined = await call(acceptRoute.POST(req({ accept: false }), params(contract.id)));
    expect(declined.body).toMatchObject({ dispute: { state: "ESCALATED" }, contract: { state: "ESCALATED" } });
  });

  it("accepts with no body and settles when both accept", async () => {
    const contract = newContract();
    await fund(contract.id);
    await call(disputeRoute.POST(req({ argument: "a" }), params(contract.id)));
    viewAs("worker");
    vi.mocked(mediator.proposeSplit).mockResolvedValue({ proposed_worker_cents: 5000, reasoning: "Some work." });
    await call(respondRoute.POST(req({ argument: "b" }), params(contract.id)));
    await call(acceptRoute.POST(req(), params(contract.id)));
    viewAs("payer");
    const settled = await call(acceptRoute.POST(req(), params(contract.id)));
    expect(settled.body).toMatchObject({ dispute: { state: "SETTLED" }, contract: { state: "SETTLED" } });
  });
});

describe("sweep, ledger, config", () => {
  it("sweeps and lists the ledger with contract titles", async () => {
    const contract = newContract();
    await fund(contract.id);
    expect(await call(sweepRoute.POST())).toEqual({ status: 200, body: { expired: [], settled: [], errors: [] } });
    const ledger = await call(ledgerRoute.GET());
    expect(ledger.body.entries).toMatchObject([
      { kind: "AUTHORIZED", contract_title: contract.title, contract_state: "FUNDED", currency: "USD" },
    ]);
  });

  it("never returns the stored PayPal response bodies", async () => {
    const contract = newContract();
    await fund(contract.id);
    expect(listLedgerEntries({ contract_id: contract.id })[0].raw).toMatchObject({ id: expect.any(String) });
    const ledger = await call(ledgerRoute.GET());
    const detail = await call(detailRoute.GET(req(), params(contract.id)));
    for (const entry of [...(ledger.body.entries as object[]), ...(detail.body.ledger as object[])]) {
      expect(entry).not.toHaveProperty("raw");
    }
    expect(JSON.stringify([ledger.body, detail.body])).not.toContain("purchase_units");
  });

  it("returns the PayPal client id, or NOT_CONFIGURED", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    await expectError(configRoute.GET(), 503, "NOT_CONFIGURED", /PAYPAL_CLIENT_ID/);
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-123");
    expect(await call(configRoute.GET())).toEqual({ status: 200, body: { paypalClientId: "client-123" } });
  });
});

describe("GET /api/evidence/[submissionId]/[file]", () => {
  let dir = "";
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const get = (submissionId: string, file: string) =>
    evidenceRoute.GET(req(), { params: Promise.resolve({ submissionId, file }) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clause-evidence-"));
    const root = path.join(dir, "data", "evidence");
    fs.mkdirSync(path.join(root, "sub-1"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub-1", "0-responsive-375px-abc.jpg"), JPEG);
    fs.writeFileSync(path.join(root, "sub-1", "notes.txt"), "not an image");
    fs.writeFileSync(path.join(dir, "data", "secret.jpg"), "outside the evidence directory");
    fs.symlinkSync(path.join(dir, "data", "secret.jpg"), path.join(root, "sub-1", "link.jpg"));
    setEvidenceRootForTests(root);
  });
  afterEach(() => {
    setEvidenceRootForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves a stored screenshot with its image type", async () => {
    const res = await get("sub-1", "0-responsive-375px-abc.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("refuses names that could leave the evidence directory", async () => {
    for (const [submissionId, file] of [
      ["sub-1", "../secret.jpg"],
      ["..", "secret.jpg"],
      ["sub-1", "..%2Fsecret.jpg"],
      ["sub-1", ".hidden.jpg"],
      ["sub-1", "a\\..\\secret.jpg"],
      [".", "0-responsive-375px-abc.jpg"],
      ["sub-1", "x.jpg\u0000"],
    ]) {
      await expectError(get(submissionId, file), 400, "VALIDATION_ERROR");
    }
  });

  it("answers NOT_FOUND for a missing file, a non-image, or a symlink that points outside", async () => {
    await expectError(get("sub-1", "missing.jpg"), 404, "NOT_FOUND");
    await expectError(get("sub-2", "0-responsive-375px-abc.jpg"), 404, "NOT_FOUND");
    await expectError(get("sub-1", "notes.txt"), 404, "NOT_FOUND");
    await expectError(get("sub-1", "link.jpg"), 404, "NOT_FOUND");
  });
});
