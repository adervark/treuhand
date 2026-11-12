import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractIn, withTempDb } from "@/test/helpers";
import { getContract } from "@/lib/db/contracts";
import { listEvents } from "@/lib/db/events";
import { POST } from "./route";

withTempDb();

const SIGNATURE_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "TX-1",
  "paypal-transmission-sig": "SIG==",
  "paypal-transmission-time": "2026-11-11T00:00:00Z",
};

/** What PayPal's verify-webhook-signature endpoint answers in the current test. */
let verifyReply: () => Response;
let verifyBodies: string[];

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID");
  verifyBodies = [];
  verifyReply = () => Response.json({ verification_status: "SUCCESS" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
        verifyBodies.push(String(init?.body));
        return verifyReply();
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function deliver(body: string, headers: Record<string, string> = SIGNATURE_HEADERS): Promise<Response> {
  return POST(
    new Request("http://localhost/api/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

function voidedEvent(contractId: string, id = "WH-1"): string {
  // Spacing as PayPal might send it; the route must pass these bytes on unchanged.
  return `{"id":"${id}", "event_type":"PAYMENT.AUTHORIZATION.VOIDED","resource":{"id":"AUTH-1","status":"VOIDED",` +
    `"amount":{"currency_code":"USD","value":"200.00"},"custom_id":"${contractId}"}}`;
}

describe("POST /api/webhooks/paypal", () => {
  it("verifies the raw body with PayPal, then reconciles the event", async () => {
    const contract = contractIn("FUNDED");
    const body = voidedEvent(contract.id);

    const res = await deliver(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "processed",
      contractId: contract.id,
      actions: ["ledger VOIDED AUTH-1 recorded", "state FUNDED -> EXPIRED"],
    });
    expect(verifyBodies).toHaveLength(1);
    expect(verifyBodies[0].endsWith(`"webhook_id":"WH-ID","webhook_event":${body}}`)).toBe(true);
    expect(getContract(contract.id)?.state).toBe("EXPIRED");
  });

  it("answers 200 to a redelivery without changing anything", async () => {
    const contract = contractIn("FUNDED");
    await deliver(voidedEvent(contract.id));
    const eventsBefore = listEvents(contract.id).length;

    const res = await deliver(voidedEvent(contract.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "duplicate", contractId: contract.id });
    expect(listEvents(contract.id)).toHaveLength(eventsBefore);
  });

  it("answers 200 to an event for no known contract, so PayPal stops retrying", async () => {
    const res = await deliver(voidedEvent("unknown-contract"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "no contract for authorization AUTH-1" });
  });

  it("rejects a delivery PayPal does not confirm, without touching the contract", async () => {
    const contract = contractIn("FUNDED");
    verifyReply = () => Response.json({ verification_status: "FAILURE" });

    const res = await deliver(voidedEvent(contract.id));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_SIGNATURE", message: "PayPal did not confirm this webhook's signature." },
    });
    expect(getContract(contract.id)?.state).toBe("FUNDED");
  });

  it("rejects a request without PayPal's signature headers without asking PayPal", async () => {
    const res = await deliver(voidedEvent("x"), {});
    expect(res.status).toBe(401);
    expect(verifyBodies).toHaveLength(0);
  });

  it("answers 503 NOT_CONFIGURED while PAYPAL_WEBHOOK_ID is not set", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const res = await deliver(voidedEvent("x"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(body.error.message).toMatch(/PAYPAL_WEBHOOK_ID/);
  });

  it("answers 502 when PayPal cannot verify, so PayPal redelivers later", async () => {
    verifyReply = () => Response.json({ name: "INTERNAL_SERVICE_ERROR", message: "An internal service error occurred." }, { status: 500 });
    const res = await deliver(voidedEvent("x"));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PAYPAL_ERROR");
  });

  it("answers 400 to a verified event whose resource is not the expected shape", async () => {
    const res = await deliver('{"id":"WH-9","event_type":"PAYMENT.AUTHORIZATION.VOIDED","resource":{"id":"AUTH-1"}}');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
