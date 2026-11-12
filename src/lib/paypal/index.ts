/**
 * PayPal money module. Direct REST calls with fetch to the
 * sandbox (`requirePayPal()` in src/lib/env.ts gives credentials and base URL).
 * Endpoints, bodies and their sources are in docs/paypal-notes.md.
 *
 * Amounts are integer minor units ("cents") throughout; `raw` is the PayPal
 * response body, stored in `ledger.raw`.
 *
 * Every function either returns a result whose money movement happened, or
 * throws: PayPalError for an HTTP error from PayPal or a refused outcome
 * (authorization DENIED, capture DECLINED/FAILED, refund FAILED/CANCELLED,
 * payout batch DENIED), MissingEnvError when credentials are not set, or a
 * plain Error when PayPal's response does not have the documented shape (or,
 * for `payout`, a duplicate refusal links to a batch that is not this payout).
 *
 * Every money-moving call sends a deterministic `PayPal-Request-Id`, so a
 * retry of the same action cannot move money twice: Orders and Payments
 * return PayPal's first result, while Payouts refuses the repeated
 * sender_batch_id and `payout` recovers the batch it already created. Keys
 * are built from the contract id for contract-scoped calls
 * (create order, payout, plus the attempt number for a payout sent again)
 * and from the PayPal resource being acted on otherwise (authorize, capture,
 * void, refund, plus a reason for a second refund), which belongs to exactly
 * one contract. Every request times out after REQUEST_TIMEOUT_MS.
 */
import { z } from "zod";
import { requirePayPal, requirePayPalWebhook } from "@/lib/env";

// ---------------------------------------------------------------------------
// Public types (used by the contract service, src/lib/contract)
// ---------------------------------------------------------------------------

export interface CreateAuthorizedOrderInput {
  contractId: string;
  amountCents: number;
  currency: string;
  description: string;
}

export interface CreatedOrder {
  orderId: string;
  /** PayPal order status, e.g. "CREATED" or "PAYER_ACTION_REQUIRED". */
  status: string;
  raw: unknown;
}

export interface Authorization {
  orderId: string;
  authorizationId: string;
  /** e.g. "CREATED" */
  status: string;
  amountCents: number;
  currency: string;
  /** When PayPal stops honouring the authorization (ISO 8601), if returned. */
  expiresAt: string | null;
  raw: unknown;
}

export interface CaptureInput {
  authorizationId: string;
  /** Defaults to the full authorized amount. */
  amountCents?: number;
  currency: string;
}

export interface Capture {
  captureId: string;
  /** e.g. "COMPLETED" */
  status: string;
  amountCents: number;
  currency: string;
  raw: unknown;
}

export interface VoidResult {
  authorizationId: string;
  /** "VOIDED" on success */
  status: string;
  raw: unknown;
}

export interface PayoutInput {
  contractId: string;
  receiverEmail: string;
  amountCents: number;
  currency: string;
  note: string;
  /**
   * Which attempt at paying this share (1 when omitted). Each attempt has its
   * own idempotency key and sender_batch_id; send attempt n + 1 only after
   * PayPal returned attempt n's money (`payoutReturned`).
   */
  attempt?: number;
}

export interface PayoutResult {
  payoutBatchId: string;
  /** e.g. "PENDING" or "SUCCESS" */
  batchStatus: string;
  raw: unknown;
  /**
   * True when PayPal refused this send because the attempt's sender_batch_id
   * was already used (an earlier send whose response was lost) and this is
   * that earlier batch, read back and matched against the input; `raw` is the
   * batch as read. Absent for a batch created by this call.
   */
  recovered?: true;
}

export interface RefundInput {
  captureId: string;
  amountCents: number;
  currency: string;
  note: string;
  /**
   * Distinguishes a second refund of the same capture from the first (e.g.
   * "payout_returned" after a split's payer share was refunded): it is added
   * to the idempotency key, so two refunds of equal amounts are not one.
   */
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  /** e.g. "COMPLETED" */
  status: string;
  amountCents: number;
  raw: unknown;
}

export interface WebhookVerificationInput {
  /** The incoming request headers (PAYPAL-TRANSMISSION-ID, -TIME, -SIG, CERT-URL, AUTH-ALGO). */
  headers: Headers;
  /** The request body exactly as received. */
  rawBody: string;
}

/** One payout item's state. Payouts are asynchronous: read this until it settles. */
export interface PayoutItemStatus {
  payoutItemId: string;
  payoutBatchId: string;
  /**
   * SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD, BLOCKED, REFUNDED,
   * REVERSED; null while PayPal has not assigned one yet.
   */
  transactionStatus: string | null;
  amountCents: number;
  currency: string;
  receiver: string | null;
  senderItemId: string | null;
  /** PayPal's error object for a failed item, if any. */
  errors: unknown;
  raw: unknown;
}

export interface PayoutBatchStatus {
  payoutBatchId: string;
  /** DENIED, PENDING, PROCESSING, SUCCESS, CANCELED. SUCCESS still needs each item checked. */
  batchStatus: string;
  items: PayoutItemStatus[];
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  location?: string;
  value?: string;
}

/**
 * An error response from PayPal, or a refused outcome on a 2xx response.
 * `paypalName` is PayPal's error `name` (e.g. "UNPROCESSABLE_ENTITY",
 * "INSUFFICIENT_FUNDS"); `issue` is the first detail's issue code (e.g.
 * "AUTHORIZATION_ALREADY_CAPTURED"), which is usually the one to branch on.
 */
export class PayPalError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly paypalName: string;
  readonly paypalMessage: string;
  readonly debugId: string | null;
  readonly details: PayPalErrorDetail[];
  readonly body: unknown;

  constructor(init: {
    operation: string;
    status: number;
    paypalName: string;
    paypalMessage: string;
    debugId: string | null;
    details?: PayPalErrorDetail[];
    body?: unknown;
  }) {
    const details = init.details ?? [];
    const first = details[0];
    const issue = first?.issue ? ` (${first.issue}${first.description ? `: ${first.description}` : ""})` : "";
    const debug = init.debugId ? ` [debug_id ${init.debugId}]` : "";
    super(
      `PayPal ${init.operation} failed: HTTP ${init.status} ${init.paypalName}: ${init.paypalMessage}${issue}${debug}`,
    );
    this.name = "PayPalError";
    this.operation = init.operation;
    this.status = init.status;
    this.paypalName = init.paypalName;
    this.paypalMessage = init.paypalMessage;
    this.debugId = init.debugId;
    this.details = details;
    this.body = init.body;
  }

  get issue(): string | null {
    return this.details[0]?.issue ?? null;
  }
}

const ErrorBodySchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z
    .array(
      z.object({
        issue: z.string().optional(),
        description: z.string().optional(),
        field: z.string().optional(),
        location: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  // OAuth endpoint errors use this shape instead.
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function errorFromResponse(operation: string, status: number, headerDebugId: string | null, text: string): PayPalError {
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy): keep the text as the body.
  }
  const parsed = ErrorBodySchema.safeParse(body);
  const e = parsed.success ? parsed.data : {};
  return new PayPalError({
    operation,
    status,
    paypalName: e.name ?? e.error ?? `HTTP_${status}`,
    paypalMessage: e.message ?? e.error_description ?? (text.slice(0, 200) || "empty response body"),
    debugId: e.debug_id ?? headerDebugId,
    details: e.details ?? [],
    body,
  });
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** PayPal currencies without minor units (PayPal currency codes reference). */
const ZERO_DECIMAL_CURRENCIES = new Set(["HUF", "JPY", "TWD"]);

function minorDigits(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** Integer minor units to PayPal's decimal string: 12345 USD -> "123.45". */
export function toPayPalValue(amountCents: number, currency: string): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`amount must be a positive whole number of minor units, got ${amountCents}`);
  }
  if (minorDigits(currency) === 0) return String(amountCents);
  return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`;
}

/**
 * PayPal's decimal string to integer minor units, without floating point:
 * "123.45" -> 12345, "1.0" -> 100. A leading minus sign (some refund
 * payloads) is dropped: the ledger stores magnitudes.
 */
export function fromPayPalValue(value: string, currency: string): number {
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`cannot parse PayPal amount "${value}"`);
  const [, whole, fraction = ""] = match;
  const digits = minorDigits(currency);
  if (fraction.replace(/0+$/, "").length > digits) {
    throw new Error(`PayPal amount "${value}" has more decimals than ${currency} allows`);
  }
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0").slice(0, digits) || "0");
}

// ---------------------------------------------------------------------------
// OAuth token (client credentials), cached in memory
// ---------------------------------------------------------------------------

/** Refresh this long before PayPal's stated expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  clientId: string;
  token: string;
  refreshAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingToken: { clientId: string; promise: Promise<CachedToken> } | null = null;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/** How long one PayPal request (response body included) may take. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sends one request and reads its body, giving up after REQUEST_TIMEOUT_MS.
 * A timeout throws PayPalError (status 0, name "TIMEOUT"): a failed step that
 * the caller retries with the same PayPal-Request-Id, since PayPal may still
 * have acted on it.
 */
async function timedFetch(operation: string, url: string, init: RequestInit): Promise<{ res: Response; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { res, text: await res.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new PayPalError({
        operation,
        status: 0,
        paypalName: "TIMEOUT",
        paypalMessage: `no response within ${REQUEST_TIMEOUT_MS / 1000} s; PayPal may still have acted on the request`,
        debugId: null,
      });
    }
    throw err;
  }
}

async function fetchToken(clientId: string, clientSecret: string, apiBase: string): Promise<CachedToken> {
  const operation = "POST /v1/oauth2/token";
  const { res, text } = await timedFetch(operation, `${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw errorFromResponse(operation, res.status, res.headers.get("paypal-debug-id"), text);
  const body = parseResponse(TokenResponseSchema, JSON.parse(text), operation);
  const lifetimeMs = body.expires_in * 1000;
  return {
    clientId,
    token: body.access_token,
    refreshAt: Date.now() + Math.max(lifetimeMs - TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2),
  };
}

/**
 * A sandbox access token, cached until shortly before it expires. Concurrent
 * callers share one token request. Exported for tools that take a bearer
 * token directly (e.g. PayPal's MCP server); never log its value.
 */
export async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, apiBase } = requirePayPal();
  if (cachedToken && cachedToken.clientId === clientId && Date.now() < cachedToken.refreshAt) {
    return cachedToken.token;
  }
  if (pendingToken?.clientId !== clientId) {
    const promise: Promise<CachedToken> = fetchToken(clientId, clientSecret, apiBase).finally(() => {
      if (pendingToken?.promise === promise) pendingToken = null;
    });
    pendingToken = { clientId, promise };
  }
  cachedToken = await pendingToken.promise;
  return cachedToken.token;
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

interface PayPalRequest {
  method: "GET" | "POST";
  path: string;
  /** JSON body. Omit for no body. */
  body?: unknown;
  /** Already-serialized JSON, sent byte for byte (webhook verification). */
  rawJson?: string;
  /** Sent as PayPal-Request-Id. Required for every call that moves money. */
  idempotencyKey?: string;
}

interface PayPalResponse {
  status: number;
  data: unknown;
  debugId: string | null;
}

async function paypalRequest(req: PayPalRequest): Promise<PayPalResponse> {
  const { apiBase } = requirePayPal();
  const operation = `${req.method} ${req.path}`;
  const send = async (token: string) =>
    timedFetch(operation, `${apiBase}${req.path}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: "return=representation",
        ...(req.body !== undefined || req.rawJson !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(req.idempotencyKey ? { "PayPal-Request-Id": req.idempotencyKey } : {}),
      },
      body: req.rawJson ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined),
    });

  let { res, text } = await send(await getAccessToken());
  if (res.status === 401) {
    // The cached token was revoked or expired early. Retrying is safe: the
    // request carries the same PayPal-Request-Id.
    cachedToken = null;
    ({ res, text } = await send(await getAccessToken()));
  }
  const debugId = res.headers.get("paypal-debug-id");
  if (!res.ok) throw errorFromResponse(operation, res.status, debugId, text);
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`PayPal ${operation} returned HTTP ${res.status} with a body that is not JSON`);
    }
  }
  return { status: res.status, data, debugId };
}

function parseResponse<S extends z.ZodType>(schema: S, data: unknown, operation: string): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`PayPal ${operation} returned an unexpected response: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Throws PayPalError when a 2xx response reports a refused outcome. */
function assertOutcome(
  operation: string,
  res: PayPalResponse,
  what: string,
  status: string,
  refused: readonly string[],
): void {
  if (!refused.includes(status)) return;
  throw new PayPalError({
    operation,
    status: res.status,
    paypalName: `${what.toUpperCase().replace(/ /g, "_")}_${status}`,
    paypalMessage: `PayPal returned the ${what} with status ${status}; no money moved`,
    debugId: res.debugId,
    body: res.data,
  });
}

/**
 * Cuts free text to a field's maximum length (in code points), so a long
 * contract title cannot make PayPal reject a money call. Limits are from the
 * OpenAPI specs: refund note_to_payer 255, payout item note 4000; purchase
 * unit description is 3000 in Orders v2.32 but was 127 before, so 127.
 */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function path(template: string, id: string): string {
  return template.replace("{id}", encodeURIComponent(id));
}

/** The PayPal-Request-Id for an action: "clause:<action>:<subject>[:<detail>]". */
function requestId(action: string, ...parts: (string | number)[]): string {
  return ["clause", action, ...parts].join(":");
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields this module reads)
// ---------------------------------------------------------------------------

const MoneySchema = z.object({ currency_code: z.string(), value: z.string() });

const OrderSchema = z.object({ id: z.string().min(1), status: z.string() });

const AuthorizationSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: MoneySchema,
  expiration_time: z.string().optional(),
});

const AuthorizeOrderSchema = z.object({
  id: z.string().min(1),
  purchase_units: z
    .array(z.object({ payments: z.object({ authorizations: z.array(AuthorizationSchema).min(1) }) }))
    .min(1),
});

const CaptureSchema = z.object({ id: z.string().min(1), status: z.string(), amount: MoneySchema });

const VoidSchema = z.object({ id: z.string().min(1), status: z.string() });

const RefundSchema = z.object({ id: z.string().min(1), status: z.string(), amount: MoneySchema });

const PayoutCreateSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string().min(1), batch_status: z.string() }),
});

const PayoutItemSchema = z.object({
  payout_item_id: z.string().min(1),
  payout_batch_id: z.string().optional(),
  transaction_status: z.string().optional(),
  payout_item: z.object({
    amount: z.object({ currency: z.string(), value: z.string() }),
    receiver: z.string().optional(),
    sender_item_id: z.string().optional(),
  }),
  errors: z.unknown().optional(),
});

const PayoutBatchSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string().min(1), batch_status: z.string() }),
  items: z.array(PayoutItemSchema).default([]),
});

const VerifySchema = z.object({ verification_status: z.string() });

function toItemStatus(item: z.infer<typeof PayoutItemSchema>, batchId: string, raw: unknown): PayoutItemStatus {
  const { currency, value } = item.payout_item.amount;
  return {
    payoutItemId: item.payout_item_id,
    payoutBatchId: item.payout_batch_id ?? batchId,
    transactionStatus: item.transaction_status ?? null,
    amountCents: fromPayPalValue(value, currency),
    currency,
    receiver: item.payout_item.receiver ?? null,
    senderItemId: item.payout_item.sender_item_id ?? null,
    errors: item.errors ?? null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Creates an order with `intent: AUTHORIZE` for the payer to approve in the JS SDK button. */
export async function createAuthorizedOrder(input: CreateAuthorizedOrderInput): Promise<CreatedOrder> {
  const operation = "POST /v2/checkout/orders";
  const res = await paypalRequest({
    method: "POST",
    path: "/v2/checkout/orders",
    // Terms are immutable once SIGNED, so one contract has one order; the
    // amount is in the key so a changed amount can never replay an old order.
    idempotencyKey: requestId("create-order", input.contractId, `${input.amountCents}${input.currency}`),
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.contractId,
          custom_id: input.contractId,
          description: clip(input.description, 127),
          amount: { currency_code: input.currency, value: toPayPalValue(input.amountCents, input.currency) },
        },
      ],
    },
  });
  const order = parseResponse(OrderSchema, res.data, operation);
  return { orderId: order.id, status: order.status, raw: res.data };
}

/**
 * Authorizes an order the payer has approved. The money is now held.
 * Throws PayPalError if PayPal refuses (e.g. ORDER_NOT_APPROVED) or returns a
 * DENIED authorization. Status "PENDING" is returned as is: held, under review.
 */
export async function authorizeOrder(orderId: string): Promise<Authorization> {
  const apiPath = path("/v2/checkout/orders/{id}/authorize", orderId);
  const operation = `POST ${apiPath}`;
  const res = await paypalRequest({
    method: "POST",
    path: apiPath,
    idempotencyKey: requestId("authorize", orderId),
    body: {},
  });
  const order = parseResponse(AuthorizeOrderSchema, res.data, operation);
  const auth = order.purchase_units[0].payments.authorizations[0];
  assertOutcome(operation, res, "authorization", auth.status, ["DENIED"]);
  return {
    orderId: order.id,
    authorizationId: auth.id,
    status: auth.status,
    amountCents: fromPayPalValue(auth.amount.value, auth.amount.currency_code),
    currency: auth.amount.currency_code,
    expiresAt: auth.expiration_time ?? null,
    raw: res.data,
  };
}

/**
 * Captures a held authorization, in full or (with `amountCents`) in part.
 * Always a final capture: one capture per authorization, and PayPal releases
 * any uncaptured remainder. Throws PayPalError on a DECLINED or FAILED capture.
 */
export async function captureAuthorization(input: CaptureInput): Promise<Capture> {
  const apiPath = path("/v2/payments/authorizations/{id}/capture", input.authorizationId);
  const operation = `POST ${apiPath}`;
  const res = await paypalRequest({
    method: "POST",
    path: apiPath,
    idempotencyKey: requestId("capture", input.authorizationId, input.amountCents ?? "full"),
    body:
      input.amountCents === undefined
        ? { final_capture: true }
        : {
            amount: { currency_code: input.currency, value: toPayPalValue(input.amountCents, input.currency) },
            final_capture: true,
          },
  });
  const capture = parseResponse(CaptureSchema, res.data, operation);
  assertOutcome(operation, res, "capture", capture.status, ["DECLINED", "FAILED"]);
  return {
    captureId: capture.id,
    status: capture.status,
    amountCents: fromPayPalValue(capture.amount.value, capture.amount.currency_code),
    currency: capture.amount.currency_code,
    raw: res.data,
  };
}

/** Voids a held authorization; the payer is never charged. */
export async function voidAuthorization(authorizationId: string): Promise<VoidResult> {
  const apiPath = path("/v2/payments/authorizations/{id}/void", authorizationId);
  const res = await paypalRequest({
    method: "POST",
    path: apiPath,
    idempotencyKey: requestId("void", authorizationId),
  });
  // PayPal answers 204 with no body unless it honours Prefer: return=representation.
  if (res.data === null) return { authorizationId, status: "VOIDED", raw: null };
  const voided = parseResponse(VoidSchema, res.data, `POST ${apiPath}`);
  return { authorizationId: voided.id, status: voided.status, raw: res.data };
}

/**
 * Sends a Payouts API payment to the worker's email. Payouts are asynchronous:
 * the batch usually comes back PENDING; read it with `getPayoutBatch` or wait
 * for the PAYMENT.PAYOUTS-ITEM.* webhook. One payout per contract and
 * attempt: the sender_batch_id is derived from the contract id (plus the
 * attempt number from the second attempt on), and PayPal refuses a repeated
 * one for 30 days instead of replaying it. That refusal links to the existing
 * batch, so a send whose response was lost is recovered on the next call: the
 * batch is read back and returned (`recovered: true`) if it pays this amount
 * to this receiver, and an Error is thrown if it does not.
 */
export async function payout(input: PayoutInput): Promise<PayoutResult> {
  const operation = "POST /v1/payments/payouts";
  const attempt = input.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`payout attempt must be a whole number from 1, got ${attempt}`);
  }
  // Attempt 1 keeps the key it always had, so a send retried across this change cannot pay twice.
  const key = attempt === 1 ? requestId("payout", input.contractId) : requestId("payout", input.contractId, attempt);
  let res: PayPalResponse;
  try {
    res = await paypalRequest({
      method: "POST",
      path: "/v1/payments/payouts",
      idempotencyKey: key,
      body: {
        sender_batch_header: {
          sender_batch_id: key,
          email_subject: "You have a payout from Treuhand",
        },
        items: [
          {
            recipient_type: "EMAIL",
            // Payouts uses `currency`, not `currency_code` as Orders and Payments do.
            amount: { value: toPayPalValue(input.amountCents, input.currency), currency: input.currency },
            receiver: input.receiverEmail,
            note: clip(input.note, 4000),
            sender_item_id: input.contractId,
          },
        ],
      },
    });
  } catch (err) {
    const existing = duplicateBatchId(err);
    if (!existing) throw err;
    return recoverPayout(input, key, existing, err);
  }
  const created = parseResponse(PayoutCreateSchema, res.data, operation);
  assertOutcome(operation, res, "payout batch", created.batch_header.batch_status, ["DENIED"]);
  return {
    payoutBatchId: created.batch_header.payout_batch_id,
    batchStatus: created.batch_header.batch_status,
    raw: res.data,
  };
}

const DuplicateBatchSchema = z.object({
  details: z.array(
    z.object({
      field: z.string().optional(),
      issue: z.string().optional(),
      link: z.array(z.object({ href: z.string() })).optional(),
    }),
  ),
});

/**
 * The existing batch's id when PayPal refused a payout because its
 * sender_batch_id was already used, else null. As observed in the sandbox
 * (docs/paypal-notes.md, section 2): HTTP 400 USER_BUSINESS_ERROR whose
 * detail has field SENDER_BATCH_ID, issue "Batch with given sender_batch_id
 * already exists" and `link[].href` ending in the batch id; the top-level
 * `links` is empty.
 */
function duplicateBatchId(err: unknown): string | null {
  if (!(err instanceof PayPalError) || err.status !== 400) return null;
  const parsed = DuplicateBatchSchema.safeParse(err.body);
  if (!parsed.success) return null;
  for (const detail of parsed.data.details) {
    if (detail.field !== "SENDER_BATCH_ID" || !/already exists/i.test(detail.issue ?? "")) continue;
    for (const { href } of detail.link ?? []) {
      const id = /\/v1\/payments\/payouts\/([^/?#]+)$/.exec(href)?.[1];
      if (id) return decodeURIComponent(id);
    }
  }
  return null;
}

/**
 * Reads back the batch a refused duplicate send links to and returns it only
 * if it is this payout: its sender_batch_id (when PayPal reports it) is `key`,
 * and its one item pays the input's amount and currency to the input's
 * receiver. Anything else throws a plain Error and is never treated as sent.
 * A DENIED batch throws PayPalError as it would have when created.
 */
async function recoverPayout(input: PayoutInput, key: string, batchId: string, refusal: unknown): Promise<PayoutResult> {
  const batch = await getPayoutBatch(batchId);
  const senderBatchId = (batch.raw as { batch_header?: { sender_batch_header?: { sender_batch_id?: unknown } } })
    .batch_header?.sender_batch_header?.sender_batch_id;
  const item = batch.items[0];
  const mismatch =
    senderBatchId !== undefined && senderBatchId !== key
      ? `its sender_batch_id is ${String(senderBatchId)}`
      : batch.items.length !== 1
        ? `it has ${batch.items.length} items`
        : item.amountCents !== input.amountCents || item.currency.toUpperCase() !== input.currency.toUpperCase()
          ? `it pays ${item.amountCents} ${item.currency}`
          : item.receiver?.toLowerCase() !== input.receiverEmail.toLowerCase()
            ? `it pays ${item.receiver ?? "no receiver"}`
            : null;
  if (mismatch) {
    throw new Error(
      `PayPal refused payout ${key} as a duplicate of batch ${batchId}, which does not match it (${mismatch}; ` +
        `this payout is ${input.amountCents} ${input.currency} to ${input.receiverEmail}); it is not treated as sent`,
      { cause: refusal },
    );
  }
  const read = { status: 200, data: batch.raw, debugId: null };
  assertOutcome(`GET /v1/payments/payouts/${batchId}`, read, "payout batch", batch.batchStatus, ["DENIED"]);
  return { payoutBatchId: batch.payoutBatchId, batchStatus: batch.batchStatus, raw: batch.raw, recovered: true };
}

/** Reads a payout batch and the status of each of its items. */
export async function getPayoutBatch(payoutBatchId: string): Promise<PayoutBatchStatus> {
  const apiPath = path("/v1/payments/payouts/{id}", payoutBatchId);
  const res = await paypalRequest({ method: "GET", path: apiPath });
  const batch = parseResponse(PayoutBatchSchema, res.data, `GET ${apiPath}`);
  const id = batch.batch_header.payout_batch_id;
  const rawItems = (res.data as { items?: unknown[] }).items ?? [];
  return {
    payoutBatchId: id,
    batchStatus: batch.batch_header.batch_status,
    items: batch.items.map((item, i) => toItemStatus(item, id, rawItems[i])),
    raw: res.data,
  };
}

/** Reads one payout item (e.g. to see whether an UNCLAIMED payout was claimed). */
export async function getPayoutItem(payoutItemId: string): Promise<PayoutItemStatus> {
  const apiPath = path("/v1/payments/payouts-item/{id}", payoutItemId);
  const res = await paypalRequest({ method: "GET", path: apiPath });
  const item = parseResponse(
    PayoutItemSchema.extend({ payout_batch_id: z.string().min(1) }),
    res.data,
    `GET ${apiPath}`,
  );
  return toItemStatus(item, item.payout_batch_id, res.data);
}

/**
 * What a payout batch means for the contract. Payouts are asynchronous: an
 * accepted batch is not yet money in the worker's account.
 * - PAID: every item is SUCCESS; the money is in the worker's account.
 * - PENDING: PayPal is still working on it (PENDING, ONHOLD, or no status
 *   yet); keep the contract PASSED and read the batch again later.
 * - NOT_PAID: the batch was DENIED or CANCELED, or an item is UNCLAIMED,
 *   FAILED, RETURNED, BLOCKED, REFUNDED, REVERSED or CANCELED. Record it and
 *   show it; send the share again only when `payoutReturned` says PayPal gave
 *   the money back. UNCLAIMED can still become SUCCESS if the recipient opens
 *   a PayPal account within 30 days.
 */
export type PayoutOutcome = "PAID" | "PENDING" | "NOT_PAID";

const PAYOUT_ITEM_NOT_PAID: ReadonlySet<string> = new Set([
  "UNCLAIMED",
  "FAILED",
  "RETURNED",
  "BLOCKED",
  "REFUNDED",
  "REVERSED",
  "CANCELED",
]);

export function payoutOutcome(batch: PayoutBatchStatus): PayoutOutcome {
  if (batch.batchStatus === "DENIED" || batch.batchStatus === "CANCELED") return "NOT_PAID";
  const statuses = batch.items.map((item) => item.transactionStatus);
  if (statuses.some((s) => s !== null && PAYOUT_ITEM_NOT_PAID.has(s))) return "NOT_PAID";
  if (statuses.length > 0 && statuses.every((s) => s === "SUCCESS")) return "PAID";
  return "PENDING";
}

/**
 * True when a NOT_PAID payout is final and PayPal has given its money back to
 * the sender: the batch was DENIED or CANCELED, or an item is FAILED,
 * RETURNED, BLOCKED, REFUNDED, REVERSED or CANCELED. The same share may then
 * be sent again as a new attempt. False for UNCLAIMED: PayPal still holds that
 * money for the recipient to claim, so it must not be sent again.
 */
export function payoutReturned(batch: PayoutBatchStatus): boolean {
  return (
    payoutOutcome(batch) === "NOT_PAID" &&
    !batch.items.some((item) => item.transactionStatus === "UNCLAIMED")
  );
}

/** Refunds part or all of a capture back to the payer. Throws PayPalError on a FAILED or CANCELLED refund. */
export async function refundCapture(input: RefundInput): Promise<RefundResult> {
  const apiPath = path("/v2/payments/captures/{id}/refund", input.captureId);
  const operation = `POST ${apiPath}`;
  const res = await paypalRequest({
    method: "POST",
    path: apiPath,
    idempotencyKey: requestId("refund", input.captureId, input.amountCents, ...(input.reason ? [input.reason] : [])),
    body: {
      amount: { currency_code: input.currency, value: toPayPalValue(input.amountCents, input.currency) },
      note_to_payer: clip(input.note, 255),
    },
  });
  const refund = parseResponse(RefundSchema, res.data, operation);
  assertOutcome(operation, res, "refund", refund.status, ["FAILED", "CANCELLED"]);
  return {
    refundId: refund.id,
    status: refund.status,
    amountCents: fromPayPalValue(refund.amount.value, refund.amount.currency_code),
    raw: res.data,
  };
}

/**
 * Verifies a webhook with PayPal's verify-webhook-signature API. True only for
 * a verified event. False when PayPal's signature headers are missing or the
 * body is not JSON (not a PayPal delivery). Throws when PayPal itself rejects
 * the verification request or cannot be reached, so the caller can tell
 * "forged" from "could not check".
 */
export async function verifyWebhookSignature(input: WebhookVerificationInput): Promise<boolean> {
  const { webhookId } = requirePayPalWebhook();
  const fields = {
    auth_algo: input.headers.get("paypal-auth-algo"),
    cert_url: input.headers.get("paypal-cert-url"),
    transmission_id: input.headers.get("paypal-transmission-id"),
    transmission_sig: input.headers.get("paypal-transmission-sig"),
    transmission_time: input.headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
  };
  if (Object.values(fields).some((value) => !value)) return false;
  try {
    JSON.parse(input.rawBody);
  } catch {
    return false;
  }
  // PayPal requires webhook_event "exactly as it was received": splice the raw
  // body in rather than parsing and re-serializing it.
  const rawJson = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${input.rawBody}}`;
  const apiPath = "/v1/notifications/verify-webhook-signature";
  const res = await paypalRequest({ method: "POST", path: apiPath, rawJson });
  return parseResponse(VerifySchema, res.data, `POST ${apiPath}`).verification_status === "SUCCESS";
}
