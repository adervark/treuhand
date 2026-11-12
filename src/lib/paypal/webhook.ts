/**
 * Reconciles verified PayPal webhook events with the ledger and contracts.
 * Webhooks are a secondary confirmation: the contract service records each PayPal
 * call's result directly, so most events find their ledger row already there
 * (rows are unique on (kind, paypal_ref)) and the contract already moved.
 * The handler only fills in what is missing, and changes state only through
 * the state machine and only from the expected pre-state.
 *
 * Idempotent on PayPal's event id: each processed event writes one
 * PAYPAL_WEBHOOK row to `events` with `detail.event_id`; a redelivery finds
 * it and does nothing. Events that match no contract are not recorded (the
 * `events` table needs a contract) and are answered as ignored.
 *
 * Signature verification happens before this, in the route.
 */
import { z } from "zod";
import { canTransition, transition } from "@/lib/contract/machine";
import { getContract, setPaypalRefs } from "@/lib/db/contracts";
import { recordEvent } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { recordLedgerEntry } from "@/lib/db/ledger";
import type { Contract, ContractState, LedgerKind, PaypalRefs } from "@/lib/types";
import { fromPayPalValue } from "./index";

export const WebhookEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().nullish(),
  summary: z.string().nullish(),
  create_time: z.string().nullish(),
  resource: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export type WebhookOutcome =
  | { status: "processed"; contractId: string; actions: string[] }
  | { status: "duplicate"; contractId: string }
  | { status: "ignored"; reason: string };

export const HANDLED_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
] as const;
type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Resource shapes (fields read here; samples from PayPal's webhook simulator)
// ---------------------------------------------------------------------------

const MoneySchema = z.object({ currency_code: z.string(), value: z.string() });
const LinksSchema = z.array(z.object({ href: z.string(), rel: z.string() })).optional();
const RelatedIdsSchema = z
  .object({
    related_ids: z.object({ order_id: z.string().optional(), authorization_id: z.string().optional() }).optional(),
  })
  .optional();

const AuthorizationResource = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: MoneySchema,
  custom_id: z.string().optional(),
  supplementary_data: RelatedIdsSchema,
  links: LinksSchema,
});

const CaptureResource = AuthorizationResource;

const RefundResource = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: MoneySchema,
  custom_id: z.string().optional(),
  links: LinksSchema,
});

const PayoutItemResource = z.object({
  payout_item_id: z.string().min(1),
  payout_batch_id: z.string().min(1),
  transaction_status: z.string(),
  payout_item: z.object({
    amount: z.object({ currency: z.string(), value: z.string() }),
    sender_item_id: z.string().optional(),
  }),
  errors: z.unknown().optional(),
});

/** The id in a HATEOAS link such as `.../v2/payments/captures/{id}`. */
function idFromLinks(links: z.infer<typeof LinksSchema>, collection: string): string | undefined {
  const pattern = new RegExp(`/${collection}/([^/?#]+)`);
  for (const link of links ?? []) {
    const match = pattern.exec(link.href);
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const REF_COLUMN = {
  orderId: "paypal_order_id",
  authorizationId: "paypal_authorization_id",
  captureId: "paypal_capture_id",
  payoutBatchId: "paypal_payout_batch_id",
} as const satisfies Record<string, keyof PaypalRefs>;

/**
 * Finds the contract an event belongs to: by our contract id (custom_id or
 * sender_item_id) first, then by any PayPal id the contract has recorded.
 */
function findContract(keys: { contractId?: string } & Partial<Record<keyof typeof REF_COLUMN, string>>): Contract | null {
  if (keys.contractId) {
    const contract = getContract(keys.contractId);
    if (contract) return contract;
  }
  for (const [key, column] of Object.entries(REF_COLUMN) as [keyof typeof REF_COLUMN, string][]) {
    const value = keys[key];
    if (!value) continue;
    const row = getDb().prepare(`SELECT id FROM contracts WHERE ${column} = ? LIMIT 1`).get(value) as
      | { id: string }
      | undefined;
    if (row) return getContract(row.id);
  }
  return null;
}

function alreadyProcessed(eventId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT contract_id FROM events WHERE kind = 'PAYPAL_WEBHOOK' AND json_extract(detail, '$.event_id') = ? LIMIT 1`,
    )
    .get(eventId) as { contract_id: string } | undefined;
  return row?.contract_id ?? null;
}

// ---------------------------------------------------------------------------
// Reconciliation steps
// ---------------------------------------------------------------------------

function ensureLedger(contract: Contract, kind: LedgerKind, amountCents: number, ref: string, raw: unknown): string {
  // The ledger is unique on (kind, paypal_ref) across all contracts.
  const exists = getDb().prepare(`SELECT 1 FROM ledger WHERE kind = ? AND paypal_ref = ?`).get(kind, ref);
  if (exists) return `ledger ${kind} ${ref} already recorded`;
  recordLedgerEntry({ contract_id: contract.id, kind, amount_cents: amountCents, paypal_ref: ref, raw });
  return `ledger ${kind} ${ref} recorded`;
}

function ensureRef(contract: Contract, column: keyof PaypalRefs, value: string): string | null {
  if (contract[column]) return null;
  setPaypalRefs(contract.id, { [column]: value });
  return `${column} set to ${value}`;
}

/** Moves the contract to `to` if it is still in one of `from`; otherwise leaves it. */
function advance(
  contractId: string,
  from: readonly ContractState[],
  to: ContractState,
  paypal: Partial<PaypalRefs>,
  eventId: string,
): string {
  const contract = getContract(contractId)!;
  if (!from.includes(contract.state) || !canTransition(contract.state, to)) {
    return `state ${contract.state} unchanged`;
  }
  transition(contractId, to, { actor: "system", paypal, detail: { source: "paypal_webhook", event_id: eventId } });
  return `state ${contract.state} -> ${to}`;
}

type Plan = { contract: Contract; resourceId: string; apply: () => string[] } | { ignored: string };

function plan(event: WebhookEvent & { event_type: HandledEventType }): Plan {
  switch (event.event_type) {
    case "PAYMENT.AUTHORIZATION.CREATED":
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      const auth = AuthorizationResource.parse(event.resource);
      const orderId = auth.supplementary_data?.related_ids?.order_id ?? idFromLinks(auth.links, "orders");
      const contract = findContract({ contractId: auth.custom_id, authorizationId: auth.id, orderId });
      if (!contract) return { ignored: `no contract for authorization ${auth.id}` };
      const cents = fromPayPalValue(auth.amount.value, auth.amount.currency_code);
      const currency = auth.amount.currency_code;
      const held = contract.paypal_authorization_id;
      if (event.event_type === "PAYMENT.AUTHORIZATION.CREATED") {
        // Same checks as confirmFunding (service-money.ts): only the contract's
        // own order, for exactly the contract's amount, funds it.
        const mismatch =
          held !== null && held !== auth.id
            ? `contract holds authorization ${held}`
            : orderId && contract.paypal_order_id && orderId !== contract.paypal_order_id
              ? `authorization is for order ${orderId}, contract has order ${contract.paypal_order_id}`
              : cents !== contract.amount_cents || currency.toUpperCase() !== contract.currency.toUpperCase()
                ? `authorized ${cents} ${currency}, contract is ${contract.amount_cents} ${contract.currency}`
                : null;
        return {
          contract,
          resourceId: auth.id,
          apply: () => [
            ensureLedger(contract, "AUTHORIZED", cents, auth.id, event.resource),
            mismatch
              ? `state ${contract.state} unchanged: ${mismatch}`
              : advance(
                  contract.id,
                  ["SIGNED"],
                  "FUNDED",
                  { paypal_authorization_id: auth.id, ...(orderId && !contract.paypal_order_id ? { paypal_order_id: orderId } : {}) },
                  event.id,
                ),
          ],
        };
      }
      return {
        contract,
        resourceId: auth.id,
        apply: () => [
          ensureLedger(contract, "VOIDED", cents, auth.id, event.resource),
          held === auth.id
            ? advance(contract.id, ["FUNDED", "FAILED"], "EXPIRED", {}, event.id)
            : `state ${contract.state} unchanged: contract holds authorization ${held ?? "none"}`,
        ],
      };
    }

    case "PAYMENT.CAPTURE.COMPLETED": {
      const capture = CaptureResource.parse(event.resource);
      const related = capture.supplementary_data?.related_ids;
      const contract = findContract({
        contractId: capture.custom_id,
        captureId: capture.id,
        authorizationId: related?.authorization_id ?? idFromLinks(capture.links, "authorizations"),
        orderId: related?.order_id ?? idFromLinks(capture.links, "orders"),
      });
      if (!contract) return { ignored: `no contract for capture ${capture.id}` };
      const cents = fromPayPalValue(capture.amount.value, capture.amount.currency_code);
      return {
        contract,
        resourceId: capture.id,
        apply: () =>
          [
            ensureLedger(contract, "CAPTURED", cents, capture.id, event.resource),
            ensureRef(contract, "paypal_capture_id", capture.id),
          ].filter((a): a is string => a !== null),
      };
    }

    case "PAYMENT.CAPTURE.REFUNDED": {
      const refund = RefundResource.parse(event.resource);
      const contract = findContract({ contractId: refund.custom_id, captureId: idFromLinks(refund.links, "captures") });
      if (!contract) return { ignored: `no contract for refund ${refund.id}` };
      const cents = fromPayPalValue(refund.amount.value, refund.amount.currency_code);
      return {
        contract,
        resourceId: refund.id,
        apply: () => [ensureLedger(contract, "REFUNDED", cents, refund.id, event.resource)],
      };
    }

    case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED":
    case "PAYMENT.PAYOUTS-ITEM.FAILED":
    case "PAYMENT.PAYOUTS-ITEM.UNCLAIMED":
    case "PAYMENT.PAYOUTS-ITEM.RETURNED":
    case "PAYMENT.PAYOUTS-ITEM.BLOCKED": {
      const item = PayoutItemResource.parse(event.resource);
      const contract = findContract({
        contractId: item.payout_item.sender_item_id,
        payoutBatchId: item.payout_batch_id,
      });
      if (!contract) return { ignored: `no contract for payout item ${item.payout_item_id}` };
      if (event.event_type !== "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") {
        // No ledger kind or state for a payout that did not land: record it
        // on the audit trail so the contract page shows it.
        return {
          contract,
          resourceId: item.payout_item_id,
          apply: () => [
            `payout item ${item.payout_item_id} is ${item.transaction_status}: the worker has not received the money`,
          ],
        };
      }
      const { currency, value } = item.payout_item.amount;
      return {
        contract,
        resourceId: item.payout_item_id,
        apply: () =>
          [
            // PAID_OUT rows are keyed by batch id, as the contract service records them.
            ensureLedger(contract, "PAID_OUT", fromPayPalValue(value, currency), item.payout_batch_id, event.resource),
            ensureRef(contract, "paypal_payout_batch_id", item.payout_batch_id),
            advance(contract.id, ["PASSED"], "PAID", { paypal_payout_batch_id: item.payout_batch_id }, event.id),
          ].filter((a): a is string => a !== null),
      };
    }
  }
}

function isHandled(event: WebhookEvent): event is WebhookEvent & { event_type: HandledEventType } {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(event.event_type);
}

/**
 * Applies one verified webhook event. Throws (so the route answers 5xx and
 * PayPal retries) when the event or its resource does not have the expected
 * shape, or when a database write fails; nothing is half-written because
 * everything runs in one transaction.
 */
export function handlePayPalWebhookEvent(input: unknown): WebhookOutcome {
  const event = WebhookEventSchema.parse(input);
  if (!isHandled(event)) return { status: "ignored", reason: `event type ${event.event_type} is not handled` };

  return getDb()
    .transaction((): WebhookOutcome => {
      const seenFor = alreadyProcessed(event.id);
      if (seenFor) return { status: "duplicate", contractId: seenFor };

      const planned = plan(event);
      if ("ignored" in planned) return { status: "ignored", reason: planned.ignored };

      const actions = planned.apply();
      recordEvent({
        contract_id: planned.contract.id,
        kind: "PAYPAL_WEBHOOK",
        detail: {
          actor: "system",
          event_id: event.id,
          event_type: event.event_type,
          resource_id: planned.resourceId,
          summary: event.summary ?? null,
          actions,
        },
      });
      return { status: "processed", contractId: planned.contract.id, actions };
    })
    .immediate();
}
