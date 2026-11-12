/**
 * Agent bearer tokens on the HTTP API: the real route handlers and the real
 * viewer (src/lib/viewer.ts), with only the request's headers and cookies
 * (next/headers) and PayPal faked. A token replaces the view-as cookie with
 * its party, the role rules stay the service's, and scopes narrow them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paypal from "@/lib/paypal";
import { createAgentToken, FUND_REFUSAL } from "@/lib/agent/tokens";
import { revokeAgentToken } from "@/lib/db/agent-tokens";
import { getContract } from "@/lib/db/contracts";
import { installPayPalFakes, newContract, seedIdentities, daysFromNow } from "@/lib/contract/service-testkit";
import { withTempDb } from "@/test/helpers";
import type { Party } from "@/lib/types";
import { VIEW_AS_COOKIE } from "@/lib/viewer";
import * as contractsRoute from "./contracts/route";
import * as contractRoute from "./contracts/[id]/route";
import * as signRoute from "./contracts/[id]/sign/route";
import * as createOrderRoute from "./contracts/[id]/fund/create-order/route";
import * as authorizeRoute from "./contracts/[id]/fund/authorize/route";
import * as submitRoute from "./contracts/[id]/submit/route";

const request = vi.hoisted(() => ({ headers: new Headers(), cookies: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined),
  }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
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

withTempDb();

beforeEach(() => {
  vi.resetAllMocks();
  seedIdentities();
  installPayPalFakes();
  request.headers = new Headers();
  request.cookies = new Map();
});

afterEach(() => {
  request.headers = new Headers();
  request.cookies = new Map();
});

function useToken(token: string): void {
  request.headers = new Headers({ authorization: `Bearer ${token}` });
}

function token(role: Party, options: { allowSign?: boolean; readOnly?: boolean } = {}): string {
  return createAgentToken({ role, ...options }).token;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://proviso.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function read(res: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await res;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function expectError(res: Promise<Response>, status: number, code: string): Promise<string> {
  const { status: got, body } = await read(res);
  const error = body.error as { code: string; message: string };
  expect({ status: got, code: error.code }).toEqual({ status, code });
  return error.message;
}

const proposal = () => ({
  title: "Landing page",
  type: "website_milestone",
  amount_cents: 2500,
  currency: "USD",
  deadline_at: daysFromNow(3),
  conditions: [{ text: "Loads", check_kind: "http_ok", check_params: {} }],
});

describe("a token acts as its party", () => {
  it("replaces the view-as cookie with the token's party", async () => {
    const contract = newContract();
    request.cookies.set(VIEW_AS_COOKIE, "payer");
    useToken(token("worker", { readOnly: true }));
    const { status, body } = await read(contractRoute.GET(new Request("http://proviso.test"), params(contract.id)));
    expect(status).toBe(200);
    expect(body.viewer).toEqual({ role: "worker" });
  });

  it("refuses the wrong role with the service's own FORBIDDEN", async () => {
    useToken(token("worker"));
    const message = await expectError(contractsRoute.POST(post(proposal())), 403, "FORBIDDEN");
    expect(message).toMatch(/payer/i);

    const contract = newContract();
    useToken(token("payer"));
    expect(await expectError(submitRoute.POST(post({ url: "https://example.com" }), params(contract.id)), 403, "FORBIDDEN")).toMatch(
      /worker/i,
    );
  });

  it("lets a payer token with write create a contract", async () => {
    useToken(token("payer"));
    const { status, body } = await read(contractsRoute.POST(post(proposal())));
    expect(status).toBe(201);
    expect((body.contract as { state: string }).state).toBe("DRAFT");
  });
});

describe("signing is a separate scope", () => {
  it("refuses to sign without it, and signs with it", async () => {
    const contract = newContract();
    useToken(token("payer"));
    expect(await expectError(signRoute.POST(post(), params(contract.id)), 403, "FORBIDDEN")).toMatch(/--allow-sign/);
    expect(getContract(contract.id)?.payer_signed_at).toBeNull();

    useToken(token("payer", { allowSign: true }));
    const { status } = await read(signRoute.POST(post(), params(contract.id)));
    expect(status).toBe(200);
    expect(getContract(contract.id)?.payer_signed_at).not.toBeNull();
  });

  it("refuses a read-only token", async () => {
    const contract = newContract();
    useToken(token("worker", { readOnly: true }));
    await expectError(signRoute.POST(post(), params(contract.id)), 403, "FORBIDDEN");
  });
});

describe("funding is never available to a token", () => {
  it("refuses create-order and authorize even to a sign-enabled payer token, without calling PayPal", async () => {
    const contract = newContract();
    useToken(token("payer", { allowSign: true }));
    await read(signRoute.POST(post(), params(contract.id)));
    useToken(token("worker", { allowSign: true }));
    await read(signRoute.POST(post(), params(contract.id)));
    expect(getContract(contract.id)?.state).toBe("SIGNED");

    useToken(token("payer", { allowSign: true }));
    expect(await expectError(createOrderRoute.POST(post(), params(contract.id)), 403, "FORBIDDEN")).toBe(FUND_REFUSAL);
    expect(await expectError(authorizeRoute.POST(post({ orderId: "ORDER-1" }), params(contract.id)), 403, "FORBIDDEN")).toBe(
      FUND_REFUSAL,
    );
    expect(paypal.createAuthorizedOrder).not.toHaveBeenCalled();
    expect(paypal.authorizeOrder).not.toHaveBeenCalled();
    expect(getContract(contract.id)?.state).toBe("SIGNED");
  });
});

describe("bad tokens", () => {
  it("refuses a revoked token with 401", async () => {
    const contract = newContract();
    const { token: secret, row } = createAgentToken({ role: "payer", allowSign: true });
    revokeAgentToken(row.id);
    useToken(secret);
    await expectError(signRoute.POST(post(), params(contract.id)), 401, "UNAUTHORIZED");
    await expectError(contractRoute.GET(new Request("http://proviso.test"), params(contract.id)), 401, "UNAUTHORIZED");
  });

  it("refuses an unknown or malformed token with 401 instead of falling back to the cookie", async () => {
    const contract = newContract();
    request.cookies.set(VIEW_AS_COOKIE, "payer");
    useToken("proviso_not-a-real-token");
    await expectError(signRoute.POST(post(), params(contract.id)), 401, "UNAUTHORIZED");
    request.headers = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    await expectError(contractRoute.GET(new Request("http://proviso.test"), params(contract.id)), 401, "UNAUTHORIZED");
  });
});

describe("the web app's cookie path is unchanged", () => {
  it("acts as the cookie's party with no Authorization header, signing included", async () => {
    const contract = newContract();
    request.cookies.set(VIEW_AS_COOKIE, "worker");
    const { body } = await read(contractRoute.GET(new Request("http://proviso.test"), params(contract.id)));
    expect(body.viewer).toEqual({ role: "worker" });
    expect((await read(signRoute.POST(post(), params(contract.id)))).status).toBe(200);
    expect(getContract(contract.id)?.worker_signed_at).not.toBeNull();
  });
});
