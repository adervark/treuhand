/**
 * Exercises src/lib/paypal against the real PayPal sandbox. Never prints
 * credentials or the access token; prints PayPal ids and statuses only.
 *
 *   pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts <mode> [arg]
 *
 * Modes:
 *   order                 token (and that it is cached), create a $10.00
 *                         AUTHORIZE order, replay it to show idempotency.
 *                         Prints the approve link: open it, log in as a
 *                         sandbox buyer, approve, then run capture or void.
 *   capture <orderId>     an approved order: authorize -> partial capture
 *                         ($7.00 of $10.00) -> partial refund ($3.00), each
 *                         replayed to show PayPal returns the first result.
 *   void <orderId>        an approved order: authorize -> void, replayed.
 *   payout [email]        a real $1.00 payout, then the same request again:
 *                         PayPal refuses the repeated sender_batch_id (HTTP
 *                         400) and `payout` must recover the same batch. Then
 *                         reads its status until it settles. With no email,
 *                         pays a made-up example.com address, which stays
 *                         UNCLAIMED; pass the worker's sandbox personal email
 *                         to see SUCCESS.
 *   payout-status <id>    read a payout batch and classify it.
 *   payout-retry [email]  a payout PayPal refuses (more than the balance),
 *                         then $1.00 for the same contract: shows whether a
 *                         failed payout leaves the contract's idempotency key
 *                         usable for the retry.
 *   payout-sim            PayPal's documented Payouts test values: canned
 *                         responses for create (POSPYO001), an error
 *                         (ERRPYO005) and a status read (POSPYO002). Checks
 *                         our parsing against PayPal's payloads; moves no money.
 *   card-capture          no buyer login: approve a new order with a sandbox
 *   card-void             test card (confirm-payment-source), then run capture
 *                         or void. Needs card processing on the business account.
 */
import {
  authorizeOrder,
  captureAuthorization,
  createAuthorizedOrder,
  getAccessToken,
  getPayoutBatch,
  getPayoutItem,
  payout,
  payoutOutcome,
  PayPalError,
  refundCapture,
  voidAuthorization,
  type Authorization,
  type PayoutBatchStatus,
} from "@/lib/paypal";
import { requirePayPal } from "@/lib/env";

const ORDER_CENTS = 1000;
const CAPTURE_CENTS = 700;
const REFUND_CENTS = 300;
const PAYOUT_CENTS = 100;
/** More than any sandbox balance, so PayPal refuses the payout. */
const TOO_MUCH_CENTS = 9_000_000;
const CURRENCY = "USD";
const FAKE_RECEIVER = "clause-smoke-no-account@example.com";
/** Visa test number from developer.paypal.com/sandbox-testing/card-testing. */
const TEST_CARD = { number: "4012888888881881", expiry: "2030-12", security_code: "123", name: "Treuhand Smoke" };

const USAGE =
  "usage: paypal-smoke.ts order | capture <orderId> | void <orderId> | payout [email] | payout-status <batchId> |" +
  " payout-retry [email] | payout-sim | card-capture | card-void";

function log(step: string, data: Record<string, unknown>): void {
  console.log(`${step.padEnd(28)} ${JSON.stringify(data)}`);
}

function logPayPalError(step: string, err: PayPalError): void {
  log(step, { status: err.status, name: err.paypalName, issue: err.issue, message: err.paypalMessage, debugId: err.debugId });
}

function newContractId(): string {
  return `smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
}

function linkOf(raw: unknown, ...rels: string[]): string | null {
  const links = (raw as { links?: { rel: string; href: string }[] }).links ?? [];
  return links.find((l) => rels.includes(l.rel))?.href ?? null;
}

async function tokenCheck(): Promise<void> {
  const token = await getAccessToken();
  const again = await getAccessToken();
  log("token", { obtained: token.length > 0, cachedOnSecondCall: token === again });
}

async function createOrder(contractId: string) {
  const order = await createAuthorizedOrder({
    contractId,
    amountCents: ORDER_CENTS,
    currency: CURRENCY,
    description: `Treuhand smoke test ${contractId}`,
  });
  log("create order", { orderId: order.orderId, status: order.status, approve: linkOf(order.raw, "approve", "payer-action") });
  return order;
}

async function orderMode(): Promise<void> {
  await tokenCheck();
  const contractId = newContractId();
  log("contract id", { contractId });
  const order = await createOrder(contractId);
  const replay = await createOrder(contractId);
  log("create order replay", { sameOrder: replay.orderId === order.orderId });
}

async function authorize(orderId: string): Promise<Authorization> {
  const auth = await authorizeOrder(orderId);
  log("authorize", {
    orderId: auth.orderId,
    authorizationId: auth.authorizationId,
    status: auth.status,
    cents: auth.amountCents,
    expiresAt: auth.expiresAt,
  });
  const replay = await authorizeOrder(orderId);
  log("authorize replay", { sameAuthorization: replay.authorizationId === auth.authorizationId });
  return auth;
}

async function captureAndRefund(orderId: string): Promise<void> {
  const auth = await authorize(orderId);
  const captureInput = { authorizationId: auth.authorizationId, amountCents: CAPTURE_CENTS, currency: auth.currency };
  const capture = await captureAuthorization(captureInput);
  log("partial capture", { captureId: capture.captureId, status: capture.status, cents: capture.amountCents });
  const captureReplay = await captureAuthorization(captureInput);
  log("capture replay", { sameCapture: captureReplay.captureId === capture.captureId });

  const refundInput = {
    captureId: capture.captureId,
    amountCents: REFUND_CENTS,
    currency: capture.currency,
    note: "Treuhand smoke test partial refund",
  };
  const refund = await refundCapture(refundInput);
  log("partial refund", { refundId: refund.refundId, status: refund.status, cents: refund.amountCents });
  const refundReplay = await refundCapture(refundInput);
  log("refund replay", { sameRefund: refundReplay.refundId === refund.refundId });
}

async function authorizeAndVoid(orderId: string): Promise<void> {
  const auth = await authorize(orderId);
  const voided = await voidAuthorization(auth.authorizationId);
  log("void", { authorizationId: voided.authorizationId, status: voided.status });
  const replay = await voidAuthorization(auth.authorizationId);
  log("void replay", { status: replay.status });
}

function logBatch(step: string, batch: PayoutBatchStatus): void {
  log(step, {
    payoutBatchId: batch.payoutBatchId,
    batchStatus: batch.batchStatus,
    outcome: payoutOutcome(batch),
    items: batch.items.map((i) => ({ payoutItemId: i.payoutItemId, status: i.transactionStatus, cents: i.amountCents })),
  });
}

async function payoutMode(receiver: string | undefined): Promise<void> {
  await tokenCheck();
  const contractId = newContractId();
  const input = {
    contractId,
    receiverEmail: receiver ?? FAKE_RECEIVER,
    amountCents: PAYOUT_CENTS,
    currency: CURRENCY,
    note: `Treuhand smoke test ${contractId}`,
  };
  log("contract id", { contractId, receiver: receiver ? "given" : "made-up example.com address" });
  const paid = await payout(input);
  log("payout", { payoutBatchId: paid.payoutBatchId, batchStatus: paid.batchStatus });
  // PayPal does not replay a payout: it refuses the repeated sender_batch_id, and `payout` reads that batch back.
  const again = await payout(input);
  if (!again.recovered || again.payoutBatchId !== paid.payoutBatchId) {
    throw new Error(
      `the replay was not recovered as batch ${paid.payoutBatchId}: got ${again.payoutBatchId} (recovered: ${again.recovered === true})`,
    );
  }
  log("payout replay", { result: "same batch recovered", payoutBatchId: again.payoutBatchId, batchStatus: again.batchStatus });

  for (let attempt = 1; attempt <= 12; attempt++) {
    const batch = await getPayoutBatch(paid.payoutBatchId);
    logBatch(`payout status #${attempt}`, batch);
    if (payoutOutcome(batch) !== "PENDING") {
      const item = batch.items[0];
      if (item) {
        const read = await getPayoutItem(item.payoutItemId);
        log("payout item", { payoutItemId: read.payoutItemId, status: read.transactionStatus, errors: read.errors });
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  log("payout still pending", { payoutBatchId: paid.payoutBatchId, next: `payout-status ${paid.payoutBatchId}` });
}

async function payoutRetry(receiver: string | undefined): Promise<void> {
  await tokenCheck();
  const contractId = newContractId();
  const base = { contractId, receiverEmail: receiver ?? FAKE_RECEIVER, currency: CURRENCY, note: `Treuhand smoke ${contractId}` };
  log("contract id", { contractId });
  try {
    const refused = await payout({ ...base, amountCents: TOO_MUCH_CENTS });
    log("oversized payout ACCEPTED", { payoutBatchId: refused.payoutBatchId, batchStatus: refused.batchStatus });
    throw new Error("PayPal accepted a payout larger than the balance; this mode proves nothing on this account");
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    logPayPalError("oversized payout refused", err);
  }
  const retry = await payout({ ...base, amountCents: PAYOUT_CENTS });
  log("retry, same contract", {
    payoutBatchId: retry.payoutBatchId,
    batchStatus: retry.batchStatus,
    recovered: retry.recovered === true,
    retryable: true,
  });
}

async function payoutSim(): Promise<void> {
  await tokenCheck();
  const contractId = newContractId();
  const base = { receiverEmail: "payouts-simulator-receiver@paypal.com", amountCents: PAYOUT_CENTS, currency: CURRENCY };
  log("SIMULATED", { note: "PayPal test values: canned responses, no money moves" });
  const created = await payout({ ...base, contractId: `${contractId}-pos`, note: "POSPYO001" });
  log("sim payout POSPYO001", { payoutBatchId: created.payoutBatchId, batchStatus: created.batchStatus });
  try {
    await payout({ ...base, contractId: `${contractId}-err`, note: "ERRPYO005" });
    throw new Error("ERRPYO005 did not produce an error");
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    logPayPalError("sim payout ERRPYO005", err);
  }
  logBatch("sim status POSPYO002", await getPayoutBatch("POSPYO002"));
}

/**
 * Approves an order with a sandbox test card (Orders v2 confirm-payment-source),
 * standing in for the buyer's browser approval. Script-only: the app's
 * checkout uses the PayPal button.
 */
async function approveWithTestCard(orderId: string): Promise<void> {
  const { apiBase } = requirePayPal();
  const res = await fetch(`${apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/confirm-payment-source`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ payment_source: { card: TEST_CARD } }),
  });
  const body = (await res.json()) as { status?: string; name?: string; details?: unknown; debug_id?: string };
  log("approve with test card", {
    http: res.status,
    orderStatus: body.status,
    ...(res.ok ? {} : { name: body.name, details: body.details, debugId: body.debug_id }),
  });
  if (!res.ok || body.status !== "APPROVED") throw new Error(`test-card approval did not approve order ${orderId}`);
}

async function main(): Promise<void> {
  const [mode, arg] = process.argv.slice(2);
  switch (mode) {
    case "order":
      return orderMode();
    case "capture":
    case "void":
      if (!arg) throw new Error(`usage: paypal-smoke.ts ${mode} <approved order id>`);
      return mode === "capture" ? captureAndRefund(arg) : authorizeAndVoid(arg);
    case "payout":
      return payoutMode(arg);
    case "payout-status":
      if (!arg) throw new Error("usage: paypal-smoke.ts payout-status <payout batch id>");
      return logBatch("payout status", await getPayoutBatch(arg));
    case "payout-retry":
      return payoutRetry(arg);
    case "payout-sim":
      return payoutSim();
    case "card-capture":
    case "card-void": {
      await tokenCheck();
      const order = await createOrder(newContractId());
      await approveWithTestCard(order.orderId);
      return mode === "card-capture" ? captureAndRefund(order.orderId) : authorizeAndVoid(order.orderId);
    }
    default:
      throw new Error(mode ? `unknown mode "${mode}". ${USAGE}` : USAGE);
  }
}

main().catch((err: unknown) => {
  if (err instanceof PayPalError) {
    log("PAYPAL ERROR", {
      operation: err.operation,
      status: err.status,
      name: err.paypalName,
      issue: err.issue,
      message: err.paypalMessage,
      debugId: err.debugId,
      details: err.details,
    });
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
