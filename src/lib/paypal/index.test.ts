import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PayPal = typeof import("./index");

const BASE = "https://api-m.sandbox.paypal.com";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** Every request the module sent, token requests included, in order. */
let sent: Sent[];
/** Responses for non-token requests, in order. */
let queue: (() => Response)[];
/** Response to the next token request; a fresh token each time by default. */
let tokenReply: () => Response;
let tokenCount: number;
let pp: PayPal;
/** From the same module instance as `pp` (modules are reset per test). */
let MissingEnvError: typeof import("@/lib/env").MissingEnvError;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function reply(status: number, body?: unknown, headers?: Record<string, string>): void {
  queue.push(() => json(status, body, headers));
}

function apiCalls(): Sent[] {
  return sent.filter((s) => !s.url.endsWith("/v1/oauth2/token"));
}

function tokenCalls(): Sent[] {
  return sent.filter((s) => s.url.endsWith("/v1/oauth2/token"));
}

function lastCall(): Sent {
  const calls = apiCalls();
  return calls[calls.length - 1];
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(lastCall().body ?? "null");
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

beforeEach(async () => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID");
  sent = [];
  queue = [];
  tokenCount = 0;
  tokenReply = () => json(200, { access_token: `token-${++tokenCount}`, token_type: "Bearer", expires_in: 3600 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.endsWith("/v1/oauth2/token")) return tokenReply();
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request ${init?.method} ${url}`);
      return next();
    }),
  );
  // A fresh module per test, so the token cache starts empty.
  vi.resetModules();
  pp = await import("./index");
  ({ MissingEnvError } = await import("@/lib/env"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(queue, "every queued PayPal response was used").toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

describe("toPayPalValue", () => {
  it("formats minor units as PayPal's decimal string", () => {
    expect(pp.toPayPalValue(12345, "USD")).toBe("123.45");
    expect(pp.toPayPalValue(100, "USD")).toBe("1.00");
    expect(pp.toPayPalValue(5, "usd")).toBe("0.05");
    expect(pp.toPayPalValue(500, "JPY")).toBe("500");
  });

  it("rejects amounts that are not positive whole minor units", () => {
    expect(() => pp.toPayPalValue(0, "USD")).toThrow(RangeError);
    expect(() => pp.toPayPalValue(-100, "USD")).toThrow(RangeError);
    expect(() => pp.toPayPalValue(1.5, "USD")).toThrow(RangeError);
  });
});

describe("fromPayPalValue", () => {
  it("parses decimal strings to minor units without floating point", () => {
    expect(pp.fromPayPalValue("123.45", "USD")).toBe(12345);
    expect(pp.fromPayPalValue("1.0", "USD")).toBe(100);
    expect(pp.fromPayPalValue("0.29", "USD")).toBe(29);
    expect(pp.fromPayPalValue("70", "USD")).toBe(7000);
    expect(pp.fromPayPalValue("-3.00", "USD")).toBe(300);
    expect(pp.fromPayPalValue("500", "JPY")).toBe(500);
    expect(pp.fromPayPalValue("500.00", "JPY")).toBe(500);
  });

  it("rejects values it cannot represent exactly", () => {
    expect(() => pp.fromPayPalValue("1.005", "USD")).toThrow(/more decimals/);
    expect(() => pp.fromPayPalValue("500.5", "JPY")).toThrow(/more decimals/);
    expect(() => pp.fromPayPalValue("ten", "USD")).toThrow(/cannot parse/);
  });
});

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

describe("getAccessToken", () => {
  it("requests a client-credentials token with Basic auth from the sandbox", async () => {
    expect(await pp.getAccessToken()).toBe("token-1");
    const [call] = tokenCalls();
    expect(call.url).toBe(`${BASE}/v1/oauth2/token`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.body).toBe("grant_type=client_credentials");
  });

  it("caches the token, and concurrent callers share one request", async () => {
    const [a, b] = await Promise.all([pp.getAccessToken(), pp.getAccessToken()]);
    expect(await pp.getAccessToken()).toBe("token-1");
    expect([a, b]).toEqual(["token-1", "token-1"]);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("refreshes five minutes before PayPal's stated expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    expect(await pp.getAccessToken()).toBe("token-1");
    vi.setSystemTime(new Date("2026-11-11T00:54:59Z"));
    expect(await pp.getAccessToken()).toBe("token-1");
    vi.setSystemTime(new Date("2026-11-11T00:55:00Z"));
    expect(await pp.getAccessToken()).toBe("token-2");
    expect(tokenCalls()).toHaveLength(2);
  });

  it("refreshes a short-lived token at half its lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    tokenReply = () => json(200, { access_token: `token-${++tokenCount}`, expires_in: 240 });
    await pp.getAccessToken();
    vi.setSystemTime(new Date("2026-11-11T00:01:59Z"));
    expect(await pp.getAccessToken()).toBe("token-1");
    vi.setSystemTime(new Date("2026-11-11T00:02:00Z"));
    expect(await pp.getAccessToken()).toBe("token-2");
  });

  it("fetches a new token when the credentials change", async () => {
    await pp.getAccessToken();
    vi.stubEnv("PAYPAL_CLIENT_ID", "other-client");
    expect(await pp.getAccessToken()).toBe("token-2");
    expect(tokenCalls()[1].headers.get("authorization")).toBe(
      `Basic ${Buffer.from("other-client:client-secret").toString("base64")}`,
    );
  });

  it("throws PayPalError for rejected credentials and does not cache the failure", async () => {
    tokenReply = () => json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
    const err = await caught(pp.getAccessToken());
    expect(err).toBeInstanceOf(pp.PayPalError);
    expect(err).toMatchObject({
      operation: "POST /v1/oauth2/token",
      status: 401,
      paypalName: "invalid_client",
      paypalMessage: "Client Authentication failed",
    });
    tokenReply = () => json(200, { access_token: "good", expires_in: 3600 });
    expect(await pp.getAccessToken()).toBe("good");
  });

  it("throws a plain Error when the token response lacks the documented fields", async () => {
    tokenReply = () => json(200, { token_type: "Bearer" });
    const err = await caught(pp.getAccessToken());
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(pp.PayPalError);
    expect(String(err)).toMatch(/unexpected response/);
  });

  it("throws MissingEnvError naming the variables without calling PayPal", async () => {
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const err = await caught(pp.getAccessToken());
    expect(err).toBeInstanceOf(MissingEnvError);
    expect(String(err)).toMatch(/PAYPAL_CLIENT_SECRET/);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Request handling shared by every call
// ---------------------------------------------------------------------------

describe("requests", () => {
  const order = { id: "ORDER-1", status: "CREATED" };
  const input = { contractId: "c-1", amountCents: 1000, currency: "USD", description: "Logo" };

  it("retries once with a new token after a 401, keeping the PayPal-Request-Id", async () => {
    reply(401, { error: "invalid_token", error_description: "Token signature verification failed" });
    reply(201, order);
    expect((await pp.createAuthorizedOrder(input)).orderId).toBe("ORDER-1");
    const [first, second] = apiCalls();
    expect(first.headers.get("authorization")).toBe("Bearer token-1");
    expect(second.headers.get("authorization")).toBe("Bearer token-2");
    expect(second.headers.get("paypal-request-id")).toBe(first.headers.get("paypal-request-id"));
    expect(second.body).toBe(first.body);
  });

  it("gives up after the retry also answers 401", async () => {
    reply(401, { error: "invalid_token" });
    reply(401, { error: "invalid_token" });
    const err = await caught(pp.createAuthorizedOrder(input));
    expect(err).toMatchObject({ status: 401, paypalName: "invalid_token" });
    expect(apiCalls()).toHaveLength(2);
  });

  it("parses PayPal's error body into PayPalError", async () => {
    reply(422, {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      debug_id: "dbg-1",
      details: [{ issue: "CANNOT_BE_ZERO_OR_NEGATIVE", description: "Must be greater than zero.", field: "/amount" }],
    });
    const err = await caught(pp.createAuthorizedOrder(input));
    expect(err).toBeInstanceOf(pp.PayPalError);
    expect(err).toMatchObject({
      name: "PayPalError",
      operation: "POST /v2/checkout/orders",
      status: 422,
      paypalName: "UNPROCESSABLE_ENTITY",
      debugId: "dbg-1",
      issue: "CANNOT_BE_ZERO_OR_NEGATIVE",
    });
    expect(String(err)).toBe(
      "PayPalError: PayPal POST /v2/checkout/orders failed: HTTP 422 UNPROCESSABLE_ENTITY: The requested action " +
        "could not be performed. (CANNOT_BE_ZERO_OR_NEGATIVE: Must be greater than zero.) [debug_id dbg-1]",
    );
  });

  it("keeps a non-JSON error body as text and takes the debug id from the header", async () => {
    queue.push(() => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "paypal-debug-id": "hdr-1" } }));
    const err = await caught(pp.createAuthorizedOrder(input));
    expect(err).toMatchObject({
      status: 502,
      paypalName: "HTTP_502",
      paypalMessage: "<html>Bad Gateway</html>",
      debugId: "hdr-1",
      issue: null,
      body: "<html>Bad Gateway</html>",
    });
  });

  it("throws a plain Error for a 2xx body that is not JSON", async () => {
    queue.push(() => new Response("ok", { status: 200 }));
    const err = await caught(pp.createAuthorizedOrder(input));
    expect(err).not.toBeInstanceOf(pp.PayPalError);
    expect(String(err)).toMatch(/not JSON/);
  });

  it("lets a network failure propagate", async () => {
    queue.push(() => {
      throw new TypeError("fetch failed");
    });
    await expect(pp.createAuthorizedOrder(input)).rejects.toThrow("fetch failed");
  });

  it("gives every request, the token request included, a 30 s timeout", async () => {
    reply(201, { id: "ORDER-1", status: "CREATED" });
    await pp.createAuthorizedOrder(input);
    const inits = vi.mocked(fetch).mock.calls.map(([, init]) => init);
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(pp.REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("turns a timeout into a PayPalError, a failed step the caller retries with the same key", async () => {
    queue.push(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await caught(pp.createAuthorizedOrder(input));
    expect(err).toBeInstanceOf(pp.PayPalError);
    expect(err).toMatchObject({ operation: "POST /v2/checkout/orders", status: 0, paypalName: "TIMEOUT" });
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("createAuthorizedOrder", () => {
  const input = { contractId: "c-1", amountCents: 1000, currency: "USD", description: "Logo design" };

  it("creates an AUTHORIZE order tagged with the contract id", async () => {
    const raw = { id: "ORDER-1", status: "CREATED", links: [] };
    reply(201, raw);
    expect(await pp.createAuthorizedOrder(input)).toEqual({ orderId: "ORDER-1", status: "CREATED", raw });

    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v2/checkout/orders`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Bearer token-1");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("prefer")).toBe("return=representation");
    expect(call.headers.get("paypal-request-id")).toBe("clause:create-order:c-1:1000USD");
    expect(lastBody()).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "c-1",
          custom_id: "c-1",
          description: "Logo design",
          amount: { currency_code: "USD", value: "10.00" },
        },
      ],
    });
  });

  it("uses the same PayPal-Request-Id on a retry, and a new one when the amount differs", async () => {
    reply(201, { id: "ORDER-1", status: "CREATED" });
    reply(200, { id: "ORDER-1", status: "CREATED" });
    reply(201, { id: "ORDER-2", status: "CREATED" });
    await pp.createAuthorizedOrder(input);
    await pp.createAuthorizedOrder(input);
    await pp.createAuthorizedOrder({ ...input, amountCents: 1500 });
    expect(apiCalls().map((c) => c.headers.get("paypal-request-id"))).toEqual([
      "clause:create-order:c-1:1000USD",
      "clause:create-order:c-1:1000USD",
      "clause:create-order:c-1:1500USD",
    ]);
  });

  it("cuts a long description to 127 characters", async () => {
    reply(201, { id: "ORDER-1", status: "CREATED" });
    await pp.createAuthorizedOrder({ ...input, description: "x".repeat(300) });
    const unit = (lastBody().purchase_units as { description: string }[])[0];
    expect(unit.description).toBe("x".repeat(127));
  });

  it("rejects a non-positive amount before calling PayPal", async () => {
    await expect(pp.createAuthorizedOrder({ ...input, amountCents: 0 })).rejects.toThrow(RangeError);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("authorizeOrder", () => {
  function authorizedOrder(status: string) {
    return {
      id: "ORDER 1",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            authorizations: [
              {
                id: "AUTH-1",
                status,
                amount: { currency_code: "USD", value: "10.00" },
                expiration_time: "2026-12-10T00:00:00Z",
              },
            ],
          },
        },
      ],
    };
  }

  it("authorizes the approved order and returns the hold", async () => {
    const raw = authorizedOrder("CREATED");
    reply(201, raw);
    expect(await pp.authorizeOrder("ORDER 1")).toEqual({
      orderId: "ORDER 1",
      authorizationId: "AUTH-1",
      status: "CREATED",
      amountCents: 1000,
      currency: "USD",
      expiresAt: "2026-12-10T00:00:00Z",
      raw,
    });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v2/checkout/orders/ORDER%201/authorize`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("paypal-request-id")).toBe("clause:authorize:ORDER 1");
    expect(lastBody()).toEqual({});
  });

  it("returns a PENDING authorization as is", async () => {
    reply(201, authorizedOrder("PENDING"));
    expect((await pp.authorizeOrder("ORDER 1")).status).toBe("PENDING");
  });

  it("throws PayPalError for a DENIED authorization", async () => {
    reply(201, authorizedOrder("DENIED"));
    const err = await caught(pp.authorizeOrder("ORDER 1"));
    expect(err).toBeInstanceOf(pp.PayPalError);
    expect(err).toMatchObject({ status: 201, paypalName: "AUTHORIZATION_DENIED" });
  });

  it("throws PayPalError when the payer has not approved the order", async () => {
    reply(422, {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      details: [{ issue: "ORDER_NOT_APPROVED" }],
    });
    expect(await caught(pp.authorizeOrder("ORDER 1"))).toMatchObject({ status: 422, issue: "ORDER_NOT_APPROVED" });
  });

  it("throws a plain Error when the response has no authorization", async () => {
    reply(201, { id: "ORDER 1", purchase_units: [{ payments: { authorizations: [] } }] });
    const err = await caught(pp.authorizeOrder("ORDER 1"));
    expect(err).not.toBeInstanceOf(pp.PayPalError);
    expect(String(err)).toMatch(/unexpected response/);
  });
});

// ---------------------------------------------------------------------------
// Payments: capture, void, refund
// ---------------------------------------------------------------------------

describe("captureAuthorization", () => {
  const capture = (status: string, value = "10.00") => ({
    id: "CAP-1",
    status,
    amount: { currency_code: "USD", value },
  });

  it("captures the full amount as a final capture", async () => {
    const raw = capture("COMPLETED");
    reply(201, raw);
    expect(await pp.captureAuthorization({ authorizationId: "AUTH-1", currency: "USD" })).toEqual({
      captureId: "CAP-1",
      status: "COMPLETED",
      amountCents: 1000,
      currency: "USD",
      raw,
    });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v2/payments/authorizations/AUTH-1/capture`);
    expect(call.headers.get("paypal-request-id")).toBe("clause:capture:AUTH-1:full");
    expect(lastBody()).toEqual({ final_capture: true });
  });

  it("captures part of the authorization", async () => {
    reply(201, capture("COMPLETED", "7.00"));
    const result = await pp.captureAuthorization({ authorizationId: "AUTH-1", amountCents: 700, currency: "USD" });
    expect(result.amountCents).toBe(700);
    expect(lastCall().headers.get("paypal-request-id")).toBe("clause:capture:AUTH-1:700");
    expect(lastBody()).toEqual({ amount: { currency_code: "USD", value: "7.00" }, final_capture: true });
  });

  it("sends the same PayPal-Request-Id on a retry, so PayPal cannot capture twice", async () => {
    reply(201, capture("COMPLETED"));
    reply(200, capture("COMPLETED"));
    const input = { authorizationId: "AUTH-1", amountCents: 1000, currency: "USD" };
    const first = await pp.captureAuthorization(input);
    const again = await pp.captureAuthorization(input);
    expect(again.captureId).toBe(first.captureId);
    const [a, b] = apiCalls();
    expect(b.headers.get("paypal-request-id")).toBe(a.headers.get("paypal-request-id"));
  });

  it("returns a PENDING capture as is", async () => {
    reply(201, capture("PENDING"));
    expect((await pp.captureAuthorization({ authorizationId: "AUTH-1", currency: "USD" })).status).toBe("PENDING");
  });

  it.each(["DECLINED", "FAILED"])("throws PayPalError for a %s capture", async (status) => {
    reply(201, capture(status));
    expect(await caught(pp.captureAuthorization({ authorizationId: "AUTH-1", currency: "USD" }))).toMatchObject({
      name: "PayPalError",
      paypalName: `CAPTURE_${status}`,
    });
  });

  it("throws PayPalError when the authorization is already captured", async () => {
    reply(422, { name: "UNPROCESSABLE_ENTITY", message: "x", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] });
    expect(await caught(pp.captureAuthorization({ authorizationId: "AUTH-1", currency: "USD" }))).toMatchObject({
      issue: "AUTHORIZATION_ALREADY_CAPTURED",
    });
  });
});

describe("voidAuthorization", () => {
  it("voids with no body and accepts PayPal's 204", async () => {
    queue.push(() => new Response(null, { status: 204 }));
    expect(await pp.voidAuthorization("AUTH-1")).toEqual({ authorizationId: "AUTH-1", status: "VOIDED", raw: null });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v2/payments/authorizations/AUTH-1/void`);
    expect(call.method).toBe("POST");
    expect(call.body).toBeNull();
    expect(call.headers.get("content-type")).toBeNull();
    expect(call.headers.get("paypal-request-id")).toBe("clause:void:AUTH-1");
  });

  it("reads the authorization when PayPal returns it", async () => {
    const raw = { id: "AUTH-1", status: "VOIDED", amount: { currency_code: "USD", value: "10.00" } };
    reply(200, raw);
    expect(await pp.voidAuthorization("AUTH-1")).toEqual({ authorizationId: "AUTH-1", status: "VOIDED", raw });
  });

  it("throws PayPalError when the authorization was already captured", async () => {
    reply(422, { name: "UNPROCESSABLE_ENTITY", message: "x", details: [{ issue: "PREVIOUSLY_CAPTURED" }] });
    expect(await caught(pp.voidAuthorization("AUTH-1"))).toMatchObject({ status: 422, issue: "PREVIOUSLY_CAPTURED" });
  });
});

describe("refundCapture", () => {
  const input = { captureId: "CAP-1", amountCents: 300, currency: "USD", note: "Mediated split" };
  const refund = (status: string) => ({ id: "REF-1", status, amount: { currency_code: "USD", value: "3.00" } });

  it("refunds part of a capture to the payer", async () => {
    const raw = refund("COMPLETED");
    reply(201, raw);
    expect(await pp.refundCapture(input)).toEqual({ refundId: "REF-1", status: "COMPLETED", amountCents: 300, raw });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v2/payments/captures/CAP-1/refund`);
    expect(call.headers.get("paypal-request-id")).toBe("clause:refund:CAP-1:300");
    expect(lastBody()).toEqual({ amount: { currency_code: "USD", value: "3.00" }, note_to_payer: "Mediated split" });
  });

  it("sends the same PayPal-Request-Id on a retry, so PayPal cannot refund twice", async () => {
    reply(201, refund("COMPLETED"));
    reply(200, refund("COMPLETED"));
    await pp.refundCapture(input);
    await pp.refundCapture(input);
    const [a, b] = apiCalls();
    expect(b.headers.get("paypal-request-id")).toBe(a.headers.get("paypal-request-id"));
  });

  it("adds a reason to the key, so a second refund of the same amount is not a replay of the first", async () => {
    reply(201, refund("COMPLETED"));
    reply(201, refund("COMPLETED"));
    await pp.refundCapture(input);
    await pp.refundCapture({ ...input, reason: "payout_returned" });
    expect(apiCalls().map((c) => c.headers.get("paypal-request-id"))).toEqual([
      "clause:refund:CAP-1:300",
      "clause:refund:CAP-1:300:payout_returned",
    ]);
  });

  it("cuts a long note to PayPal's 255 characters", async () => {
    reply(201, refund("COMPLETED"));
    await pp.refundCapture({ ...input, note: "é".repeat(400) });
    expect(lastBody().note_to_payer).toBe("é".repeat(255));
  });

  it.each(["FAILED", "CANCELLED"])("throws PayPalError for a %s refund", async (status) => {
    reply(201, refund(status));
    expect(await caught(pp.refundCapture(input))).toMatchObject({ paypalName: `REFUND_${status}` });
  });

  it("throws PayPalError when the refund exceeds what is left", async () => {
    reply(422, { name: "UNPROCESSABLE_ENTITY", message: "x", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] });
    expect(await caught(pp.refundCapture(input))).toMatchObject({ issue: "REFUND_AMOUNT_EXCEEDED" });
  });
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

describe("payout", () => {
  const input = {
    contractId: "c-1",
    receiverEmail: "worker@example.com",
    amountCents: 2500,
    currency: "USD",
    note: "Clause: Logo",
  };
  const created = (status: string) => ({ batch_header: { payout_batch_id: "BATCH-1", batch_status: status } });

  it("sends one email payout keyed to the contract", async () => {
    const raw = created("PENDING");
    reply(201, raw);
    expect(await pp.payout(input)).toEqual({ payoutBatchId: "BATCH-1", batchStatus: "PENDING", raw });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v1/payments/payouts`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("paypal-request-id")).toBe("clause:payout:c-1");
    expect(lastBody()).toEqual({
      sender_batch_header: { sender_batch_id: "clause:payout:c-1", email_subject: "You have a payout from Proviso" },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: "25.00", currency: "USD" },
          receiver: "worker@example.com",
          note: "Clause: Logo",
          sender_item_id: "c-1",
        },
      ],
    });
  });

  it("keys every retry for a contract the same, whatever the amount, so the worker is paid at most once", async () => {
    reply(201, created("PENDING"));
    reply(200, created("PENDING"));
    await pp.payout(input);
    await pp.payout({ ...input, amountCents: 1000 });
    const bodies = apiCalls().map((c) => JSON.parse(c.body ?? "{}"));
    expect(apiCalls().map((c) => c.headers.get("paypal-request-id"))).toEqual(["clause:payout:c-1", "clause:payout:c-1"]);
    expect(bodies.map((b) => b.sender_batch_header.sender_batch_id)).toEqual(["clause:payout:c-1", "clause:payout:c-1"]);
  });

  it("sends a later attempt under its own key and sender_batch_id; attempt 1 keeps the original key", async () => {
    reply(201, created("PENDING"));
    reply(201, created("PENDING"));
    reply(201, created("PENDING"));
    await pp.payout({ ...input, attempt: 1 });
    await pp.payout({ ...input, attempt: 2 });
    await pp.payout({ ...input, attempt: 3 });
    const keys = ["clause:payout:c-1", "clause:payout:c-1:2", "clause:payout:c-1:3"];
    expect(apiCalls().map((c) => c.headers.get("paypal-request-id"))).toEqual(keys);
    expect(apiCalls().map((c) => JSON.parse(c.body ?? "{}").sender_batch_header.sender_batch_id)).toEqual(keys);
    expect(apiCalls().map((c) => JSON.parse(c.body ?? "{}").items[0].sender_item_id)).toEqual(["c-1", "c-1", "c-1"]);
  });

  it.each([0, -1, 1.5])("rejects attempt %s before calling PayPal", async (attempt) => {
    await expect(pp.payout({ ...input, attempt })).rejects.toThrow(RangeError);
    expect(apiCalls()).toHaveLength(0);
  });

  it("throws PayPalError for a DENIED batch", async () => {
    reply(201, created("DENIED"));
    expect(await caught(pp.payout(input))).toMatchObject({ name: "PayPalError", paypalName: "PAYOUT_BATCH_DENIED" });
  });

  it("throws PayPalError when the account cannot send payouts", async () => {
    reply(403, { name: "PAYOUT_NOT_AVAILABLE", message: "You live in a country that is not allowed to send this payout.", debug_id: "d" });
    expect(await caught(pp.payout(input))).toMatchObject({
      operation: "POST /v1/payments/payouts",
      status: 403,
      paypalName: "PAYOUT_NOT_AVAILABLE",
    });
  });

  it("cuts a long note to PayPal's 4000 characters", async () => {
    reply(201, created("PENDING"));
    await pp.payout({ ...input, note: "n".repeat(5000) });
    expect((lastBody().items as { note: string }[])[0].note).toHaveLength(4000);
  });

  /** PayPal's answer to a repeated sender_batch_id, as the sandbox sent it on 2026-11-11. */
  const duplicate = (link: string | null, issue = "Batch with given sender_batch_id already exists") => ({
    name: "USER_BUSINESS_ERROR",
    message: "User business error.",
    debug_id: "dup-debug",
    information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
    details: [
      {
        field: "SENDER_BATCH_ID",
        location: "body",
        issue,
        ...(link ? { link: [{ href: link, rel: "self", method: "GET", encType: "application/json" }] } : {}),
      },
    ],
    links: [],
  });
  const linkTo = (batchId: string) => `https://api.sandbox.paypal.com/v1/payments/payouts/${batchId}`;

  /** BATCH-1 as GET returns it, paying what `input` sends unless overridden. */
  const existingBatch = (
    over: { status?: string; value?: string; currency?: string; receiver?: string; senderBatchId?: string } = {},
  ) => ({
    batch_header: {
      payout_batch_id: "BATCH-1",
      batch_status: over.status ?? "PENDING",
      sender_batch_header: { sender_batch_id: over.senderBatchId ?? "clause:payout:c-1", email_subject: "x" },
    },
    items: [
      {
        payout_item_id: "ITEM-1",
        payout_batch_id: "BATCH-1",
        transaction_status: "PENDING",
        payout_item: {
          recipient_type: "EMAIL",
          amount: { currency: over.currency ?? "USD", value: over.value ?? "25.00" },
          receiver: over.receiver ?? "Worker@Example.com",
          sender_item_id: "c-1",
        },
      },
    ],
  });

  it("recovers the batch of an earlier send PayPal refuses to repeat, once it reads back as this payout", async () => {
    reply(400, duplicate(linkTo("BATCH-1")), { "paypal-debug-id": "dup-debug" });
    const raw = existingBatch();
    reply(200, raw);
    expect(await pp.payout(input)).toEqual({ payoutBatchId: "BATCH-1", batchStatus: "PENDING", raw, recovered: true });
    // Read back through our own API base, not the link's host; nothing is sent again.
    expect(apiCalls().map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/v1/payments/payouts`,
      `GET ${BASE}/v1/payments/payouts/BATCH-1`,
    ]);
  });

  it.each([
    ["amount", { value: "10.00" }],
    ["currency", { currency: "EUR" }],
    ["receiver", { receiver: "someone-else@example.com" }],
    ["sender_batch_id", { senderBatchId: "clause:payout:c-2" }],
  ])("does not trust a linked batch whose %s differs from this payout", async (_, over) => {
    reply(400, duplicate(linkTo("BATCH-1")));
    reply(200, existingBatch(over));
    const err = await caught(pp.payout(input));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(pp.PayPalError);
    expect((err as Error).message).toMatch(/duplicate of batch BATCH-1, which does not match it .* not treated as sent/);
    expect((err as Error).cause).toMatchObject({ name: "PayPalError", status: 400, paypalName: "USER_BUSINESS_ERROR" });
  });

  it.each([
    ["the refusal links to no batch", duplicate(null)],
    ["the link is for another issue", duplicate(linkTo("BATCH-1"), "Sender batch ID is too long")],
  ])("surfaces a 400 unchanged, reading nothing back, when %s", async (_, body) => {
    reply(400, body);
    expect(await caught(pp.payout(input))).toMatchObject({
      name: "PayPalError",
      status: 400,
      paypalName: "USER_BUSINESS_ERROR",
      issue: body.details[0].issue,
      body,
    });
    expect(apiCalls()).toHaveLength(1);
  });

  it("throws PAYOUT_BATCH_DENIED for a recovered DENIED batch, with its id in the body as for a created one", async () => {
    reply(400, duplicate(linkTo("BATCH-1")));
    reply(200, existingBatch({ status: "DENIED" }));
    expect(await caught(pp.payout(input))).toMatchObject({
      name: "PayPalError",
      paypalName: "PAYOUT_BATCH_DENIED",
      body: { batch_header: { payout_batch_id: "BATCH-1" } },
    });
  });
});

describe("getPayoutBatch", () => {
  it("reads the batch and each item's status without an idempotency key", async () => {
    const item = {
      payout_item_id: "ITEM-1",
      transaction_status: "UNCLAIMED",
      payout_batch_id: "BATCH-1",
      payout_item: {
        recipient_type: "EMAIL",
        amount: { currency: "USD", value: "25.00" },
        receiver: "worker@example.com",
        sender_item_id: "c-1",
      },
      errors: { name: "RECEIVER_UNREGISTERED" },
    };
    const raw = { batch_header: { payout_batch_id: "BATCH-1", batch_status: "SUCCESS" }, items: [item] };
    reply(200, raw);
    expect(await pp.getPayoutBatch("BATCH-1")).toEqual({
      payoutBatchId: "BATCH-1",
      batchStatus: "SUCCESS",
      items: [
        {
          payoutItemId: "ITEM-1",
          payoutBatchId: "BATCH-1",
          transactionStatus: "UNCLAIMED",
          amountCents: 2500,
          currency: "USD",
          receiver: "worker@example.com",
          senderItemId: "c-1",
          errors: { name: "RECEIVER_UNREGISTERED" },
          raw: item,
        },
      ],
      raw,
    });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v1/payments/payouts/BATCH-1`);
    expect(call.method).toBe("GET");
    expect(call.body).toBeNull();
    expect(call.headers.get("paypal-request-id")).toBeNull();
  });

  it("returns a batch with no items yet, and items without a status as null", async () => {
    reply(200, { batch_header: { payout_batch_id: "BATCH-1", batch_status: "PENDING" } });
    expect((await pp.getPayoutBatch("BATCH-1")).items).toEqual([]);
    reply(200, {
      batch_header: { payout_batch_id: "BATCH-1", batch_status: "PROCESSING" },
      items: [{ payout_item_id: "ITEM-1", payout_item: { amount: { currency: "USD", value: "1.00" } } }],
    });
    expect((await pp.getPayoutBatch("BATCH-1")).items[0]).toMatchObject({
      transactionStatus: null,
      receiver: null,
      senderItemId: null,
      errors: null,
    });
  });
});

describe("getPayoutItem", () => {
  it("reads one payout item", async () => {
    const raw = {
      payout_item_id: "ITEM-1",
      payout_batch_id: "BATCH-1",
      transaction_status: "SUCCESS",
      payout_item: { amount: { currency: "USD", value: "25.00" }, receiver: "worker@example.com", sender_item_id: "c-1" },
    };
    reply(200, raw);
    expect(await pp.getPayoutItem("ITEM-1")).toMatchObject({
      payoutItemId: "ITEM-1",
      payoutBatchId: "BATCH-1",
      transactionStatus: "SUCCESS",
      amountCents: 2500,
      raw,
    });
    expect(lastCall().url).toBe(`${BASE}/v1/payments/payouts-item/ITEM-1`);
  });
});

describe("payoutOutcome", () => {
  const batch = (batchStatus: string, ...statuses: (string | null)[]) => ({
    payoutBatchId: "BATCH-1",
    batchStatus,
    raw: {},
    items: statuses.map((transactionStatus, i) => ({
      payoutItemId: `ITEM-${i}`,
      payoutBatchId: "BATCH-1",
      transactionStatus,
      amountCents: 100,
      currency: "USD",
      receiver: null,
      senderItemId: null,
      errors: null,
      raw: {},
    })),
  });

  it("is PAID only when every item is SUCCESS", () => {
    expect(pp.payoutOutcome(batch("SUCCESS", "SUCCESS"))).toBe("PAID");
    expect(pp.payoutOutcome(batch("SUCCESS", "SUCCESS", "PENDING"))).toBe("PENDING");
  });

  it("is PENDING while PayPal is still working, including an accepted batch with no items yet", () => {
    expect(pp.payoutOutcome(batch("PENDING"))).toBe("PENDING");
    expect(pp.payoutOutcome(batch("PROCESSING", null))).toBe("PENDING");
    expect(pp.payoutOutcome(batch("SUCCESS", "ONHOLD"))).toBe("PENDING");
    expect(pp.payoutOutcome(batch("SUCCESS"))).toBe("PENDING");
  });

  it.each(["UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"])(
    "is NOT_PAID for a %s item",
    (status) => {
      expect(pp.payoutOutcome(batch("SUCCESS", status))).toBe("NOT_PAID");
    },
  );

  it("is NOT_PAID for a DENIED or CANCELED batch", () => {
    expect(pp.payoutOutcome(batch("DENIED"))).toBe("NOT_PAID");
    expect(pp.payoutOutcome(batch("CANCELED", "PENDING"))).toBe("NOT_PAID");
  });
});

describe("payoutReturned", () => {
  const batch = (batchStatus: string, transactionStatus?: string) => ({
    payoutBatchId: "BATCH-1",
    batchStatus,
    raw: {},
    items:
      transactionStatus === undefined
        ? []
        : [
            {
              payoutItemId: "ITEM-1",
              payoutBatchId: "BATCH-1",
              transactionStatus,
              amountCents: 100,
              currency: "USD",
              receiver: null,
              senderItemId: null,
              errors: null,
              raw: {},
            },
          ],
  });

  it.each(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "CANCELED"])(
    "is true for a %s item: PayPal gave the money back",
    (status) => {
      expect(pp.payoutReturned(batch("SUCCESS", status))).toBe(true);
    },
  );

  it("is true for a DENIED or CANCELED batch", () => {
    expect(pp.payoutReturned(batch("DENIED"))).toBe(true);
    expect(pp.payoutReturned(batch("CANCELED", "PENDING"))).toBe(true);
  });

  it.each(["UNCLAIMED", "PENDING", "ONHOLD", "SUCCESS"])("is false for a %s item: the money may still land", (status) => {
    expect(pp.payoutReturned(batch("SUCCESS", status))).toBe(false);
  });

  it("is false for a batch PayPal is still working on", () => {
    expect(pp.payoutReturned(batch("PENDING"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  // Odd spacing and key order on purpose: PayPal must get these exact bytes.
  const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1","amount":{"value":"10.00"}}}';
  const paypalHeaders = () =>
    new Headers({
      "PAYPAL-AUTH-ALGO": "SHA256withRSA",
      "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "PAYPAL-TRANSMISSION-ID": "TX-1",
      "PAYPAL-TRANSMISSION-SIG": "SIG==",
      "PAYPAL-TRANSMISSION-TIME": "2026-11-11T00:00:00Z",
    });

  it("asks PayPal to verify, passing the event body byte for byte", async () => {
    reply(200, { verification_status: "SUCCESS" });
    expect(await pp.verifyWebhookSignature({ headers: paypalHeaders(), rawBody })).toBe(true);
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v1/notifications/verify-webhook-signature`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("paypal-request-id")).toBeNull();
    expect(call.body).toBe(
      '{"auth_algo":"SHA256withRSA","cert_url":"https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",' +
        '"transmission_id":"TX-1","transmission_sig":"SIG==","transmission_time":"2026-11-11T00:00:00Z",' +
        `"webhook_id":"WH-ID","webhook_event":${rawBody}}`,
    );
    expect(JSON.parse(call.body ?? "")).toMatchObject({ webhook_event: JSON.parse(rawBody) });
  });

  it("is false when PayPal reports FAILURE", async () => {
    reply(200, { verification_status: "FAILURE" });
    expect(await pp.verifyWebhookSignature({ headers: paypalHeaders(), rawBody })).toBe(false);
  });

  it("is false without calling PayPal when a signature header is missing or the body is not JSON", async () => {
    const headers = paypalHeaders();
    headers.delete("paypal-transmission-sig");
    expect(await pp.verifyWebhookSignature({ headers, rawBody })).toBe(false);
    expect(await pp.verifyWebhookSignature({ headers: paypalHeaders(), rawBody: "not json" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("throws when PayPal rejects the verification request, so 'could not check' differs from 'forged'", async () => {
    reply(400, { name: "VALIDATION_ERROR", message: "Invalid request", details: [{ issue: "INVALID_WEBHOOK_ID" }] });
    const err = await caught(pp.verifyWebhookSignature({ headers: paypalHeaders(), rawBody }));
    expect(err).toBeInstanceOf(pp.PayPalError);
    expect(err).toMatchObject({ status: 400, issue: "INVALID_WEBHOOK_ID" });
  });

  it("throws MissingEnvError when PAYPAL_WEBHOOK_ID is not set", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const err = await caught(pp.verifyWebhookSignature({ headers: paypalHeaders(), rawBody }));
    expect(err).toBeInstanceOf(MissingEnvError);
    expect(String(err)).toMatch(/PAYPAL_WEBHOOK_ID/);
    expect(sent).toHaveLength(0);
  });
});
