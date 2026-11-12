import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { contractIn, withTempDb } from "@/test/helpers";
import { getContract, setPaypalRefs } from "@/lib/db/contracts";
import { listEvents } from "@/lib/db/events";
import { listLedgerEntries, recordLedgerEntry } from "@/lib/db/ledger";
import type { Contract } from "@/lib/types";
import { handlePayPalWebhookEvent } from "./webhook";

withTempDb();

// Contracts from the helpers are 20000 USD cents; FUNDED ones hold ORDER-1 / AUTH-1.
const API = "https://api.sandbox.paypal.com";

let eventSeq = 0;
function event(event_type: string, resource: Record<string, unknown>, id = `WH-${++eventSeq}`) {
  return { id, event_type, resource_type: "x", summary: `${event_type} summary`, create_time: "2026-11-11T00:00:00Z", resource };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    id: "AUTH-1",
    status: "CREATED",
    amount: { currency_code: "USD", value: "200.00" },
    supplementary_data: { related_ids: { order_id: "ORDER-1" } },
    links: [
      { href: `${API}/v2/payments/authorizations/AUTH-1`, rel: "self" },
      { href: `${API}/v2/checkout/orders/ORDER-1`, rel: "up" },
    ],
    ...overrides,
  };
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    id: "CAP-1",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "200.00" },
    supplementary_data: { related_ids: { order_id: "ORDER-1", authorization_id: "AUTH-1" } },
    links: [{ href: `${API}/v2/payments/authorizations/AUTH-1`, rel: "up" }],
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: "REF-1",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "60.00" },
    links: [
      { href: `${API}/v2/payments/refunds/REF-1`, rel: "self" },
      { href: `${API}/v2/payments/captures/CAP-1`, rel: "up" },
    ],
    ...overrides,
  };
}

function payoutItem(transaction_status: string, sender_item_id?: string, value = "200.00") {
  return {
    payout_item_id: "ITEM-1",
    payout_batch_id: "BATCH-1",
    transaction_status,
    payout_item: {
      recipient_type: "EMAIL",
      amount: { currency: "USD", value },
      receiver: "worker@example.com",
      ...(sender_item_id ? { sender_item_id } : {}),
    },
  };
}

function webhookEvents(contractId: string) {
  return listEvents(contractId).filter((e) => e.kind === "PAYPAL_WEBHOOK");
}

function stateChanges(contractId: string) {
  return listEvents(contractId).filter((e) => e.kind === "STATE_CHANGED");
}

function ledger(contractId: string) {
  return listLedgerEntries({ contract_id: contractId }).map((e) => ({
    kind: e.kind,
    amount_cents: e.amount_cents,
    paypal_ref: e.paypal_ref,
  }));
}

/** A SIGNED contract with the order the contract service created for it. */
function signedWithOrder(): Contract {
  const contract = contractIn("SIGNED");
  return setPaypalRefs(contract.id, { paypal_order_id: "ORDER-1" });
}

/** A PASSED contract the contract service captured and paid out (batch accepted, PENDING). */
function passedAndPaidOut(): Contract {
  const contract = contractIn("PASSED");
  setPaypalRefs(contract.id, { paypal_capture_id: "CAP-1", paypal_payout_batch_id: "BATCH-1" });
  recordLedgerEntry({ contract_id: contract.id, kind: "CAPTURED", amount_cents: 20000, paypal_ref: "CAP-1" });
  recordLedgerEntry({ contract_id: contract.id, kind: "PAID_OUT", amount_cents: 20000, paypal_ref: "BATCH-1" });
  return getContract(contract.id)!;
}

describe("PAYMENT.AUTHORIZATION.CREATED", () => {
  it("funds a SIGNED contract through the state machine and records the hold", () => {
    const contract = signedWithOrder();
    const ev = event("PAYMENT.AUTHORIZATION.CREATED", authorization({ custom_id: contract.id }));

    const outcome = handlePayPalWebhookEvent(ev);

    expect(outcome).toEqual({
      status: "processed",
      contractId: contract.id,
      actions: ["ledger AUTHORIZED AUTH-1 recorded", "state SIGNED -> FUNDED"],
    });
    expect(getContract(contract.id)).toMatchObject({
      state: "FUNDED",
      paypal_order_id: "ORDER-1",
      paypal_authorization_id: "AUTH-1",
    });
    expect(ledger(contract.id)).toEqual([{ kind: "AUTHORIZED", amount_cents: 20000, paypal_ref: "AUTH-1" }]);
    expect(stateChanges(contract.id).at(-1)?.detail).toMatchObject({
      from: "SIGNED",
      to: "FUNDED",
      actor: "system",
      source: "paypal_webhook",
      event_id: ev.id,
    });
    expect(webhookEvents(contract.id).map((e) => e.detail)).toEqual([
      {
        actor: "system",
        event_id: ev.id,
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource_id: "AUTH-1",
        summary: "PAYMENT.AUTHORIZATION.CREATED summary",
        actions: outcome.status === "processed" ? outcome.actions : [],
      },
    ]);
  });

  it("does nothing on a redelivery of the same event", () => {
    const contract = signedWithOrder();
    const ev = event("PAYMENT.AUTHORIZATION.CREATED", authorization({ custom_id: contract.id }));
    handlePayPalWebhookEvent(ev);
    const eventsBefore = listEvents(contract.id).length;

    expect(handlePayPalWebhookEvent(ev)).toEqual({ status: "duplicate", contractId: contract.id });
    expect(listEvents(contract.id)).toHaveLength(eventsBefore);
    expect(ledger(contract.id)).toHaveLength(1);
  });

  it("tolerates the contract service having recorded the authorization first", () => {
    const contract = contractIn("FUNDED");
    recordLedgerEntry({ contract_id: contract.id, kind: "AUTHORIZED", amount_cents: 20000, paypal_ref: "AUTH-1" });

    const outcome = handlePayPalWebhookEvent(event("PAYMENT.AUTHORIZATION.CREATED", authorization({ custom_id: contract.id })));

    expect(outcome).toMatchObject({
      status: "processed",
      actions: ["ledger AUTHORIZED AUTH-1 already recorded", "state FUNDED unchanged"],
    });
    expect(ledger(contract.id)).toHaveLength(1);
    expect(stateChanges(contract.id).map((e) => e.detail.to)).toEqual(["SIGNED", "FUNDED"]);
  });

  it("finds the contract by its order id when the resource has no custom_id", () => {
    const contract = signedWithOrder();
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.AUTHORIZATION.CREATED", authorization()));
    expect(outcome).toMatchObject({ status: "processed", contractId: contract.id });
    expect(getContract(contract.id)?.state).toBe("FUNDED");
  });

  it("records but does not fund when the amount or currency differs from the contract", () => {
    const contract = signedWithOrder();
    const outcome = handlePayPalWebhookEvent(
      event("PAYMENT.AUTHORIZATION.CREATED", authorization({ custom_id: contract.id, amount: { currency_code: "USD", value: "1.00" } })),
    );
    expect(outcome).toMatchObject({
      actions: ["ledger AUTHORIZED AUTH-1 recorded", "state SIGNED unchanged: authorized 100 USD, contract is 20000 USD"],
    });
    expect(getContract(contract.id)).toMatchObject({ state: "SIGNED", paypal_authorization_id: null });
  });

  it("does not fund from an order that is not the contract's", () => {
    const contract = signedWithOrder();
    handlePayPalWebhookEvent(
      event(
        "PAYMENT.AUTHORIZATION.CREATED",
        authorization({ custom_id: contract.id, supplementary_data: { related_ids: { order_id: "ORDER-OLD" } } }),
      ),
    );
    expect(getContract(contract.id)?.state).toBe("SIGNED");
    expect(webhookEvents(contract.id)[0].detail.actions).toEqual([
      "ledger AUTHORIZED AUTH-1 recorded",
      "state SIGNED unchanged: authorization is for order ORDER-OLD, contract has order ORDER-1",
    ]);
  });

  it("leaves a contract that already holds another authorization alone", () => {
    const contract = contractIn("FUNDED");
    handlePayPalWebhookEvent(event("PAYMENT.AUTHORIZATION.CREATED", authorization({ id: "AUTH-2", custom_id: contract.id })));
    expect(getContract(contract.id)).toMatchObject({ state: "FUNDED", paypal_authorization_id: "AUTH-1" });
    expect(webhookEvents(contract.id)[0].detail.actions).toEqual([
      "ledger AUTHORIZED AUTH-2 recorded",
      "state FUNDED unchanged: contract holds authorization AUTH-1",
    ]);
  });
});

describe("PAYMENT.AUTHORIZATION.VOIDED", () => {
  it("expires a FUNDED contract whose hold PayPal voided", () => {
    const contract = contractIn("FUNDED");
    const outcome = handlePayPalWebhookEvent(
      event("PAYMENT.AUTHORIZATION.VOIDED", authorization({ status: "VOIDED", custom_id: contract.id })),
    );
    expect(outcome).toMatchObject({ actions: ["ledger VOIDED AUTH-1 recorded", "state FUNDED -> EXPIRED"] });
    expect(getContract(contract.id)?.state).toBe("EXPIRED");
    expect(ledger(contract.id)).toEqual([{ kind: "VOIDED", amount_cents: 20000, paypal_ref: "AUTH-1" }]);
  });

  it("only records the void when the contract service already expired the contract", () => {
    const contract = contractIn("EXPIRED");
    recordLedgerEntry({ contract_id: contract.id, kind: "VOIDED", amount_cents: 20000, paypal_ref: "AUTH-1" });
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.AUTHORIZATION.VOIDED", authorization({ status: "VOIDED" })));
    expect(outcome).toMatchObject({
      contractId: contract.id,
      actions: ["ledger VOIDED AUTH-1 already recorded", "state EXPIRED unchanged"],
    });
  });

  it("does not expire a contract over a void of a hold it does not hold", () => {
    // The contract service voids a mismatched hold while the contract stays SIGNED.
    const contract = signedWithOrder();
    handlePayPalWebhookEvent(
      event("PAYMENT.AUTHORIZATION.VOIDED", authorization({ id: "AUTH-X", status: "VOIDED", custom_id: contract.id })),
    );
    expect(getContract(contract.id)?.state).toBe("SIGNED");
    expect(webhookEvents(contract.id)[0].detail.actions).toEqual([
      "ledger VOIDED AUTH-X recorded",
      "state SIGNED unchanged: contract holds authorization none",
    ]);
  });

  it("does not move a DISPUTED contract whose split voided the hold", () => {
    const contract = contractIn("DISPUTED");
    handlePayPalWebhookEvent(event("PAYMENT.AUTHORIZATION.VOIDED", authorization({ status: "VOIDED", custom_id: contract.id })));
    expect(getContract(contract.id)?.state).toBe("DISPUTED");
  });
});

describe("PAYMENT.CAPTURE.COMPLETED", () => {
  it("records a capture whose response the contract service lost, found by authorization id", () => {
    const contract = contractIn("PASSED");
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", capture()));
    expect(outcome).toEqual({
      status: "processed",
      contractId: contract.id,
      actions: ["ledger CAPTURED CAP-1 recorded", "paypal_capture_id set to CAP-1"],
    });
    expect(getContract(contract.id)).toMatchObject({ state: "PASSED", paypal_capture_id: "CAP-1" });
    expect(ledger(contract.id)).toEqual([{ kind: "CAPTURED", amount_cents: 20000, paypal_ref: "CAP-1" }]);
  });

  it("finds the contract through the capture's up link when related ids are missing", () => {
    const contract = contractIn("PASSED");
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", capture({ supplementary_data: undefined })));
    expect(outcome).toMatchObject({ status: "processed", contractId: contract.id });
  });

  it("tolerates a capture already recorded", () => {
    const contract = passedAndPaidOut();
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", capture({ custom_id: contract.id })));
    expect(outcome).toMatchObject({ actions: ["ledger CAPTURED CAP-1 already recorded"] });
    expect(ledger(contract.id).filter((e) => e.kind === "CAPTURED")).toHaveLength(1);
  });
});

describe("PAYMENT.CAPTURE.REFUNDED", () => {
  it("records the refund against the contract that holds the capture", () => {
    const contract = contractIn("DISPUTED");
    setPaypalRefs(contract.id, { paypal_capture_id: "CAP-1" });
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.REFUNDED", refund()));
    expect(outcome).toMatchObject({ contractId: contract.id, actions: ["ledger REFUNDED REF-1 recorded"] });
    expect(ledger(contract.id)).toEqual([{ kind: "REFUNDED", amount_cents: 6000, paypal_ref: "REF-1" }]);
    expect(getContract(contract.id)?.state).toBe("DISPUTED");
  });
});

describe("PAYMENT.PAYOUTS-ITEM.*", () => {
  it("marks a PASSED contract PAID when its payout item succeeds", () => {
    const contract = passedAndPaidOut();
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payoutItem("SUCCESS", contract.id)));
    expect(outcome).toMatchObject({
      status: "processed",
      contractId: contract.id,
      actions: ["ledger PAID_OUT BATCH-1 already recorded", "state PASSED -> PAID"],
    });
    expect(getContract(contract.id)?.state).toBe("PAID");
    expect(ledger(contract.id).filter((e) => e.kind === "PAID_OUT")).toHaveLength(1);
  });

  it("records a payout whose response was lost, found by sender_item_id", () => {
    const contract = contractIn("PASSED");
    setPaypalRefs(contract.id, { paypal_capture_id: "CAP-1" });
    const outcome = handlePayPalWebhookEvent(event("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payoutItem("SUCCESS", contract.id)));
    expect(outcome).toMatchObject({
      actions: ["ledger PAID_OUT BATCH-1 recorded", "paypal_payout_batch_id set to BATCH-1", "state PASSED -> PAID"],
    });
    expect(getContract(contract.id)).toMatchObject({ state: "PAID", paypal_payout_batch_id: "BATCH-1" });
  });

  it("finds the contract by batch id when the item has no sender_item_id", () => {
    const contract = passedAndPaidOut();
    expect(handlePayPalWebhookEvent(event("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payoutItem("SUCCESS")))).toMatchObject({
      contractId: contract.id,
    });
  });

  it("does not move a DISPUTED contract when the worker's share of a split lands", () => {
    const contract = contractIn("DISPUTED");
    setPaypalRefs(contract.id, { paypal_capture_id: "CAP-1", paypal_payout_batch_id: "BATCH-1" });
    handlePayPalWebhookEvent(event("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payoutItem("SUCCESS", contract.id, "140.00")));
    expect(getContract(contract.id)?.state).toBe("DISPUTED");
    expect(ledger(contract.id)).toEqual([{ kind: "PAID_OUT", amount_cents: 14000, paypal_ref: "BATCH-1" }]);
  });

  it.each([
    ["PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "UNCLAIMED"],
    ["PAYMENT.PAYOUTS-ITEM.FAILED", "FAILED"],
    ["PAYMENT.PAYOUTS-ITEM.RETURNED", "RETURNED"],
    ["PAYMENT.PAYOUTS-ITEM.BLOCKED", "BLOCKED"],
  ])("%s keeps the contract PASSED and records the outcome for the page", (type, status) => {
    const contract = passedAndPaidOut();
    const ledgerBefore = ledger(contract.id);
    const outcome = handlePayPalWebhookEvent(event(type, payoutItem(status, contract.id)));
    expect(outcome).toMatchObject({
      status: "processed",
      actions: [`payout item ITEM-1 is ${status}: the worker has not received the money`],
    });
    expect(getContract(contract.id)?.state).toBe("PASSED");
    expect(ledger(contract.id)).toEqual(ledgerBefore);
    expect(webhookEvents(contract.id)[0].detail).toMatchObject({ event_type: type, resource_id: "ITEM-1" });
  });
});

describe("events that change nothing", () => {
  it("ignores an event for no known contract and records nothing", () => {
    const contract = contractIn("FUNDED");
    const before = listEvents(contract.id).length;
    expect(
      handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", capture({ id: "CAP-9", custom_id: "smoke-1", supplementary_data: undefined, links: [] }))),
    ).toEqual({ status: "ignored", reason: "no contract for capture CAP-9" });
    expect(listEvents(contract.id)).toHaveLength(before);
    expect(listLedgerEntries()).toEqual([]);
  });

  it("ignores event types it does not handle", () => {
    expect(handlePayPalWebhookEvent(event("CHECKOUT.ORDER.APPROVED", { id: "ORDER-1" }))).toEqual({
      status: "ignored",
      reason: "event type CHECKOUT.ORDER.APPROVED is not handled",
    });
  });

  it("throws ZodError for a body that is not a PayPal event", () => {
    expect(() => handlePayPalWebhookEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} })).toThrow(ZodError);
    expect(() => handlePayPalWebhookEvent("nope")).toThrow(ZodError);
  });

  it("throws ZodError for a handled event whose resource lacks a field, writing nothing", () => {
    const contract = contractIn("PASSED");
    const before = listEvents(contract.id).length;
    expect(() =>
      handlePayPalWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-1", status: "COMPLETED", custom_id: contract.id })),
    ).toThrow(ZodError);
    expect(listEvents(contract.id)).toHaveLength(before);
    expect(listLedgerEntries()).toEqual([]);
  });
});
