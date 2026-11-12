/** Test helpers: a fresh temp SQLite file per test, and contract fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { closeDb } from "@/lib/db";
import { createContract } from "@/lib/db/contracts";
import { createSubmission } from "@/lib/db/submissions";
import { signOff, transition } from "@/lib/contract/machine";
import type { Contract, ContractState, NewContractInput } from "@/lib/types";

/** Points CLAUSE_DB_PATH at a new temp file (in a not-yet-existing subdirectory) for each test. */
export function withTempDb(): { path: () => string } {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clause-test-"));
    file = path.join(dir, "nested", "clause.db");
    process.env.CLAUSE_DB_PATH = file;
  });
  afterEach(() => {
    closeDb();
    delete process.env.CLAUSE_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { path: () => file };
}

export function websiteContractInput(overrides: Partial<NewContractInput> = {}): NewContractInput {
  return {
    title: "Landing page",
    type: "website_milestone",
    payer_email: "payer@example.com",
    worker_email: "worker@example.com",
    amount_cents: 20000,
    deadline_at: "2026-11-14T00:00:00.000Z",
    conditions: [
      { text: "Loads at a public URL", check_kind: "http_ok", check_params: {} },
      { text: "Has a contact form", check_kind: "dom_assert", check_params: { selector: "form" } },
    ],
    ...overrides,
  };
}

export function makeContract(overrides: Partial<NewContractInput> = {}): Contract {
  return createContract(websiteContractInput(overrides));
}

/** The legal path from DRAFT to each state. */
const PATH_TO: Record<ContractState, ContractState[]> = {
  DRAFT: [],
  SIGNED: ["SIGNED"],
  FUNDED: ["SIGNED", "FUNDED"],
  SUBMITTED: ["SIGNED", "FUNDED", "SUBMITTED"],
  VERIFYING: ["SIGNED", "FUNDED", "SUBMITTED", "VERIFYING"],
  PASSED: ["SIGNED", "FUNDED", "SUBMITTED", "VERIFYING", "PASSED"],
  FAILED: ["SIGNED", "FUNDED", "SUBMITTED", "VERIFYING", "FAILED"],
  PAID: ["SIGNED", "FUNDED", "SUBMITTED", "VERIFYING", "PASSED", "PAID"],
  EXPIRED: ["SIGNED", "FUNDED", "EXPIRED"],
  DISPUTED: ["SIGNED", "FUNDED", "DISPUTED"],
  SETTLED: ["SIGNED", "FUNDED", "DISPUTED", "SETTLED"],
  ESCALATED: ["SIGNED", "FUNDED", "DISPUTED", "ESCALATED"],
};

/**
 * Performs one legal step, supplying what each guard needs: both sign-offs
 * for SIGNED, an authorization for FUNDED, a submission for SUBMITTED, a
 * payout for PAID.
 */
export function step(contractId: string, to: ContractState): Contract {
  switch (to) {
    case "SIGNED":
      signOff(contractId, "payer");
      return signOff(contractId, "worker");
    case "FUNDED":
      return transition(contractId, "FUNDED", {
        actor: "payer",
        paypal: { paypal_order_id: "ORDER-1", paypal_authorization_id: "AUTH-1" },
      });
    case "SUBMITTED":
      createSubmission({ contract_id: contractId, url: "https://example.com/" });
      return transition(contractId, "SUBMITTED", { actor: "worker" });
    case "PAID":
      return transition(contractId, "PAID", {
        actor: "system",
        paypal: { paypal_capture_id: "CAP-1", paypal_payout_batch_id: "BATCH-1" },
      });
    default:
      return transition(contractId, to, { actor: "system" });
  }
}

/** A new contract driven along the legal path to `state`. */
export function contractIn(state: ContractState, overrides: Partial<NewContractInput> = {}): Contract {
  let contract = makeContract(overrides);
  for (const to of PATH_TO[state]) contract = step(contract.id, to);
  return contract;
}
