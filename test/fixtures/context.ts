/** Builds a CheckContext for running one verifier check outside the database (tests and the eval script). */
import { CheckParamsSchemas, type CheckKind, type CheckParams, type Condition, type Contract } from "@/lib/types";
import type { CheckContext } from "@/lib/verifier";

let counter = 0;

export function checkContext<K extends CheckKind>(
  kind: K,
  params: Partial<CheckParams<K>> & Record<string, unknown>,
  submissionUrl: string,
): CheckContext<K> {
  counter += 1;
  const parsed = CheckParamsSchemas[kind].parse(params) as CheckParams<K>;
  const now = new Date().toISOString();
  const contract: Contract = {
    id: `contract-${counter}`,
    title: "Fixture contract",
    type: kind.startsWith("github_") ? "code_bounty" : "website_milestone",
    payer_email: "payer@example.com",
    worker_email: "worker@example.com",
    amount_cents: 10_000,
    currency: "USD",
    deadline_at: "2030-01-01T00:00:00.000Z",
    state: "VERIFYING",
    payer_signed_at: now,
    worker_signed_at: now,
    paypal_order_id: null,
    paypal_authorization_id: null,
    paypal_capture_id: null,
    paypal_payout_batch_id: null,
    created_at: now,
    updated_at: now,
  };
  const condition = {
    id: `condition-${counter}`,
    contract_id: contract.id,
    position: 0,
    text: `Fixture ${kind} condition`,
    check_kind: kind,
    check_params: parsed,
  } as unknown as Condition & { check_kind: K };
  return {
    contract,
    condition,
    submission: { id: `submission-${counter}`, contract_id: contract.id, url: submissionUrl, created_at: now },
    params: parsed,
  };
}
