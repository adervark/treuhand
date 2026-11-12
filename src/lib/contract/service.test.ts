/**
 * The contract service against a temp database, with PayPal, the verifier and
 * the AI roles mocked at the module boundary (fakes in service-testkit.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as drafter from "@/lib/ai/drafter";
import * as mediator from "@/lib/ai/mediator";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { getActiveDispute } from "@/lib/db/disputes";
import { getDb } from "@/lib/db/index";
import { listEvents } from "@/lib/db/events";
import { listLedgerEntries } from "@/lib/db/ledger";
import { createVerdict } from "@/lib/db/verdicts";
import { handlePayPalWebhookEvent } from "@/lib/paypal/webhook";
import * as paypal from "@/lib/paypal";
import * as verifier from "@/lib/verifier";
import type { Contract, ContractState, Party } from "@/lib/types";
import { withTempDb } from "@/test/helpers";
import { acquireClaim, liveClaim } from "./service-claims";
import {
  answerProposal,
  confirmFunding,
  createFromProposal,
  createFundingOrder,
  draftFromPrompt,
  editContractConditions,
  expireContract,
  getContractDetail,
  openDispute,
  rerunVerification,
  respondToDispute,
  runSweep,
  ServiceError,
  settlePass,
  settleSplit,
  signContract,
  submitWork,
} from "./service";
import {
  CONDITIONS,
  daysFromNow,
  fund,
  installPayPalFakes,
  newContract,
  payoutItemStatus,
  payoutStatusByBatch,
  seedIdentities,
  submitAndVerify,
  verifierAnswers,
} from "./service-testkit";

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
vi.mock("@/lib/ai/mediator", () => ({ proposeSplit: vi.fn() }));
vi.mock("@/lib/ai/drafter", () => ({ draftContract: vi.fn() }));

withTempDb();

beforeEach(() => {
  vi.resetAllMocks();
  seedIdentities();
  installPayPalFakes();
  vi.mocked(mediator.proposeSplit).mockResolvedValue({ proposed_worker_cents: 12000, reasoning: "Most of it works." });
});

const calls = (fn: (...args: never[]) => unknown) => vi.mocked(fn).mock.calls.length;
const ledgerKinds = (contractId: string) => listLedgerEntries({ contract_id: contractId }).map((e) => e.kind);
const eventKinds = (contractId: string) => listEvents(contractId).map((e) => e.kind);
const stateOf = (contractId: string): ContractState => getContract(contractId)!.state;

/** Asserts `promise` rejects with a ServiceError (or machine error) carrying `code`. */
async function expectCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  const run = typeof promise === "function" ? Promise.resolve().then(promise) : promise;
  await expect(run).rejects.toMatchObject({ code });
}

function payoutFails(): void {
  vi.mocked(paypal.payout).mockRejectedValue(
    new paypal.PayPalError({
      operation: "POST /v1/payments/payouts",
      status: 403,
      paypalName: "PAYOUT_NOT_AVAILABLE",
      paypalMessage: "Payouts are not available for this account",
      debugId: "dbg1",
    }),
  );
}

/** Moves the deadline into the past without moving the clock (claims and timestamps stay real). */
function deadlinePassed(contractId: string): void {
  getDb()
    .prepare(`UPDATE contracts SET deadline_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), contractId);
}

/** The claim column as stored, read inside a PayPal mock to prove the claim was taken first. */
const storedClaim = (contractId: string) =>
  (getDb().prepare(`SELECT claim_action FROM contracts WHERE id = ?`).get(contractId) as { claim_action: string | null })
    .claim_action;

async function passed(type: Contract["type"] = "website_milestone"): Promise<Contract> {
  const contract = newContract(type);
  await fund(contract.id);
  vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "3600"); // keep it PASSED: settle explicitly
  await submitAndVerify(contract.id, "passed");
  vi.unstubAllEnvs();
  expect(stateOf(contract.id)).toBe("PASSED");
  return getContract(contract.id)!;
}

async function disputedWithProposal(workerCents = 12000): Promise<Contract> {
  const contract = newContract();
  await fund(contract.id);
  await submitAndVerify(contract.id, "failed");
  openDispute(contract.id, "worker", "The form works; your checker is wrong.");
  vi.mocked(mediator.proposeSplit).mockResolvedValue({ proposed_worker_cents: workerCents, reasoning: "Split." });
  await respondToDispute(contract.id, "payer", "The form does not submit.");
  return getContract(contract.id)!;
}

// ---------------------------------------------------------------------------

describe("happy path", () => {
  it.each(["website_milestone", "code_bounty"] as const)("%s: draft -> create -> sign -> fund -> submit -> PAID", async (type) => {
    vi.mocked(drafter.draftContract).mockResolvedValue({
      kind: "draft",
      contract: {
        title: "Job",
        type,
        amount_cents: 20000,
        currency: "USD",
        deadline_at: daysFromNow(3),
        conditions: CONDITIONS[type],
        notes: ["Read 'works' as 'returns 200'."],
      },
    });
    const draft = await draftFromPrompt("payer", "Pay 200 dollars for a page", type);
    expect(vi.mocked(drafter.draftContract).mock.calls[0][0]).toMatchObject({
      payerEmail: "payer@example.com",
      workerEmail: "worker@example.com",
      type,
    });
    if (draft.kind !== "draft") throw new Error("expected a draft");
    const { amount_cents, currency, deadline_at, ...rest } = draft.contract;
    const created = createFromProposal("payer", {
      ...rest,
      amount_cents: amount_cents!,
      currency: currency!,
      deadline_at: deadline_at!,
    });
    expect(created).toMatchObject({ state: "DRAFT", payer_email: "payer@example.com", worker_email: "worker@example.com" });
    expect(getContractDetail(created.id, "payer").notes).toEqual(["Read 'works' as 'returns 200'."]);

    expect(signContract(created.id, "payer").state).toBe("DRAFT");
    expect(signContract(created.id, "worker").state).toBe("SIGNED");

    const orderId = await createFundingOrder(created.id, "payer");
    expect(vi.mocked(paypal.createAuthorizedOrder).mock.calls[0][0]).toMatchObject({
      contractId: created.id,
      amountCents: 20000,
      currency: "USD",
    });
    const funded = await confirmFunding(created.id, "payer", orderId);
    expect(funded).toMatchObject({ state: "FUNDED", paypal_order_id: orderId, paypal_authorization_id: `AUTH-${created.id}` });

    const after = await submitAndVerify(created.id, "passed");
    expect(after.state).toBe("PAID");
    expect(after.paypal_capture_id).toBe(`CAP-AUTH-${created.id}`);
    expect(after.paypal_payout_batch_id).toBe(`BATCH-${created.id}`);
    expect(ledgerKinds(created.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    expect(listLedgerEntries({ contract_id: created.id }).map((e) => e.amount_cents)).toEqual([20000, 20000, 20000]);
    expect(eventKinds(created.id)).toEqual(
      expect.arrayContaining(["ORDER_CREATED", "FUNDS_AUTHORIZED", "SUBMISSION_RECEIVED", "VERIFICATION_COMPLETED", "FUNDS_CAPTURED", "PAYOUT_SENT", "PAYOUT_STATUS"]),
    );
    const detail = getContractDetail(created.id, "worker");
    expect(detail.verification).toMatchObject({ status: "passed" });
    expect(detail.payout).toMatchObject({ status: "SUCCESS", amount_cents: 20000 });
    expect(detail.allowed_actions).toEqual([]);
    expect(liveClaim(created.id)).toBeNull();
  });

  it("fail, resubmit, pass", async () => {
    const contract = newContract();
    await fund(contract.id);
    expect((await submitAndVerify(contract.id, "failed")).state).toBe("FAILED");
    expect(getContractDetail(contract.id, "worker").allowed_actions).toContain("submit");
    expect(getContractDetail(contract.id, "worker").verification).toMatchObject({ status: "failed" });
    expect((await submitAndVerify(contract.id, "passed", "https://example.com/v2")).state).toBe("PAID");
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(calls(paypal.payout)).toBe(1);
  });

  it("leaves a PASSED contract to the sweep when the contest window is open", async () => {
    const contract = await passed();
    expect(calls(paypal.captureAuthorization)).toBe(0);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "60");
    await expectCode(settlePass(contract.id), "ILLEGAL_TRANSITION");
    expect((await runSweep()).settled).toEqual([]);
    const swept = await runSweep(new Date(Date.now() + 61_000));
    vi.unstubAllEnvs();
    expect(swept.settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("PAID");
  });
});

// ---------------------------------------------------------------------------

describe("expiry", () => {
  it.each(["FUNDED", "FAILED"] as const)("voids the hold of a %s contract past its deadline", async (state) => {
    const contract = newContract();
    await fund(contract.id);
    if (state === "FAILED") await submitAndVerify(contract.id, "failed");
    const afterDeadline = new Date(Date.parse(contract.deadline_at) + 1000);

    expect((await runSweep(new Date(Date.parse(contract.deadline_at) - 1000))).expired).toEqual([]);
    const swept = await runSweep(afterDeadline);

    expect(swept.expired.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("EXPIRED");
    expect(vi.mocked(paypal.voidAuthorization).mock.calls).toEqual([[`AUTH-${contract.id}`]]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(calls(paypal.captureAuthorization)).toBe(0);
  });

  it("does not expire before the deadline, or a contract that is not FUNDED/FAILED", async () => {
    const contract = newContract();
    await fund(contract.id);
    await expectCode(expireContract(contract.id), "ILLEGAL_TRANSITION");
    const draft = newContract();
    await expectCode(expireContract(draft.id, new Date(Date.parse(draft.deadline_at) + 1000)), "ILLEGAL_TRANSITION");
    expect(calls(paypal.voidAuthorization)).toBe(0);
  });

  it("treats an authorization PayPal already expired as released", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.mocked(paypal.voidAuthorization).mockRejectedValue(
      new paypal.PayPalError({
        operation: "void",
        status: 422,
        paypalName: "UNPROCESSABLE_ENTITY",
        paypalMessage: "expired",
        debugId: null,
        details: [{ issue: "AUTHORIZATION_EXPIRED" }],
      }),
    );
    const expired = await expireContract(contract.id, new Date(Date.parse(contract.deadline_at) + 1000));
    expect(expired.state).toBe("EXPIRED");
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
  });
});

// ---------------------------------------------------------------------------

describe("disputes", () => {
  it("open -> both argue -> mediator proposes -> both accept -> split settled", async () => {
    const contract = newContract();
    await fund(contract.id);
    await submitAndVerify(contract.id, "failed");

    const opened = openDispute(contract.id, "worker", "It works.");
    expect(opened).toMatchObject({ state: "OPEN", opened_by: "worker", worker_argument: "It works." });
    expect(stateOf(contract.id)).toBe("DISPUTED");
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["respond"]);

    const proposed = await respondToDispute(contract.id, "payer", "It does not.");
    expect(proposed).toMatchObject({ state: "PROPOSED", proposed_worker_cents: 12000, proposal_reasoning: "Most of it works." });
    expect(vi.mocked(mediator.proposeSplit).mock.calls[0][0]).toMatchObject({
      payerArgument: "It does not.",
      workerArgument: "It works.",
    });
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["accept", "decline"]);

    const first = await answerProposal(contract.id, "payer", true);
    expect(first.dispute.payer_accepted).toBe(true);
    expect(first.contract.state).toBe("DISPUTED");
    expect(calls(paypal.captureAuthorization)).toBe(0);

    const second = await answerProposal(contract.id, "worker", true);
    expect(second.contract.state).toBe("SETTLED");
    expect(second.dispute.state).toBe("SETTLED");
    expect(vi.mocked(paypal.captureAuthorization).mock.calls[0][0]).toMatchObject({ amountCents: 20000 });
    expect(vi.mocked(paypal.refundCapture).mock.calls[0][0]).toMatchObject({ amountCents: 8000 });
    expect(vi.mocked(paypal.payout).mock.calls[0][0]).toMatchObject({ amountCents: 12000, receiverEmail: "worker@example.com" });
    const ledger = listLedgerEntries({ contract_id: contract.id });
    expect(ledger.map((e) => [e.kind, e.amount_cents])).toEqual([
      ["AUTHORIZED", 20000],
      ["CAPTURED", 20000],
      ["REFUNDED", 8000],
      ["PAID_OUT", 12000],
    ]);
  });

  it("voids the hold for a 0 worker share and skips the refund for a full one", async () => {
    const zero = await disputedWithProposal(0);
    await answerProposal(zero.id, "payer", true);
    expect((await answerProposal(zero.id, "worker", true)).contract.state).toBe("SETTLED");
    expect(ledgerKinds(zero.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(calls(paypal.captureAuthorization)).toBe(0);

    const full = await disputedWithProposal(20000);
    await answerProposal(full.id, "payer", true);
    expect((await answerProposal(full.id, "worker", true)).contract.state).toBe("SETTLED");
    expect(ledgerKinds(full.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    expect(calls(paypal.refundCapture)).toBe(0);
  });

  it("escalates when a party declines, and moves no money", async () => {
    const contract = await disputedWithProposal();
    await answerProposal(contract.id, "payer", true);
    const declined = await answerProposal(contract.id, "worker", false);
    expect(declined.dispute).toMatchObject({ state: "ESCALATED", worker_accepted: false });
    expect(declined.contract.state).toBe("ESCALATED");
    expect(eventKinds(contract.id)).toContain("DISPUTE_DECLINED");
    expect(calls(paypal.captureAuthorization) + calls(paypal.voidAuthorization)).toBe(0);
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual([]);
  });

  it("keeps the argument when the mediator fails, and retries on the next respond", async () => {
    const contract = newContract();
    await fund(contract.id);
    openDispute(contract.id, "payer", "Nothing was delivered.");
    vi.mocked(mediator.proposeSplit).mockRejectedValueOnce(new Error("model timed out"));
    await expectCode(respondToDispute(contract.id, "worker", "I delivered."), "AI_ERROR");
    expect(getActiveDispute(contract.id)).toMatchObject({ state: "OPEN", worker_argument: "I delivered." });
    expect(getContractDetail(contract.id, "worker").activity.last_failure).toMatchObject({ action: "mediate" });
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual(["respond"]);
    expect((await respondToDispute(contract.id, "worker", "I delivered.")).state).toBe("PROPOSED");
  });

  it("refuses a proposal outside 0..amount", async () => {
    const contract = newContract();
    await fund(contract.id);
    openDispute(contract.id, "payer", "a");
    vi.mocked(mediator.proposeSplit).mockResolvedValueOnce({ proposed_worker_cents: 30000, reasoning: "too much" });
    await expectCode(respondToDispute(contract.id, "worker", "b"), "AI_ERROR");
    expect(getActiveDispute(contract.id)!.state).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------

describe("who may do what", () => {
  const as = async (party: Party, fn: (party: Party) => unknown) => Promise.resolve().then(() => fn(party));

  it("only the payer drafts, creates and funds", async () => {
    await expectCode(as("worker", (p) => draftFromPrompt(p, "deal")), "FORBIDDEN");
    await expectCode(
      as("worker", (p) =>
        createFromProposal(p, {
          title: "t",
          type: "website_milestone",
          amount_cents: 100,
          currency: "USD",
          deadline_at: daysFromNow(1),
          conditions: CONDITIONS.website_milestone,
          notes: [],
        }),
      ),
      "FORBIDDEN",
    );
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    await expectCode(createFundingOrder(contract.id, "worker"), "FORBIDDEN");
    const orderId = await createFundingOrder(contract.id, "payer");
    await expectCode(confirmFunding(contract.id, "worker", orderId), "FORBIDDEN");
    expect(calls(paypal.authorizeOrder)).toBe(0);
  });

  it("only the worker submits, and only FUNDED/FAILED before the deadline", async () => {
    const contract = newContract();
    expect(() => submitWork(contract.id, "worker", "https://x.test/")).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION" }));
    await fund(contract.id);
    expect(() => submitWork(contract.id, "payer", "https://x.test/")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    const late = new Date(Date.parse(contract.deadline_at) + 1);
    expect(() => submitWork(contract.id, "worker", "https://x.test/", late)).toThrow(
      expect.objectContaining({ code: "DEADLINE_PASSED" }),
    );
    expect(liveClaim(contract.id)).toBeNull();
    expect(stateOf(contract.id)).toBe("FUNDED");
  });

  it("refuses funding unless SIGNED, before the deadline", async () => {
    const contract = newContract();
    await expectCode(createFundingOrder(contract.id, "payer"), "ILLEGAL_TRANSITION");
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    await expectCode(
      createFundingOrder(contract.id, "payer", new Date(Date.parse(contract.deadline_at) + 1)),
      "DEADLINE_PASSED",
    );
    expect(calls(paypal.createAuthorizedOrder)).toBe(0);
  });

  it("refuses an order not created for this contract", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    await expectCode(confirmFunding(contract.id, "payer", "ORDER-someone-else"), "ORDER_MISMATCH");
    await createFundingOrder(contract.id, "payer");
    await expectCode(confirmFunding(contract.id, "payer", "ORDER-someone-else"), "ORDER_MISMATCH");
    expect(calls(paypal.authorizeOrder)).toBe(0);
  });

  it("voids and refuses a hold whose amount differs from the contract", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const orderId = await createFundingOrder(contract.id, "payer");
    vi.mocked(paypal.authorizeOrder).mockResolvedValueOnce({
      orderId,
      authorizationId: "AUTH-SHORT",
      status: "CREATED",
      amountCents: 100,
      currency: "USD",
      expiresAt: null,
      raw: { purchase_units: [{ reference_id: contract.id }] },
    });
    await expectCode(confirmFunding(contract.id, "payer", orderId), "ORDER_MISMATCH");
    expect(stateOf(contract.id)).toBe("SIGNED");
    expect(vi.mocked(paypal.voidAuthorization).mock.calls).toEqual([["AUTH-SHORT"]]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(getContractDetail(contract.id, "payer").activity.last_failure).toBeNull(); // the void is progress
    expect(eventKinds(contract.id)).toContain("ACTION_FAILED");
  });

  it("refuses a hold on an order tagged for another contract", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const orderId = await createFundingOrder(contract.id, "payer");
    vi.mocked(paypal.authorizeOrder).mockResolvedValueOnce({
      orderId,
      authorizationId: "AUTH-OTHER",
      status: "CREATED",
      amountCents: contract.amount_cents,
      currency: "USD",
      expiresAt: null,
      raw: { purchase_units: [{ reference_id: "another-contract", custom_id: "another-contract" }] },
    });
    await expectCode(confirmFunding(contract.id, "payer", orderId), "ORDER_MISMATCH");
    expect(stateOf(contract.id)).toBe("SIGNED");
  });

  it("locks conditions after signing and clears sign-offs on an edit", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    const edited = editContractConditions(contract.id, "worker", [CONDITIONS.website_milestone[0]]);
    expect(edited.contract.payer_signed_at).toBeNull();
    expect(edited.conditions).toHaveLength(1);
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    expect(() => editContractConditions(contract.id, "payer", CONDITIONS.website_milestone)).toThrow(
      expect.objectContaining({ code: "CONTRACT_LOCKED" }),
    );
    expect(() => signContract(contract.id, "payer")).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION" }));
    expect(() => editContractConditions(contract.id, "payer", CONDITIONS.code_bounty)).toThrow(
      expect.objectContaining({ code: "CONTRACT_LOCKED" }),
    );
  });

  it("rejects conditions of the wrong kind for the contract type", () => {
    const contract = newContract("website_milestone");
    expect(() => editContractConditions(contract.id, "payer", CONDITIONS.code_bounty)).toThrow(
      expect.objectContaining({ code: "INVALID_CONDITION" }),
    );
  });

  it("refuses a deadline in the past and missing identities", async () => {
    const proposal = {
      title: "t",
      type: "website_milestone" as const,
      amount_cents: 100,
      currency: "USD",
      deadline_at: "2020-01-01T00:00:00.000Z",
      conditions: CONDITIONS.website_milestone,
      notes: [],
    };
    expect(() => createFromProposal("payer", proposal)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    getDb().prepare(`DELETE FROM identities`).run();
    expect(() => createFromProposal("payer", { ...proposal, deadline_at: daysFromNow(1) })).toThrow(
      expect.objectContaining({ code: "IDENTITIES_MISSING" }),
    );
    await expectCode(draftFromPrompt("payer", "deal"), "IDENTITIES_MISSING");
  });

  it("allows disputes only from FUNDED, FAILED or PASSED and before any capture", async () => {
    const contract = newContract();
    expect(() => openDispute(contract.id, "payer", "x")).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION" }));
    const capturedOnly = await passed();
    payoutFails();
    await expectCode(settlePass(capturedOnly.id), "PAYPAL_ERROR");
    expect(() => openDispute(capturedOnly.id, "payer", "x")).toThrow(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION", message: expect.stringContaining("payout has already started") }),
    );
    const verifying = newContract();
    await fund(verifying.id);
    submitWork(verifying.id, "worker", "https://example.com/"); // run in progress
    expect(() => openDispute(verifying.id, "worker", "x")).toThrow(expect.objectContaining({ code: "BUSY" }));
  });

  it("answers DISPUTE_STATE / NOT_FOUND for out-of-order dispute actions", async () => {
    const contract = newContract();
    await fund(contract.id);
    await expectCode(respondToDispute(contract.id, "payer", "x"), "NOT_FOUND");
    await expectCode(answerProposal(contract.id, "payer", true), "NOT_FOUND");
    openDispute(contract.id, "payer", "x");
    await expectCode(answerProposal(contract.id, "worker", true), "DISPUTE_STATE");
    await expectCode(answerProposal(contract.id, "worker", false), "DISPUTE_STATE");
    await respondToDispute(contract.id, "worker", "y");
    await expectCode(respondToDispute(contract.id, "worker", "z"), "DISPUTE_STATE");
    await answerProposal(contract.id, "payer", true);
    await expectCode(answerProposal(contract.id, "payer", false), "DISPUTE_STATE");
  });

  it("derives allowed_actions per party from the same rules", async () => {
    const contract = newContract();
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["edit_conditions", "sign"]);
    signContract(contract.id, "payer");
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["edit_conditions"]);
    signContract(contract.id, "worker");
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["fund"]);
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual([]);
    await fund(contract.id);
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual(["dispute"]);
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual(["submit", "dispute"]);
  });
});

// ---------------------------------------------------------------------------

describe("no double settlement", () => {
  it("two concurrent settlePass calls capture and pay out once", async () => {
    const contract = await passed();
    const results = await Promise.allSettled([settlePass(contract.id), settlePass(contract.id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "BUSY" });
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(calls(paypal.payout)).toBe(1);
    expect(stateOf(contract.id)).toBe("PAID");
  });

  it("a sweep racing settlePass skips the busy contract", async () => {
    const contract = await passed();
    const [settled, swept] = await Promise.all([settlePass(contract.id), runSweep()]);
    expect(settled.state).toBe("PAID");
    expect(swept.errors).toEqual([]);
    expect(calls(paypal.captureAuthorization)).toBe(1);
  });

  it("settling again after PAID moves no money", async () => {
    const contract = await passed();
    await settlePass(contract.id);
    await expectCode(settlePass(contract.id), "ILLEGAL_TRANSITION");
    await runSweep();
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(calls(paypal.payout)).toBe(1);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
  });

  it("two concurrent expiries void once", async () => {
    const contract = newContract();
    await fund(contract.id);
    const late = new Date(Date.parse(contract.deadline_at) + 1000);
    const results = await Promise.allSettled([expireContract(contract.id, late), runSweep(late)]);
    expect(results[0].status).toBe("fulfilled");
    expect(calls(paypal.voidAuthorization)).toBe(1);
    await expectCode(expireContract(contract.id, late), "ILLEGAL_TRANSITION");
    expect(calls(paypal.voidAuthorization)).toBe(1);
  });

  it("concurrent acceptances and a sweep settle a split once", async () => {
    const contract = await disputedWithProposal();
    await answerProposal(contract.id, "payer", true);
    const results = await Promise.allSettled([
      answerProposal(contract.id, "worker", true),
      settleSplit(contract.id, "system"),
      runSweep(),
    ]);
    expect(results.every((r) => r.status === "fulfilled" || (r.reason as ServiceError).code === "BUSY")).toBe(true);
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(calls(paypal.refundCapture)).toBe(1);
    expect(calls(paypal.payout)).toBe(1);
    expect(stateOf(contract.id)).toBe("SETTLED");
    await runSweep();
    await expectCode(settleSplit(contract.id, "system"), "ILLEGAL_TRANSITION");
    expect(calls(paypal.captureAuthorization)).toBe(1);
  });

  it("a second create-order while one is running is BUSY", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const results = await Promise.allSettled([createFundingOrder(contract.id, "payer"), createFundingOrder(contract.id, "payer")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(calls(paypal.createAuthorizedOrder)).toBe(1);
  });

  it("a repeated authorize after success returns the contract without calling PayPal", async () => {
    const contract = newContract();
    await fund(contract.id);
    const again = await confirmFunding(contract.id, "payer", `ORDER-${contract.id}`);
    expect(again.state).toBe("FUNDED");
    expect(calls(paypal.authorizeOrder)).toBe(1);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED"]);
  });
});

// ---------------------------------------------------------------------------

describe("partial failure", () => {
  it("payout fails after capture: stays PASSED, retry pays out without capturing again", async () => {
    const contract = await passed();
    payoutFails();
    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    const after = getContract(contract.id)!;
    expect(after.state).toBe("PASSED");
    expect(after.paypal_capture_id).toBe(`CAP-AUTH-${contract.id}`);
    expect(after.paypal_payout_batch_id).toBeNull();
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED"]);
    const detail = getContractDetail(contract.id, "payer");
    expect(detail.activity.last_failure).toMatchObject({ action: "settle_pass", step: "payout" });
    expect(detail.allowed_actions).toEqual([]); // no dispute once captured

    // The sweep retries; an identical failure is not written twice.
    const swept = await runSweep();
    expect(swept.errors).toMatchObject([{ contract_id: contract.id, action: "settle_pass", code: "PAYPAL_ERROR" }]);
    expect(eventKinds(contract.id).filter((k) => k === "ACTION_FAILED")).toHaveLength(1);
    expect(calls(paypal.captureAuthorization)).toBe(1);

    installPayPalFakes();
    const swept2 = await runSweep();
    expect(swept2.settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("PAID");
    expect(calls(paypal.captureAuthorization)).toBe(0); // fakes reinstalled: counts since then
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    expect(getContractDetail(contract.id, "payer").activity.last_failure).toBeNull();
  });

  it("capture fails: nothing recorded as captured, retry captures", async () => {
    const contract = await passed();
    vi.mocked(paypal.captureAuthorization).mockRejectedValueOnce(new Error("network down"));
    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    expect(getContract(contract.id)!.paypal_capture_id).toBeNull();
    expect(calls(paypal.payout)).toBe(0);
    expect((await settlePass(contract.id)).state).toBe("PAID");
  });

  it("a pending payout keeps the contract PASSED until PayPal reports SUCCESS, and is never sent twice", async () => {
    const contract = await passed();
    payoutItemStatus.value = "PENDING";
    expect((await settlePass(contract.id)).state).toBe("PASSED");
    expect(getContractDetail(contract.id, "payer").payout).toMatchObject({ status: "PENDING", amount_cents: 20000 });
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED"]);

    payoutItemStatus.value = "UNCLAIMED";
    expect((await runSweep()).settled).toEqual([]);
    expect(getContractDetail(contract.id, "payer").payout).toMatchObject({ status: "UNCLAIMED" });
    expect(getContractDetail(contract.id, "payer").activity.last_failure).toMatchObject({ step: "payout" });
    await runSweep();
    // PENDING matched the batch status at sending; only the change to UNCLAIMED is written, once.
    expect(eventKinds(contract.id).filter((k) => k === "PAYOUT_STATUS")).toHaveLength(1);

    payoutItemStatus.value = "SUCCESS";
    expect((await runSweep()).settled.map((c) => c.id)).toEqual([contract.id]);
    expect(calls(paypal.payout)).toBe(1);
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(stateOf(contract.id)).toBe("PAID");
  });

  it("split: payout fails after capture and refund, retry only pays out", async () => {
    const contract = await disputedWithProposal();
    await answerProposal(contract.id, "payer", true);
    payoutFails();
    await expectCode(answerProposal(contract.id, "worker", true), "PAYPAL_ERROR");
    expect(stateOf(contract.id)).toBe("DISPUTED");
    expect(getActiveDispute(contract.id)).toMatchObject({ payer_accepted: true, worker_accepted: true });
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED"]);
    // Neither party is offered "accept" again (DEF-12): the sweep resumes the settlement.
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual([]);
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual([]);

    // Accepting again over the API still resumes it from the failed step.
    installPayPalFakes();
    const resumed = await answerProposal(contract.id, "payer", true);
    expect(resumed.contract.state).toBe("SETTLED");
    expect(calls(paypal.captureAuthorization)).toBe(0);
    expect(calls(paypal.refundCapture)).toBe(0);
    expect(calls(paypal.payout)).toBe(1);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED", "PAID_OUT"]);
  });

  it("split: a failed refund is retried by the sweep without capturing again", async () => {
    const contract = await disputedWithProposal();
    await answerProposal(contract.id, "payer", true);
    vi.mocked(paypal.refundCapture).mockRejectedValueOnce(new Error("refund timeout"));
    await expectCode(answerProposal(contract.id, "worker", true), "PAYPAL_ERROR");
    expect(calls(paypal.payout)).toBe(0);
    const swept = await runSweep();
    expect(swept.settled.map((c) => c.id)).toEqual([contract.id]);
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect(calls(paypal.refundCapture)).toBe(2);
  });

  it("a payout failure in the background after verification is recorded, not lost", async () => {
    const contract = newContract();
    await fund(contract.id);
    payoutFails();
    expect((await submitAndVerify(contract.id, "passed")).state).toBe("PASSED");
    expect(getContractDetail(contract.id, "payer").activity.last_failure).toMatchObject({ action: "settle_pass", step: "payout" });
    expect(liveClaim(contract.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("verification", () => {
  it("inconclusive is neither pass nor fail: stays VERIFYING, re-run allowed", async () => {
    const contract = newContract();
    await fund(contract.id);
    expect((await submitAndVerify(contract.id, "inconclusive")).state).toBe("VERIFYING");
    const detail = getContractDetail(contract.id, "payer");
    expect(detail.verification).toMatchObject({ status: "inconclusive", message: "The site did not respond." });
    expect(detail.allowed_actions).toEqual(["rerun_verification", "dispute"]);
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual(["rerun_verification", "dispute"]);
    expect(calls(paypal.captureAuthorization)).toBe(0);

    verifierAnswers("passed");
    const job = rerunVerification(contract.id, "payer");
    expect(job.submissionId).toBe(detail.submissions[0].id);
    expect(getContractDetail(contract.id, "payer").verification).toMatchObject({ status: "running" });
    expect(getContractDetail(contract.id, "payer").activity.in_progress).toBe("verify");
    await job.run();
    expect(stateOf(contract.id)).toBe("PAID");
  });

  it("a run that has stored only some verdicts reads as running, never as a result", async () => {
    const contract = newContract();
    await fund(contract.id);
    let finishSecondCheck!: () => void;
    const secondCheck = new Promise<void>((resolve) => (finishSecondCheck = resolve));
    // Like the real verifier: each verdict is stored as its check finishes.
    vi.mocked(verifier.verifySubmission).mockImplementationOnce(async (submissionId) => {
      const [first, second] = listConditions(contract.id);
      const store = (conditionId: string, passed: boolean) =>
        createVerdict({
          submission_id: submissionId,
          condition_id: conditionId,
          passed,
          confidence: 1,
          reasoning: passed ? "found" : "missing",
          evidence: { outcome: passed ? "pass" : "fail" },
        });
      const verdicts = [store(first.id, false)];
      await secondCheck;
      verdicts.push(store(second.id, true));
      return { contractId: contract.id, submissionId, verdicts, allPassed: false, outcome: "failed", inconclusive: [] };
    });
    const job = submitWork(contract.id, "worker", "https://example.com/");
    const running = job.run();
    await vi.waitFor(() => expect(getContractDetail(contract.id, "payer").verdicts).toHaveLength(1));

    const midRun = getContractDetail(contract.id, "payer");
    expect(midRun.contract.state).toBe("VERIFYING");
    expect(midRun.verification).toMatchObject({ submission_id: job.submissionId, status: "running", message: null });
    expect(midRun.activity.in_progress).toBe("verify");
    expect(midRun.allowed_actions).toEqual([]);
    expect(eventKinds(contract.id)).not.toContain("VERIFICATION_COMPLETED");

    finishSecondCheck();
    await running;
    expect(stateOf(contract.id)).toBe("FAILED");
    expect(getContractDetail(contract.id, "payer").verification).toMatchObject({ status: "failed", message: "1 of 2 checks did not pass." });
  });

  it("a crashed verifier is recorded as an error, and a re-run is allowed", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.mocked(verifier.verifySubmission).mockRejectedValueOnce(new Error("chromium crashed"));
    const job = submitWork(contract.id, "worker", "https://example.com/");
    await job.run();
    expect(stateOf(contract.id)).toBe("VERIFYING");
    expect(getContractDetail(contract.id, "worker").verification).toMatchObject({ status: "error", message: "chromium crashed" });
    expect(eventKinds(contract.id)).toContain("VERIFICATION_ERROR");
    expect(liveClaim(contract.id)).toBeNull();
    verifierAnswers("failed");
    await rerunVerification(contract.id, "worker").run();
    expect(stateOf(contract.id)).toBe("FAILED");
  });

  it("a re-run while a run is in progress is BUSY, and only allowed in VERIFYING", async () => {
    const contract = newContract();
    await fund(contract.id);
    expect(() => rerunVerification(contract.id, "payer")).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION" }));
    verifierAnswers("passed");
    const job = submitWork(contract.id, "worker", "https://example.com/");
    expect(() => rerunVerification(contract.id, "payer")).toThrow(expect.objectContaining({ code: "BUSY" }));
    expect(() => submitWork(contract.id, "worker", "https://example.com/2")).toThrow(expect.objectContaining({ code: "BUSY" }));
    await job.run();
  });

  it("shows an interrupted run (claim gone, no outcome) as an error that can be re-run", async () => {
    const contract = newContract();
    await fund(contract.id);
    submitWork(contract.id, "worker", "https://example.com/"); // job never run: the process "died"
    const muchLater = new Date(Date.now() + 11 * 60 * 1000);
    const detail = getContractDetail(contract.id, "payer", muchLater);
    expect(detail.verification).toMatchObject({ status: "error" });
    expect(detail.allowed_actions).toEqual(["rerun_verification", "dispute"]);
  });
});

// ---------------------------------------------------------------------------

describe("no contract stranded in VERIFYING", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["payer", "worker"] as const)("after an inconclusive run the %s may dispute, and the split settles", async (party) => {
    const contract = newContract();
    await fund(contract.id);
    await submitAndVerify(contract.id, "inconclusive");
    expect(getContractDetail(contract.id, party).allowed_actions).toContain("dispute");

    const dispute = openDispute(contract.id, party, "The checker never reached a verdict.");
    expect(dispute).toMatchObject({ state: "OPEN", opened_by: party });
    expect(stateOf(contract.id)).toBe("DISPUTED");
    expect(listEvents(contract.id).find((e) => e.kind === "STATE_CHANGED" && e.detail.to === "DISPUTED")?.detail).toMatchObject({
      from: "VERIFYING",
    });

    await respondToDispute(contract.id, party === "payer" ? "worker" : "payer", "My side.");
    expect(vi.mocked(mediator.proposeSplit).mock.calls[0][0].verdicts.map((v) => v.evidence)).toEqual([{}, {}]);
    await answerProposal(contract.id, "payer", true);
    expect((await answerProposal(contract.id, "worker", true)).contract.state).toBe("SETTLED");
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED", "PAID_OUT"]);
  });

  it("the sweep voids the hold of an inconclusive VERIFYING contract past its deadline", async () => {
    const contract = newContract();
    await fund(contract.id);
    await submitAndVerify(contract.id, "inconclusive");
    expect((await runSweep()).expired).toEqual([]); // before the deadline nothing happens
    deadlinePassed(contract.id);

    const swept = await runSweep();
    expect(swept.expired.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("EXPIRED");
    expect(vi.mocked(paypal.voidAuthorization).mock.calls).toEqual([[`AUTH-${contract.id}`]]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(calls(paypal.captureAuthorization)).toBe(0);
  });

  it("the sweep also expires a VERIFYING contract whose last run crashed", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.mocked(verifier.verifySubmission).mockRejectedValueOnce(new Error("chromium crashed"));
    await submitWork(contract.id, "worker", "https://example.com/").run();
    deadlinePassed(contract.id);
    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
  });

  it("a run in progress is interrupted by neither a dispute nor the sweep", async () => {
    const contract = newContract();
    await fund(contract.id);
    verifierAnswers("passed");
    const job = submitWork(contract.id, "worker", "https://example.com/");
    deadlinePassed(contract.id);

    expect(() => openDispute(contract.id, "payer", "x")).toThrow(expect.objectContaining({ code: "BUSY" }));
    await expectCode(expireContract(contract.id), "BUSY");
    expect(await runSweep()).toEqual({ expired: [], settled: [], errors: [] });
    expect(getContractDetail(contract.id, "payer").allowed_actions).toEqual([]);
    expect(calls(paypal.voidAuthorization)).toBe(0);

    await job.run(); // the run finishes and is honoured: a pass pays out
    expect(stateOf(contract.id)).toBe("PAID");
    expect(calls(paypal.voidAuthorization)).toBe(0);
  });

  it("a run longer than the stale-claim window keeps its claim while it runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const contract = newContract();
    await fund(contract.id);
    verifierAnswers("inconclusive");
    const fake = vi.mocked(verifier.verifySubmission).getMockImplementation()!;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(verifier.verifySubmission).mockImplementationOnce(async (id) => {
      await gate;
      return fake(id);
    });
    const job = submitWork(contract.id, "worker", "https://example.com/");
    const running = job.run();
    deadlinePassed(contract.id);

    vi.advanceTimersByTime(45 * 60 * 1000); // far past the 10-minute stale window
    expect(liveClaim(contract.id)).toMatchObject({ action: "verify" });
    expect(() => openDispute(contract.id, "worker", "x")).toThrow(expect.objectContaining({ code: "BUSY" }));
    expect((await runSweep()).expired).toEqual([]);
    expect(calls(paypal.voidAuthorization)).toBe(0);

    finish();
    await running;
    expect(liveClaim(contract.id)).toBeNull();
    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
  });

  it("a pass reported without allPassed is treated as inconclusive: no money moves", async () => {
    const contract = newContract();
    await fund(contract.id);
    verifierAnswers("passed");
    const fake = vi.mocked(verifier.verifySubmission).getMockImplementation()!;
    vi.mocked(verifier.verifySubmission).mockImplementationOnce(async (id) => ({ ...(await fake(id)), allPassed: false }));
    await submitWork(contract.id, "worker", "https://example.com/").run();
    expect(stateOf(contract.id)).toBe("VERIFYING");
    expect(getContractDetail(contract.id, "payer").verification).toMatchObject({ status: "inconclusive" });
    expect(calls(paypal.captureAuthorization)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("money safety", () => {
  it("every PayPal money call runs with the contract already claimed in the database", async () => {
    const seen: [string, string | null][] = [];
    const record = (name: string, contractId: () => string) => () => seen.push([name, storedClaim(contractId())]);

    const settled = await passed();
    const capture = vi.mocked(paypal.captureAuthorization).getMockImplementation()!;
    vi.mocked(paypal.captureAuthorization).mockImplementation(async (input) => {
      record("capture", () => settled.id)();
      return capture(input);
    });
    const send = vi.mocked(paypal.payout).getMockImplementation()!;
    vi.mocked(paypal.payout).mockImplementation(async (input) => {
      record("payout", () => input.contractId)();
      return send(input);
    });
    await settlePass(settled.id);

    const expiring = newContract();
    await fund(expiring.id);
    const voidAuth = vi.mocked(paypal.voidAuthorization).getMockImplementation()!;
    vi.mocked(paypal.voidAuthorization).mockImplementation(async (id) => {
      record("void", () => expiring.id)();
      return voidAuth(id);
    });
    deadlinePassed(expiring.id);
    await runSweep();

    expect(seen).toEqual([
      ["capture", "settle_pass"],
      ["payout", "settle_pass"],
      ["void", "expire"],
    ]);
    expect(liveClaim(settled.id)).toBeNull();
    expect(liveClaim(expiring.id)).toBeNull();
  });

  it("a stale claim taken over after capture never captures twice", async () => {
    const contract = await passed();
    payoutFails();
    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    // The process "died" holding the claim 11 minutes ago.
    getDb()
      .prepare(`UPDATE contracts SET claim_action = 'settle_pass', claim_token = 'dead', claimed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), contract.id);
    installPayPalFakes();
    expect((await settlePass(contract.id)).state).toBe("PAID");
    expect(calls(paypal.captureAuthorization)).toBe(0);
    expect(calls(paypal.payout)).toBe(1);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
  });

  it("PAID only when payoutOutcome is PAID: a denied batch is never PAID; it is recorded and sent again", async () => {
    const contract = await passed();
    payoutStatusByBatch.set(`BATCH-${contract.id}`, "DENIED");
    payoutItemStatus.value = "PENDING";
    expect((await settlePass(contract.id)).state).toBe("PASSED");
    expect(listEvents(contract.id).find((e) => e.kind === "PAYOUT_STATUS")?.detail).toMatchObject({
      payout_batch_id: `BATCH-${contract.id}`,
      status: "DENIED",
    });
    expect(getContractDetail(contract.id, "payer").payout).toMatchObject({ payout_batch_id: `BATCH-${contract.id}-2`, status: "PENDING" });
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED"]);
    await runSweep();
    expect(calls(paypal.payout)).toBe(2); // the pending second attempt is not sent again
    expect(stateOf(contract.id)).toBe("PASSED");
  });

  it("refuses and voids a hold in another currency", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const orderId = await createFundingOrder(contract.id, "payer");
    vi.mocked(paypal.authorizeOrder).mockResolvedValueOnce({
      orderId,
      authorizationId: "AUTH-EUR",
      status: "CREATED",
      amountCents: contract.amount_cents,
      currency: "EUR",
      expiresAt: null,
      raw: { purchase_units: [{ reference_id: contract.id }] },
    });
    await expectCode(confirmFunding(contract.id, "payer", orderId), "ORDER_MISMATCH");
    expect(stateOf(contract.id)).toBe("SIGNED");
    expect(vi.mocked(paypal.voidAuthorization).mock.calls).toEqual([["AUTH-EUR"]]);
  });

  it("a repeated create-order records the replayed order once", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const first = await createFundingOrder(contract.id, "payer");
    expect(await createFundingOrder(contract.id, "payer")).toBe(first);
    expect(eventKinds(contract.id).filter((k) => k === "ORDER_CREATED")).toHaveLength(1);
  });

  it("split payout SUCCESS webhook before the sweep: SETTLED once, one PAID_OUT row", async () => {
    const contract = await disputedWithProposal();
    payoutItemStatus.value = "PENDING";
    await answerProposal(contract.id, "payer", true);
    expect((await answerProposal(contract.id, "worker", true)).contract.state).toBe("DISPUTED");
    handlePayPalWebhookEvent({
      id: `WH-SPLIT-${contract.id}`,
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {
        payout_item_id: `ITEM-BATCH-${contract.id}`,
        payout_batch_id: `BATCH-${contract.id}`,
        transaction_status: "SUCCESS",
        payout_item: { amount: { currency: "USD", value: "120.00" }, sender_item_id: contract.id },
      },
    });
    payoutItemStatus.value = "SUCCESS";
    expect((await runSweep()).settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("SETTLED");
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED", "PAID_OUT"]);
    expect(calls(paypal.payout)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("webhook arrived first", () => {
  const authorizationEvent = (contract: Contract) => ({
    id: `WH-AUTH-${contract.id}`,
    event_type: "PAYMENT.AUTHORIZATION.CREATED",
    resource: {
      id: `AUTH-${contract.id}`,
      status: "CREATED",
      amount: { currency_code: "USD", value: (contract.amount_cents / 100).toFixed(2) },
      custom_id: contract.id,
      supplementary_data: { related_ids: { order_id: `ORDER-${contract.id}` } },
    },
  });

  it("before authorize: the call returns the funded contract without a second ledger row", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const orderId = await createFundingOrder(contract.id, "payer");
    handlePayPalWebhookEvent(authorizationEvent(getContract(contract.id)!));
    expect(stateOf(contract.id)).toBe("FUNDED");
    const funded = await confirmFunding(contract.id, "payer", orderId);
    expect(funded.state).toBe("FUNDED");
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED"]);
  });

  it("during authorize: the transition counts as already done", async () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    signContract(contract.id, "worker");
    const orderId = await createFundingOrder(contract.id, "payer");
    const real = vi.mocked(paypal.authorizeOrder).getMockImplementation()!;
    vi.mocked(paypal.authorizeOrder).mockImplementationOnce(async (id) => {
      const result = await real(id);
      handlePayPalWebhookEvent(authorizationEvent(getContract(contract.id)!));
      return result;
    });
    const funded = await confirmFunding(contract.id, "payer", orderId);
    expect(funded).toMatchObject({ state: "FUNDED", paypal_authorization_id: `AUTH-${contract.id}` });
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED"]);
    expect(eventKinds(contract.id)).toContain("FUNDS_AUTHORIZED");
  });

  it("payout SUCCESS webhook before the sweep: PAID once, sweep has nothing to do", async () => {
    const contract = await passed();
    payoutItemStatus.value = "PENDING";
    await settlePass(contract.id);
    handlePayPalWebhookEvent({
      id: `WH-PAYOUT-${contract.id}`,
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {
        payout_item_id: `ITEM-BATCH-${contract.id}`,
        payout_batch_id: `BATCH-${contract.id}`,
        transaction_status: "SUCCESS",
        payout_item: { amount: { currency: "USD", value: "200.00" }, sender_item_id: contract.id },
      },
    });
    expect(stateOf(contract.id)).toBe("PAID");
    payoutItemStatus.value = "SUCCESS";
    expect(await runSweep()).toEqual({ expired: [], settled: [], errors: [] });
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    expect(calls(paypal.payout)).toBe(1);
  });

  it("capture webhook before the payout step: settle does not capture again", async () => {
    const contract = await passed();
    payoutFails();
    vi.mocked(paypal.captureAuthorization).mockRejectedValueOnce(new Error("response lost"));
    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    handlePayPalWebhookEvent({
      id: `WH-CAP-${contract.id}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: `CAP-AUTH-${contract.id}`,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "200.00" },
        custom_id: contract.id,
      },
    });
    installPayPalFakes();
    expect((await settlePass(contract.id)).state).toBe("PAID");
    expect(calls(paypal.captureAuthorization)).toBe(0);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
  });

  it("void webhook during expiry: EXPIRED once, one VOIDED row", async () => {
    const contract = newContract();
    await fund(contract.id);
    vi.mocked(paypal.voidAuthorization).mockImplementationOnce(async (authorizationId) => {
      handlePayPalWebhookEvent({
        id: `WH-VOID-${contract.id}`,
        event_type: "PAYMENT.AUTHORIZATION.VOIDED",
        resource: {
          id: authorizationId,
          status: "VOIDED",
          amount: { currency_code: "USD", value: "200.00" },
          custom_id: contract.id,
        },
      });
      return { authorizationId, status: "VOIDED", raw: null };
    });
    const expired = await expireContract(contract.id, new Date(Date.parse(contract.deadline_at) + 1000));
    expect(expired.state).toBe("EXPIRED");
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
  });
});

// ---------------------------------------------------------------------------

describe("a payout PayPal returns", () => {
  const attempts = () => vi.mocked(paypal.payout).mock.calls.map(([input]) => input.attempt);

  it("is recorded, then sent again under the next attempt; the second attempt's SUCCESS pays", async () => {
    const contract = await passed();
    payoutStatusByBatch.set(`BATCH-${contract.id}`, "FAILED");
    expect((await settlePass(contract.id)).state).toBe("PAID");
    expect(attempts()).toEqual([1, 2]);
    expect(calls(paypal.captureAuthorization)).toBe(1);
    const events = listEvents(contract.id);
    const retried = events.findIndex((e) => e.kind === "PAYOUT_RETRIED");
    const resent = events.findIndex((e) => e.kind === "PAYOUT_SENT" && e.detail.payout_batch_id === `BATCH-${contract.id}-2`);
    expect(events[retried]?.detail).toMatchObject({
      payout_batch_id: `BATCH-${contract.id}`,
      status: "FAILED",
      attempt: 2,
      max_attempts: 3,
    });
    expect(resent).toBeGreaterThan(retried); // the returned batch is on record before it is replaced
    expect(listLedgerEntries({ contract_id: contract.id }).map((e) => [e.kind, e.paypal_ref])).toEqual([
      ["AUTHORIZED", `AUTH-${contract.id}`],
      ["CAPTURED", `CAP-AUTH-${contract.id}`],
      ["PAID_OUT", `BATCH-${contract.id}-2`],
    ]);
  });

  it("after the third returned payout the sweep refunds the payer in full and ends the contract SETTLED", async () => {
    const contract = await passed();
    payoutItemStatus.value = "RETURNED";
    const swept = await runSweep();
    expect(swept.settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("SETTLED");
    expect(attempts()).toEqual([1, 2, 3]);
    expect(vi.mocked(paypal.refundCapture).mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ captureId: `CAP-AUTH-${contract.id}`, amountCents: 20000, reason: "payout_returned" }),
    ]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED"]);
    expect(eventKinds(contract.id).filter((k) => k === "PAYOUT_RETRIED")).toHaveLength(2);
    expect(listEvents(contract.id).find((e) => e.kind === "PAYOUT_ABANDONED")?.detail).toMatchObject({
      payout_batch_id: `BATCH-${contract.id}-3`,
      attempts: 3,
      amount_cents: 20000,
    });
    expect(listEvents(contract.id).findLast((e) => e.kind === "STATE_CHANGED")?.detail).toMatchObject({
      from: "PASSED",
      to: "SETTLED",
      worker_cents: 0,
      refund_cents: 20000,
    });
    const detail = getContractDetail(contract.id, "payer");
    expect(detail.allowed_actions).toEqual([]);
    expect(detail.activity.last_failure).toBeNull();

    await runSweep();
    expect(calls(paypal.payout)).toBe(3);
    expect(calls(paypal.refundCapture)).toBe(1);
  });

  it("an UNCLAIMED payout is never sent again, however many sweeps run", async () => {
    const contract = await passed();
    payoutItemStatus.value = "UNCLAIMED";
    for (let i = 0; i < 5; i++) await runSweep();
    expect(calls(paypal.payout)).toBe(1);
    expect(eventKinds(contract.id)).not.toContain("PAYOUT_RETRIED");
    expect(stateOf(contract.id)).toBe("PASSED");
    expect(getContractDetail(contract.id, "payer").payout).toMatchObject({ status: "UNCLAIMED" });
  });

  it("a resend that fails is retried under the same attempt, never skipping one", async () => {
    const contract = await passed();
    payoutStatusByBatch.set(`BATCH-${contract.id}`, "FAILED");
    payoutItemStatus.value = "PENDING";
    const send = vi.mocked(paypal.payout).getMockImplementation()!;
    let failOnce = true;
    vi.mocked(paypal.payout).mockImplementation(async (input) => {
      if (input.attempt === 2 && failOnce) {
        failOnce = false;
        throw new Error("network down");
      }
      return send(input);
    });
    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    expect(getContract(contract.id)!.paypal_payout_batch_id).toBeNull();
    await runSweep();
    expect(attempts()).toEqual([1, 2, 2]);
    expect(getContract(contract.id)).toMatchObject({ state: "PASSED", paypal_payout_batch_id: `BATCH-${contract.id}-2` });
    expect(eventKinds(contract.id).filter((k) => k === "PAYOUT_RETRIED")).toHaveLength(1);
  });

  it("a batch PayPal DENIED as it was sent is recorded and sent again", async () => {
    const contract = await passed();
    vi.mocked(paypal.payout).mockImplementationOnce(async () => {
      throw new paypal.PayPalError({
        operation: "POST /v1/payments/payouts",
        status: 201,
        paypalName: "PAYOUT_BATCH_DENIED",
        paypalMessage: "PayPal returned the payout batch with status DENIED; no money moved",
        debugId: null,
        body: { batch_header: { payout_batch_id: "BATCH-DENIED", batch_status: "DENIED" } },
      });
    });
    payoutStatusByBatch.set("BATCH-DENIED", "DENIED");
    expect((await settlePass(contract.id)).state).toBe("PAID");
    expect(attempts()).toEqual([1, 2]);
    expect(listEvents(contract.id).find((e) => e.kind === "PAYOUT_RETRIED")?.detail).toMatchObject({
      payout_batch_id: "BATCH-DENIED",
      status: "DENIED",
    });
  });

  it("split: a returned worker share is sent again; after the third it is refunded too and the dispute SETTLED", async () => {
    const contract = await disputedWithProposal(10000); // equal shares: two refunds of the same amount
    payoutItemStatus.value = "FAILED";
    await answerProposal(contract.id, "payer", true);
    const result = await answerProposal(contract.id, "worker", true);
    expect(result.contract.state).toBe("SETTLED");
    expect(result.dispute.state).toBe("SETTLED");
    expect(attempts()).toEqual([1, 2, 3]);
    expect(vi.mocked(paypal.refundCapture).mock.calls.map(([input]) => [input.amountCents, input.reason])).toEqual([
      [10000, undefined],
      [10000, "payout_returned"],
    ]);
    expect(listLedgerEntries({ contract_id: contract.id }).map((e) => [e.kind, e.amount_cents])).toEqual([
      ["AUTHORIZED", 20000],
      ["CAPTURED", 20000],
      ["REFUNDED", 10000],
      ["REFUNDED", 10000],
    ]);
    expect(calls(paypal.captureAuthorization)).toBe(1);
    expect((await runSweep()).settled).toEqual([]);
    expect(calls(paypal.payout)).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("no money held forever in a dispute", () => {
  it("the sweep voids the hold of a DISPUTED contract the other party never answered, past its deadline", async () => {
    const contract = newContract();
    await fund(contract.id);
    const dispute = openDispute(contract.id, "payer", "Nothing was delivered.");
    expect((await runSweep()).expired).toEqual([]);
    deadlinePassed(contract.id);

    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("EXPIRED");
    expect(vi.mocked(paypal.voidAuthorization).mock.calls).toEqual([[`AUTH-${contract.id}`]]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(listEvents(contract.id).findLast((e) => e.kind === "STATE_CHANGED")?.detail).toMatchObject({
      from: "DISPUTED",
      to: "EXPIRED",
      dispute_id: dispute.id,
    });
  });

  it("the sweep voids the hold of an ESCALATED contract past its deadline", async () => {
    const contract = newContract();
    await fund(contract.id);
    openDispute(contract.id, "payer", "no");
    await respondToDispute(contract.id, "worker", "yes");
    await answerProposal(contract.id, "worker", false);
    expect(stateOf(contract.id)).toBe("ESCALATED");
    deadlinePassed(contract.id);

    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "VOIDED"]);
    expect(eventKinds(contract.id)).toContain("AUTHORIZATION_VOIDED");
  });

  it("a split both parties accepted is settled, not expired, after the deadline", async () => {
    const contract = await disputedWithProposal();
    await answerProposal(contract.id, "payer", true);
    vi.mocked(paypal.captureAuthorization).mockRejectedValueOnce(new Error("network down"));
    await expectCode(answerProposal(contract.id, "worker", true), "PAYPAL_ERROR");
    deadlinePassed(contract.id);
    await expectCode(expireContract(contract.id), "ILLEGAL_TRANSITION");

    const swept = await runSweep();
    expect(swept.expired).toEqual([]);
    expect(swept.settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("SETTLED");
    expect(calls(paypal.voidAuthorization)).toBe(0);
  });

  it("an expired contract's dispute can no longer be argued or answered", async () => {
    const open = newContract();
    await fund(open.id);
    openDispute(open.id, "payer", "a");
    const proposed = await disputedWithProposal();
    deadlinePassed(open.id);
    deadlinePassed(proposed.id);
    await runSweep();
    expect([stateOf(open.id), stateOf(proposed.id)]).toEqual(["EXPIRED", "EXPIRED"]);

    vi.mocked(mediator.proposeSplit).mockClear();
    await expectCode(respondToDispute(open.id, "worker", "b"), "ILLEGAL_TRANSITION");
    expect(vi.mocked(mediator.proposeSplit)).not.toHaveBeenCalled();
    await expectCode(answerProposal(proposed.id, "payer", true), "ILLEGAL_TRANSITION");
    await expectCode(answerProposal(proposed.id, "worker", false), "ILLEGAL_TRANSITION");
    expect(getActiveDispute(proposed.id)).toMatchObject({ payer_accepted: null, worker_accepted: null });
  });
});

// ---------------------------------------------------------------------------

describe("a capture whose response was lost", () => {
  /** PASSED, with the capture done at PayPal but its answer lost, so no capture id is stored. */
  async function passedWithLostCapture(): Promise<Contract> {
    const contract = newContract();
    await fund(contract.id);
    vi.mocked(paypal.captureAuthorization).mockRejectedValueOnce(new Error("socket hang up"));
    expect((await submitAndVerify(contract.id, "passed")).state).toBe("PASSED");
    expect(getContract(contract.id)!.paypal_capture_id).toBeNull();
    return contract;
  }

  const alreadyCaptured = (issue: string) =>
    new paypal.PayPalError({
      operation: "POST void",
      status: 422,
      paypalName: "UNPROCESSABLE_ENTITY",
      paypalMessage: "Authorization has been previously captured",
      debugId: null,
      details: [{ issue }],
    });

  it.each(["AUTHORIZATION_ALREADY_CAPTURED", "PREVIOUSLY_CAPTURED"])(
    "a 0 worker split (void answered %s) replays the capture and refunds the payer in full",
    async (issue) => {
      const contract = await passedWithLostCapture();
      openDispute(contract.id, "payer", "The site went down an hour later.");
      vi.mocked(mediator.proposeSplit).mockResolvedValue({ proposed_worker_cents: 0, reasoning: "x" });
      await respondToDispute(contract.id, "worker", "It was fine.");
      vi.mocked(paypal.voidAuthorization).mockRejectedValue(alreadyCaptured(issue));
      await answerProposal(contract.id, "payer", true);

      const settled = await answerProposal(contract.id, "worker", true);
      expect(settled.contract.state).toBe("SETTLED");
      expect(settled.dispute.state).toBe("SETTLED");
      const captures = vi.mocked(paypal.captureAuthorization).mock.calls.map(([input]) => input);
      expect(captures).toHaveLength(2);
      expect(captures[1]).toEqual(captures[0]); // the same request, so PayPal replays the first capture
      expect(vi.mocked(paypal.refundCapture).mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ captureId: `CAP-AUTH-${contract.id}`, amountCents: 20000 }),
      ]);
      expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED"]);
    },
  );

  it("an unfinished dispute past the deadline does the same when it expires", async () => {
    const contract = await passedWithLostCapture();
    openDispute(contract.id, "payer", "The site went down an hour later.");
    vi.mocked(paypal.voidAuthorization).mockRejectedValue(alreadyCaptured("AUTHORIZATION_ALREADY_CAPTURED"));
    deadlinePassed(contract.id);

    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "REFUNDED"]);
    expect(vi.mocked(paypal.refundCapture).mock.calls[0][0]).toMatchObject({ amountCents: 20000 });
  });
});

// ---------------------------------------------------------------------------

describe("a payout whose response was lost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is recovered by the next sweep from PayPal's duplicate refusal: PAID, with one PAID_OUT row", async () => {
    const contract = await passed();
    // The real payout and status reader, over a fake PayPal that creates the
    // batch on the first send but never answers, then refuses every resend of
    // that sender_batch_id as the sandbox does (docs/paypal-notes.md, section 2).
    const actual = await vi.importActual<typeof import("@/lib/paypal")>("@/lib/paypal");
    vi.mocked(paypal.payout).mockImplementation(actual.payout);
    vi.mocked(paypal.getPayoutBatch).mockImplementation(actual.getPayoutBatch);
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let sent: { sender_batch_header: unknown; items: unknown[] } | null = null;
    let sends = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/oauth2/token")) return respond(200, { access_token: "token", expires_in: 3600 });
        if (url.endsWith("/v1/payments/payouts") && init?.method === "POST") {
          sends++;
          if (!sent) {
            sent = JSON.parse(String(init.body));
            throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
          }
          return respond(400, {
            name: "USER_BUSINESS_ERROR",
            message: "User business error.",
            details: [
              {
                field: "SENDER_BATCH_ID",
                location: "body",
                issue: "Batch with given sender_batch_id already exists",
                link: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/LOST-1", rel: "self", method: "GET" }],
              },
            ],
            links: [],
          });
        }
        if (url.endsWith("/v1/payments/payouts/LOST-1") && sent) {
          return respond(200, {
            batch_header: { payout_batch_id: "LOST-1", batch_status: "SUCCESS", sender_batch_header: sent.sender_batch_header },
            items: [{ payout_item_id: "ITEM-LOST-1", transaction_status: "SUCCESS", payout_item: sent.items[0] }],
          });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
      }),
    );

    await expectCode(settlePass(contract.id), "PAYPAL_ERROR");
    expect(getContract(contract.id)!.paypal_payout_batch_id).toBeNull();
    expect(getContractDetail(contract.id, "payer").activity.last_failure).toMatchObject({ step: "payout" });

    expect((await runSweep()).settled.map((c) => c.id)).toEqual([contract.id]);
    expect(stateOf(contract.id)).toBe("PAID");
    expect(getContract(contract.id)!.paypal_payout_batch_id).toBe("LOST-1");
    expect(listEvents(contract.id).filter((e) => e.kind === "PAYOUT_SENT").map((e) => e.detail)).toMatchObject([
      { payout_batch_id: "LOST-1", amount_cents: 20000, attempt: 1, recovered: true },
    ]);
    expect(await runSweep()).toEqual({ expired: [], settled: [], errors: [] });
    expect(sends).toBe(2);
    expect(ledgerKinds(contract.id)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    expect(listLedgerEntries({ contract_id: contract.id }).find((e) => e.kind === "PAID_OUT")).toMatchObject({
      amount_cents: 20000,
      paypal_ref: "LOST-1",
    });
  });
});

// ---------------------------------------------------------------------------

describe("after the deadline", () => {
  it("re-running verification is refused, so it cannot lead to payment", async () => {
    const contract = newContract();
    await fund(contract.id);
    await submitAndVerify(contract.id, "inconclusive");
    deadlinePassed(contract.id);
    expect(getContractDetail(contract.id, "worker").allowed_actions).not.toContain("rerun_verification");
    verifierAnswers("passed");
    expect(() => rerunVerification(contract.id, "worker")).toThrow(expect.objectContaining({ code: "DEADLINE_PASSED" }));
    expect(liveClaim(contract.id)).toBeNull();
    expect((await runSweep()).expired.map((c) => c.id)).toEqual([contract.id]);
    expect(calls(paypal.captureAuthorization)).toBe(0);
  });

  it("a draft can no longer be signed, so it never becomes a SIGNED contract nobody can fund (DEF-15)", () => {
    const contract = newContract();
    signContract(contract.id, "payer");
    deadlinePassed(contract.id);
    expect(getContractDetail(contract.id, "worker").allowed_actions).toEqual(["edit_conditions"]);
    expect(() => signContract(contract.id, "worker")).toThrow(
      expect.objectContaining({ code: "DEADLINE_PASSED", message: expect.stringMatching(/^Cannot sign: the deadline \(.+\) has passed\.$/) }),
    );
    expect(stateOf(contract.id)).toBe("DRAFT");
    expect(getContract(contract.id)!.worker_signed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("claims live in real time", () => {
  it("a claim taken with an old clock is stamped now, so it is live, not stale at once", () => {
    const contract = newContract();
    acquireClaim(contract.id, "settle_pass", () => {}, new Date(Date.now() - 11 * 60 * 1000));
    expect(liveClaim(contract.id)).toMatchObject({ action: "settle_pass" });
    expect(() => acquireClaim(contract.id, "expire", () => {})).toThrow(expect.objectContaining({ code: "BUSY" }));
  });

  it("a sweep that started long ago holds a live claim, so a second request cannot run beside it", async () => {
    const contract = newContract();
    await fund(contract.id);
    getDb()
      .prepare(`UPDATE contracts SET deadline_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 12 * 60 * 1000).toISOString(), contract.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const voidAuth = vi.mocked(paypal.voidAuthorization).getMockImplementation()!;
    vi.mocked(paypal.voidAuthorization).mockImplementation(async (id) => {
      await gate;
      return voidAuth(id);
    });
    const sweep = runSweep(new Date(Date.now() - 11 * 60 * 1000)); // e.g. stuck behind slow PayPal calls
    await vi.waitFor(() => expect(calls(paypal.voidAuthorization)).toBe(1));
    const second = expireContract(contract.id);
    const raced = await Promise.race([second.then(() => "ran", (err) => err.code), new Promise((r) => setTimeout(() => r("ran"), 100))]);
    release();
    expect(raced).toBe("BUSY");
    expect((await sweep).expired.map((c) => c.id)).toEqual([contract.id]);
    await second.catch(() => {});
    expect(calls(paypal.voidAuthorization)).toBe(1);
  });
});
