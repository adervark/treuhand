/**
 * Test kit for the contract service tests (not a test file itself). The
 * tests mock `@/lib/paypal`, `@/lib/verifier`, `@/lib/ai/mediator` and
 * `@/lib/ai/drafter` at the module boundary with `vi.mock`; these helpers give
 * the mocks realistic behaviour and drive contracts through the service.
 */
import { vi } from "vitest";
import * as paypal from "@/lib/paypal";
import * as verifier from "@/lib/verifier";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { upsertIdentity } from "@/lib/db/identities";
import { getSubmission } from "@/lib/db/submissions";
import { createVerdict } from "@/lib/db/verdicts";
import type { ConditionInput, Contract, ContractType } from "@/lib/types";
import { confirmFunding, createFromProposal, createFundingOrder, signContract, submitWork } from "./service";

export const PAYER_EMAIL = "payer@example.com";
export const WORKER_EMAIL = "worker@example.com";

export function seedIdentities(): void {
  upsertIdentity({ role: "payer", display_name: "Payer", email: PAYER_EMAIL });
  upsertIdentity({ role: "worker", display_name: "Worker", email: WORKER_EMAIL });
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export const CONDITIONS: Record<ContractType, ConditionInput[]> = {
  website_milestone: [
    { text: "Loads at a public URL", check_kind: "http_ok", check_params: {} },
    { text: "Has a contact form", check_kind: "dom_assert", check_params: { selector: "form" } },
  ],
  code_bounty: [
    { text: "The PR is merged", check_kind: "github_pr_merged", check_params: { repo: "acme/app" } },
    { text: "CI is green", check_kind: "github_checks_passed", check_params: { repo: "acme/app" } },
  ],
};

export function newContract(type: ContractType = "website_milestone", amountCents = 20000): Contract {
  return createFromProposal("payer", {
    title: `${type} contract`,
    type,
    amount_cents: amountCents,
    currency: "USD",
    deadline_at: daysFromNow(3),
    conditions: CONDITIONS[type],
    notes: [],
  });
}

/** Payout batch id -> amount sent, so the fake batch reports what was paid. */
const payoutAmounts = new Map<string, number>();

/** What the fake payout batch reports for its item; tests change it to simulate PENDING, UNCLAIMED, ... */
export const payoutItemStatus = { value: "SUCCESS" as string | null };

/** Per-batch overrides of `payoutItemStatus`; "DENIED" and "CANCELED" are reported as the batch's status. */
export const payoutStatusByBatch = new Map<string, string>();

/** Fake PayPal: every call succeeds with ids derived from its input, like the idempotent real API. */
export function installPayPalFakes(): void {
  for (const fn of [
    paypal.createAuthorizedOrder,
    paypal.authorizeOrder,
    paypal.captureAuthorization,
    paypal.voidAuthorization,
    paypal.refundCapture,
    paypal.payout,
    paypal.getPayoutBatch,
  ]) {
    vi.mocked(fn).mockReset();
  }
  payoutAmounts.clear();
  payoutItemStatus.value = "SUCCESS";
  payoutStatusByBatch.clear();
  vi.mocked(paypal.createAuthorizedOrder).mockImplementation(async (input) => ({
    orderId: `ORDER-${input.contractId}`,
    status: "CREATED",
    raw: {},
  }));
  vi.mocked(paypal.authorizeOrder).mockImplementation(async (orderId) => {
    const contractId = orderId.replace(/^ORDER-/, "");
    const contract = getContract(contractId)!;
    return {
      orderId,
      authorizationId: `AUTH-${contractId}`,
      status: "CREATED",
      amountCents: contract.amount_cents,
      currency: contract.currency,
      expiresAt: null,
      raw: { id: orderId, purchase_units: [{ reference_id: contractId, custom_id: contractId }] },
    };
  });
  vi.mocked(paypal.captureAuthorization).mockImplementation(async (input) => ({
    captureId: `CAP-${input.authorizationId}`,
    status: "COMPLETED",
    amountCents: input.amountCents!,
    currency: input.currency,
    raw: {},
  }));
  vi.mocked(paypal.voidAuthorization).mockImplementation(async (authorizationId) => ({
    authorizationId,
    status: "VOIDED",
    raw: null,
  }));
  vi.mocked(paypal.refundCapture).mockImplementation(async (input) => ({
    refundId: `REF-${input.captureId}${input.reason ? `-${input.reason}` : ""}`,
    status: "COMPLETED",
    amountCents: input.amountCents,
    raw: {},
  }));
  vi.mocked(paypal.payout).mockImplementation(async (input) => {
    // Like PayPal: a new attempt (new sender_batch_id) is a new batch.
    const payoutBatchId = `BATCH-${input.contractId}${(input.attempt ?? 1) > 1 ? `-${input.attempt}` : ""}`;
    payoutAmounts.set(payoutBatchId, input.amountCents);
    return { payoutBatchId, batchStatus: "PENDING", raw: {} };
  });
  vi.mocked(paypal.getPayoutBatch).mockImplementation(async (payoutBatchId) => {
    const status = payoutStatusByBatch.get(payoutBatchId) ?? payoutItemStatus.value;
    if (status === "DENIED" || status === "CANCELED") return { payoutBatchId, batchStatus: status, items: [], raw: {} };
    return {
      payoutBatchId,
      batchStatus: status === "SUCCESS" ? "SUCCESS" : "PENDING",
      items: [
        {
          payoutItemId: `ITEM-${payoutBatchId}`,
          payoutBatchId,
          transactionStatus: status,
          amountCents: payoutAmounts.get(payoutBatchId) ?? 0,
          currency: "USD",
          receiver: WORKER_EMAIL,
          senderItemId: null,
          errors: null,
          raw: { transaction_status: status },
        },
      ],
      raw: {},
    };
  });
}

export type FakeOutcome = "passed" | "failed" | "inconclusive";

/** The fake verifier stores one verdict per condition and answers `outcome`. */
export function verifierAnswers(outcome: FakeOutcome): void {
  vi.mocked(verifier.verifySubmission).mockImplementation(async (submissionId) => {
    const submission = getSubmission(submissionId)!;
    const conditions = listConditions(submission.contract_id);
    const verdicts = conditions.map((condition, i) =>
      createVerdict({
        submission_id: submissionId,
        condition_id: condition.id,
        passed: outcome === "passed" || (outcome === "failed" && i > 0),
        confidence: outcome === "inconclusive" && i === 0 ? 0 : 1,
        reasoning: `${outcome} check ${i}`,
        evidence: {},
      }),
    );
    return {
      contractId: submission.contract_id,
      submissionId,
      verdicts,
      allPassed: outcome === "passed",
      outcome,
      inconclusive:
        outcome === "inconclusive" ? [{ condition_id: conditions[0].id, reason: "The site did not respond." }] : [],
    };
  });
}

/** Signs as both parties (if still DRAFT) and funds through the service. */
export async function fund(contractId: string): Promise<Contract> {
  if (getContract(contractId)!.state === "DRAFT") {
    signContract(contractId, "payer");
    signContract(contractId, "worker");
  }
  const orderId = await createFundingOrder(contractId, "payer");
  return confirmFunding(contractId, "payer", orderId);
}

/** Submits work as the worker and runs the verification job to the end. */
export async function submitAndVerify(contractId: string, outcome: FakeOutcome, url = "https://example.com/"): Promise<Contract> {
  verifierAnswers(outcome);
  const job = submitWork(contractId, "worker", url);
  await job.run();
  return getContract(contractId)!;
}
