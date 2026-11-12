/**
 * The MCP endpoint end to end: a real MCP client from the SDK talks to the
 * real `/api/mcp` route handler (its fetch calls the handler directly), which
 * builds the real tools over the real contract service and database. Only
 * PayPal, the verifier, the drafter and `after` are faked, as in the route
 * tests.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mcpRoute from "@/app/api/mcp/route";
import * as drafter from "@/lib/ai/drafter";
import * as verifier from "@/lib/verifier";
import { createAgentToken, FUND_REFUSAL } from "@/lib/agent/tokens";
import { revokeAgentToken } from "@/lib/db/agent-tokens";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { getSubmission } from "@/lib/db/submissions";
import { createVerdict } from "@/lib/db/verdicts";
import { daysFromNow, fund, installPayPalFakes, seedIdentities, verifierAnswers } from "@/lib/contract/service-testkit";
import { withTempDb } from "@/test/helpers";
import type { Party } from "@/lib/types";

const scheduled = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    scheduled.push(task);
  },
}));
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
  scheduled.length = 0;
  seedIdentities();
  installPayPalFakes();
});

const ENDPOINT = "http://proviso.test/api/mcp";

/** Calls the route handler for the request's method, as Next.js would. */
function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(url, init);
  const method = request.method as "POST" | "GET" | "DELETE";
  return mcpRoute[method](request);
}

type Era = "legacy" | "modern";

async function connect(token: string, era: Era = "legacy"): Promise<Client> {
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: routeFetch,
    }),
  );
  return client;
}

async function agent(role: Party, options: { allowSign?: boolean; readOnly?: boolean } = {}, era: Era = "legacy") {
  return connect(createAgentToken({ role, ...options }).token, era);
}

function text(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block");
  return block.text;
}

/** Calls a tool that must succeed and returns its JSON. */
async function ok<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${text(result)}`);
  return JSON.parse(text(result)) as T;
}

/** Calls a tool that must fail and returns the API error it carries. */
async function refused(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return JSON.parse(text(result)) as { error: { code: string; message: string }; http_status: number };
}

async function runScheduled(): Promise<void> {
  while (scheduled.length) await scheduled.shift()!();
}

const proposal = () => ({
  title: "Landing page",
  type: "website_milestone",
  amount_cents: 2500,
  currency: "USD",
  deadline_at: daysFromNow(3),
  conditions: [
    { text: "Loads at a public URL", check_kind: "http_ok", check_params: {} },
    { text: "Says what the studio offers", check_kind: "ai_page_judgement", check_params: { criterion: "The page says what the studio offers." } },
  ],
  notes: ["Read 'loads' as a 2xx response."],
});

const TOOLS = [
  "accept_proposal",
  "check_receipt",
  "create_contract",
  "decline_proposal",
  "draft_contract",
  "get_contract",
  "get_funding_instructions",
  "get_ledger",
  "get_verification",
  "list_contracts",
  "open_dispute",
  "rerun_verification",
  "respond_to_dispute",
  "sign_contract",
  "submit_work",
  "whoami",
];

describe("authentication", () => {
  const initialize = (headers: Record<string, string> = {}) =>
    mcpRoute.POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
        }),
      }),
    );

  it("answers 401 with a bearer challenge when there is no token", async () => {
    const response = await initialize();
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });

  it("answers 401 to a revoked or unknown token", async () => {
    const { token, row } = createAgentToken({ role: "payer" });
    revokeAgentToken(row.id);
    expect((await initialize({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await initialize({ Authorization: "Bearer proviso_unknown" })).status).toBe(401);
    await expect(connect(token)).rejects.toThrow();
  });
});

describe.each<Era>(["legacy", "modern"])("tools over the %s protocol era", (era) => {
  it("lists every tool, each with a description and an input schema", async () => {
    const client = await agent("worker", {}, era);
    expect(client.getProtocolEra()).toBe(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(client.getInstructions()).toMatch(/PayPal/);
  });

  it("says who the token acts as", async () => {
    const client = await agent("payer", { allowSign: true }, era);
    expect(await ok(client, "whoami")).toMatchObject({ role: "payer", scopes: ["read", "write", "sign"] });
  });
});

describe("roles and scopes", () => {
  it("refuses drafting and creating to the worker with the service's FORBIDDEN", async () => {
    const worker = await agent("worker");
    expect(await refused(worker, "draft_contract", { prompt: "Build me a page for $50" })).toMatchObject({
      error: { code: "FORBIDDEN" },
      http_status: 403,
    });
    expect((await refused(worker, "create_contract", proposal())).error.code).toBe("FORBIDDEN");
    expect(drafter.draftContract).not.toHaveBeenCalled();
  });

  it("validates input with the HTTP API's schemas and messages", async () => {
    const payer = await agent("payer");
    const { amount_cents: _drop, ...noAmount } = proposal();
    const err = await refused(payer, "create_contract", noAmount);
    expect(err).toMatchObject({ error: { code: "VALIDATION_ERROR" }, http_status: 400 });
    expect(err.error.message).toMatch(/^amount_cents: is required/);
    expect((await refused(payer, "get_contract", {})).error.message).toBe("contract_id: is required");
    expect((await refused(payer, "get_contract", { contract_id: "nope" })).error.code).toBe("NOT_FOUND");
  });

  it("refuses signing without the sign scope and lists it as a person's step", async () => {
    const payer = await agent("payer");
    const { contract } = await ok<{ contract: { id: string } }>(payer, "create_contract", proposal());
    expect((await refused(payer, "sign_contract", { contract_id: contract.id })).error.message).toMatch(/--allow-sign/);
    expect(getContract(contract.id)?.payer_signed_at).toBeNull();
    const view = await ok<{ you_can_now: string[]; needs_a_person: { action: string }[] }>(payer, "get_contract", {
      contract_id: contract.id,
    });
    expect(view.you_can_now).not.toContain("sign_contract");
    expect(view.needs_a_person.map((n) => n.action)).toContain("sign");
  });

  it("refuses every change to a read-only token", async () => {
    const payer = await agent("payer");
    const { contract } = await ok<{ contract: { id: string } }>(payer, "create_contract", proposal());
    const reader = await agent("worker", { readOnly: true });
    expect((await refused(reader, "open_dispute", { contract_id: contract.id, argument: "no" })).error.code).toBe("FORBIDDEN");
    expect(await ok(reader, "get_contract", { contract_id: contract.id })).toMatchObject({ you: { role: "worker" } });
  });
});

describe("a contract from draft to receipt", () => {
  it("drafts, creates, signs, explains funding without funding, submits, verifies and checks the receipt", async () => {
    vi.mocked(drafter.draftContract).mockResolvedValue({ kind: "draft", contract: { ...proposal(), currency: "USD" } } as never);
    const buyer = await agent("payer", { allowSign: true });
    const seller = await agent("worker", { allowSign: true }, "modern");

    const draft = await ok<{ kind: string; contract: ReturnType<typeof proposal> }>(buyer, "draft_contract", {
      prompt: "A landing page for my yoga studio, $25, due in three days.",
    });
    expect(draft.kind).toBe("draft");
    const created = await ok<{ contract: { id: string; state: string }; page_url: string }>(buyer, "create_contract", draft.contract);
    const id = created.contract.id;
    expect(created.page_url).toBe(`http://proviso.test/contracts/${id}`);

    await ok(buyer, "sign_contract", { contract_id: id });
    const signed = await ok<{ contract: { state: string } }>(seller, "sign_contract", { contract_id: id });
    expect(signed.contract.state).toBe("SIGNED");

    const funding = await ok<{ can_be_funded_now: boolean; who: string; funding_page_url: string }>(seller, "get_funding_instructions", {
      contract_id: id,
    });
    expect(funding).toMatchObject({ can_be_funded_now: true, who: "the payer, a person", funding_page_url: created.page_url });
    expect(getContract(id)?.state).toBe("SIGNED");
    const asBuyer = await ok<{ needs_a_person: { action: string; why: string }[] }>(buyer, "get_contract", { contract_id: id });
    expect(asBuyer.needs_a_person.find((n) => n.action === "fund")?.why).toMatch(/PayPal/);

    await fund(id); // the payer approving in PayPal's window, done here by the service as the payer

    vi.mocked(verifier.verifySubmission).mockImplementation(async (submissionId) => {
      const submission = getSubmission(submissionId)!;
      const verdicts = listConditions(submission.contract_id).map((condition, i) =>
        createVerdict({
          submission_id: submissionId,
          condition_id: condition.id,
          passed: true,
          confidence: 1,
          reasoning: `check ${i} passed`,
          evidence:
            i === 1
              ? {
                  outcome: "pass",
                  screenshots: [`data/evidence/${submissionId}/desktop-1.jpg`],
                  panel: {
                    size: 2,
                    rule: "pass or fail only if every reviewer agrees",
                    decision: "pass",
                    agreement: 1,
                    votes: [
                      { reviewer: "literal", vote: "pass", criterion_met: true, confidence: 0.9, reasoning: "It lists classes.", observations: [], manipulation_reported: false, manipulation_quotes: [], attempts: 1 },
                      { reviewer: "skeptic", vote: "pass", criterion_met: true, confidence: 0.85, reasoning: "Offer is stated.", observations: [], manipulation_reported: false, manipulation_quotes: [], attempts: 1 },
                    ],
                  },
                }
              : { outcome: "pass" },
        }),
      );
      return { contractId: submission.contract_id, submissionId, verdicts, allPassed: true, outcome: "passed", inconclusive: [] };
    });

    expect((await refused(buyer, "submit_work", { contract_id: id, url: "https://example.com" })).error.code).toBe("FORBIDDEN");
    expect((await refused(seller, "submit_work", { contract_id: id, url: "ftp://example.com" })).error.code).toBe("VALIDATION_ERROR");
    const submitted = await ok<{ submission_id: string; state: string }>(seller, "submit_work", {
      contract_id: id,
      url: "https://example.com/studio",
    });
    expect(submitted.state).toBe("VERIFYING");
    const running = await ok<{ status: string }>(buyer, "get_verification", { contract_id: id });
    expect(running.status).toBe("running");
    await runScheduled();

    const verdict = await ok<{
      status: string;
      checks: { outcome: string; reviewer_panel: { votes: { reviewer: string; vote: string }[] } | null; evidence_links?: string[] }[];
      receipt: { receipt_sha256: string } | null;
    }>(buyer, "get_verification", { contract_id: id });
    expect(verdict.status).toBe("passed");
    expect(verdict.checks.map((c) => c.outcome)).toEqual(["pass", "pass"]);
    expect(verdict.checks[0].reviewer_panel).toBeNull();
    expect(verdict.checks[1].reviewer_panel?.votes).toEqual([
      { reviewer: "literal", vote: "pass", criterion_met: true, confidence: 0.9, reasoning: "It lists classes." },
      { reviewer: "skeptic", vote: "pass", criterion_met: true, confidence: 0.85, reasoning: "Offer is stated." },
    ]);
    expect(verdict.checks[1].evidence_links).toEqual([
      `http://proviso.test/api/evidence/${submitted.submission_id}/desktop-1.jpg`,
    ]);
    expect(verdict.receipt).not.toBeNull();

    const contractView = await ok<{ verification: { checks: unknown[] }; latest_receipt: unknown; contract: { terms_sha256: string } }>(
      buyer,
      "get_contract",
      { contract_id: id },
    );
    expect(contractView.verification.checks).toHaveLength(2);
    expect(contractView.contract.terms_sha256).toMatch(/^[0-9a-f]{64}$/);

    const check = await ok<{ holds: boolean; checks: { check: string; ok: boolean | null }[]; receipt: { receipt_sha256: string } }>(
      seller,
      "check_receipt",
      { contract_id: id },
    );
    expect(check.holds).toBe(true);
    expect(check.receipt.receipt_sha256).toBe(verdict.receipt?.receipt_sha256);
    expect(check.checks.map((c) => c.check)).toEqual(
      expect.arrayContaining(["receipt hash", "signature", "terms hash", "verdict 1 (http_ok)"]),
    );
    expect((await refused(seller, "check_receipt", { contract_id: id, receipt_sha256: "0".repeat(64) })).error.code).toBe(
      "VALIDATION_ERROR",
    );

    const ledger = await ok<{ ledger: { kind: string; amount_cents: number }[]; contract_amount_cents: number }>(buyer, "get_ledger", {
      contract_id: id,
    });
    expect(ledger.ledger[0]).toMatchObject({ kind: "AUTHORIZED", amount_cents: 2500 });
    expect(ledger.contract_amount_cents).toBe(2500);
  });

  it("never funds: no tool does, and the refusal text says why", async () => {
    const payer = await agent("payer", { allowSign: true });
    const { tools } = await payer.listTools();
    expect(tools.map((t) => t.name).filter((n) => /fund/.test(n))).toEqual(["get_funding_instructions"]);
    expect(FUND_REFUSAL).toMatch(/get_funding_instructions/);
    expect(tools.find((t) => t.name === "get_funding_instructions")?.annotations?.readOnlyHint).toBe(true);
  });

  it("reports an inconclusive run and re-runs it", async () => {
    const payer = await agent("payer", { allowSign: true });
    const worker = await agent("worker", { allowSign: true });
    const { contract } = await ok<{ contract: { id: string } }>(payer, "create_contract", proposal());
    await ok(payer, "sign_contract", { contract_id: contract.id });
    await ok(worker, "sign_contract", { contract_id: contract.id });
    await fund(contract.id);
    verifierAnswers("inconclusive");
    await ok(worker, "submit_work", { contract_id: contract.id, url: "https://example.com" });
    await runScheduled();
    const first = await ok<{ status: string; next_step: string }>(payer, "get_verification", { contract_id: contract.id });
    expect(first.status).toBe("inconclusive");
    expect(first.next_step).toMatch(/rerun_verification/);
    verifierAnswers("passed");
    await ok(payer, "rerun_verification", { contract_id: contract.id });
    await runScheduled();
    expect((await ok<{ status: string }>(payer, "get_verification", { contract_id: contract.id })).status).toBe("passed");
  });
});
