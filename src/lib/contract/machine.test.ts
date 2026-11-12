import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getContract, setPaypalRefs } from "@/lib/db/contracts";
import { InvalidConditionError, listConditions } from "@/lib/db/conditions";
import { listEvents } from "@/lib/db/events";
import { createSubmission } from "@/lib/db/submissions";
import { CONTRACT_STATES, type ConditionInput, type ContractState, type ContractTermsPatch } from "@/lib/types";
import { contractIn, makeContract, step, withTempDb } from "@/test/helpers";
import {
  allowedTransitions,
  canTransition,
  ContractLockedError,
  ContractMachineError,
  ContractNotFoundError,
  editConditions,
  editTerms,
  IllegalTransitionError,
  isTerminal,
  signOff,
  transition,
  TRANSITIONS,
} from "./machine";

withTempDb();

const LEGAL: [ContractState, ContractState][] = CONTRACT_STATES.flatMap((from) =>
  TRANSITIONS[from].map((to): [ContractState, ContractState] => [from, to]),
);
const ILLEGAL: [ContractState, ContractState][] = CONTRACT_STATES.flatMap((from) =>
  CONTRACT_STATES.filter((to) => !TRANSITIONS[from].includes(to)).map((to): [ContractState, ContractState] => [
    from,
    to,
  ]),
);

const stateChanges = (contractId: string) =>
  listEvents(contractId)
    .filter((e) => e.kind === "STATE_CHANGED")
    .map((e) => [e.detail.from, e.detail.to]);

const newConditions: ConditionInput[] = [
  { text: "Works at phone width", check_kind: "responsive", check_params: { width: 375 } },
];

describe("transition table", () => {
  it("matches the diagram in machine.ts", () => {
    expect(TRANSITIONS).toEqual({
      DRAFT: ["SIGNED"],
      SIGNED: ["FUNDED"],
      FUNDED: ["SUBMITTED", "EXPIRED", "DISPUTED"],
      SUBMITTED: ["VERIFYING"],
      VERIFYING: ["PASSED", "FAILED", "DISPUTED", "EXPIRED"],
      PASSED: ["PAID", "DISPUTED", "SETTLED"],
      FAILED: ["SUBMITTED", "EXPIRED", "DISPUTED"],
      PAID: [],
      EXPIRED: [],
      DISPUTED: ["SETTLED", "ESCALATED", "EXPIRED"],
      SETTLED: [],
      ESCALATED: ["SETTLED", "EXPIRED"],
    });
  });

  it("covers every state", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...CONTRACT_STATES].sort());
  });

  it("answers canTransition, allowedTransitions and isTerminal from the table", () => {
    expect(canTransition("VERIFYING", "FAILED")).toBe(true);
    expect(canTransition("DRAFT", "FUNDED")).toBe(false);
    expect(allowedTransitions("FAILED")).toEqual(["SUBMITTED", "EXPIRED", "DISPUTED"]);
    expect(CONTRACT_STATES.filter(isTerminal)).toEqual(["PAID", "EXPIRED", "SETTLED"]);
  });
});

describe("legal transitions", () => {
  it.each(LEGAL)("%s -> %s changes state and writes one STATE_CHANGED event", (from, to) => {
    const contract = contractIn(from);
    const before = stateChanges(contract.id).length;

    const after = step(contract.id, to);

    expect(after.state).toBe(to);
    expect(getContract(contract.id)!.state).toBe(to);
    const changes = stateChanges(contract.id);
    expect(changes).toHaveLength(before + 1);
    expect(changes.at(-1)).toEqual([from, to]);
  });

  it("records actor, extra detail and PayPal refs on the event", () => {
    const contract = contractIn("SIGNED");
    transition(contract.id, "FUNDED", {
      actor: "payer",
      paypal: { paypal_authorization_id: "AUTH-9" },
      detail: { note: "approved in checkout" },
    });
    const event = listEvents(contract.id).at(-1)!;
    expect(event.kind).toBe("STATE_CHANGED");
    expect(event.detail).toEqual({
      from: "SIGNED",
      to: "FUNDED",
      actor: "payer",
      note: "approved in checkout",
      paypal: { paypal_authorization_id: "AUTH-9" },
    });
  });

  it("writes PayPal refs in the same update as the state change", () => {
    const contract = contractIn("PASSED");
    const paid = transition(contract.id, "PAID", {
      actor: "system",
      paypal: { paypal_capture_id: "CAP-7", paypal_payout_batch_id: "BATCH-7" },
    });
    expect(paid).toMatchObject({ state: "PAID", paypal_capture_id: "CAP-7", paypal_payout_batch_id: "BATCH-7" });
    // refs set earlier are kept
    expect(paid.paypal_authorization_id).toBe("AUTH-1");
  });

  it("lets the worker resubmit after FAILED", () => {
    const contract = contractIn("FAILED");
    createSubmission({ contract_id: contract.id, url: "https://example.com/v2" });
    expect(transition(contract.id, "SUBMITTED", { actor: "worker" }).state).toBe("SUBMITTED");
    expect(transition(contract.id, "VERIFYING", { actor: "system" }).state).toBe("VERIFYING");
    expect(transition(contract.id, "PASSED", { actor: "system" }).state).toBe("PASSED");
  });

  it("runs the whole happy path DRAFT -> PAID", () => {
    const contract = contractIn("PAID");
    expect(stateChanges(contract.id)).toEqual([
      ["DRAFT", "SIGNED"],
      ["SIGNED", "FUNDED"],
      ["FUNDED", "SUBMITTED"],
      ["SUBMITTED", "VERIFYING"],
      ["VERIFYING", "PASSED"],
      ["PASSED", "PAID"],
    ]);
  });
});

describe("illegal transitions", () => {
  it.each(ILLEGAL)("%s -> %s throws and changes nothing", (from, to) => {
    const contract = contractIn(from);
    const eventsBefore = listEvents(contract.id).length;

    let error: unknown;
    try {
      transition(contract.id, to, {
        actor: "system",
        paypal: { paypal_authorization_id: "AUTH-X", paypal_payout_batch_id: "BATCH-X" },
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(IllegalTransitionError);
    expect(error).toBeInstanceOf(ContractMachineError);
    expect(error).toMatchObject({ code: "ILLEGAL_TRANSITION", contractId: contract.id, from, to });
    expect(getContract(contract.id)).toEqual(contract);
    expect(listEvents(contract.id)).toHaveLength(eventsBefore);
  });

  it("throws ContractNotFoundError for an unknown contract", () => {
    expect(() => transition("nope", "SIGNED", { actor: "system" })).toThrow(ContractNotFoundError);
    expect(() => signOff("nope", "payer")).toThrow(ContractNotFoundError);
    expect(() => editConditions("nope", newConditions, "payer")).toThrow(ContractNotFoundError);
    expect(() => editTerms("nope", { title: "x" }, "payer")).toThrow(ContractNotFoundError);
  });
});

describe("guards", () => {
  it("DRAFT -> SIGNED via transition() needs both sign-offs", () => {
    const contract = makeContract();
    expect(() => transition(contract.id, "SIGNED", { actor: "payer" })).toThrow(/both parties must sign off/);
    signOff(contract.id, "payer");
    expect(() => transition(contract.id, "SIGNED", { actor: "payer" })).toThrow(/both parties must sign off/);
    expect(getContract(contract.id)!.state).toBe("DRAFT");
  });

  it("SIGNED -> FUNDED needs a PayPal authorization or capture", () => {
    const contract = contractIn("SIGNED");
    expect(() => transition(contract.id, "FUNDED", { actor: "payer" })).toThrow(/no PayPal authorization/);
    expect(() =>
      transition(contract.id, "FUNDED", { actor: "payer", paypal: { paypal_order_id: "ORDER-1" } }),
    ).toThrow(/no PayPal authorization/);
    expect(getContract(contract.id)).toMatchObject({ state: "SIGNED", paypal_order_id: null });

    // the capture-first variant (long contracts) also counts as funded
    const funded = transition(contract.id, "FUNDED", { actor: "payer", paypal: { paypal_capture_id: "CAP-1" } });
    expect(funded).toMatchObject({ state: "FUNDED", paypal_capture_id: "CAP-1" });
  });

  it("accepts an authorization stored earlier with setPaypalRefs", () => {
    const contract = contractIn("SIGNED");
    setPaypalRefs(contract.id, { paypal_order_id: "ORDER-2", paypal_authorization_id: "AUTH-2" });
    expect(transition(contract.id, "FUNDED", { actor: "payer" }).state).toBe("FUNDED");
  });

  it("FUNDED -> SUBMITTED needs a submission", () => {
    const contract = contractIn("FUNDED");
    expect(() => transition(contract.id, "SUBMITTED", { actor: "worker" })).toThrow(/no submission/);
    expect(getContract(contract.id)!.state).toBe("FUNDED");
  });

  it("PASSED -> PAID needs a PayPal payout", () => {
    const contract = contractIn("PASSED");
    expect(() =>
      transition(contract.id, "PAID", { actor: "system", paypal: { paypal_capture_id: "CAP-1" } }),
    ).toThrow(/no PayPal payout/);
    expect(getContract(contract.id)).toMatchObject({ state: "PASSED", paypal_capture_id: null });
  });
});

describe("sign-off", () => {
  it("records the first sign-off without changing state", () => {
    const contract = makeContract();
    const signed = signOff(contract.id, "worker");
    expect(signed.state).toBe("DRAFT");
    expect(signed.worker_signed_at).not.toBeNull();
    expect(signed.payer_signed_at).toBeNull();
    expect(listEvents(contract.id).at(-1)).toMatchObject({ kind: "SIGNED_OFF", detail: { party: "worker" } });
  });

  it("moves to SIGNED when the second party signs, in either order", () => {
    for (const [first, second] of [
      ["payer", "worker"],
      ["worker", "payer"],
    ] as const) {
      const contract = makeContract();
      signOff(contract.id, first);
      const signed = signOff(contract.id, second);
      expect(signed.state).toBe("SIGNED");
      expect(signed.payer_signed_at).not.toBeNull();
      expect(signed.worker_signed_at).not.toBeNull();
      expect(listEvents(contract.id).map((e) => e.kind)).toEqual([
        "CONTRACT_CREATED",
        "SIGNED_OFF",
        "SIGNED_OFF",
        "STATE_CHANGED",
      ]);
      expect(listEvents(contract.id).at(-1)!.detail).toMatchObject({ from: "DRAFT", to: "SIGNED", actor: second });
    }
  });

  it("is a no-op when the same party signs twice", () => {
    const contract = makeContract();
    const first = signOff(contract.id, "payer");
    const again = signOff(contract.id, "payer");
    expect(again.payer_signed_at).toBe(first.payer_signed_at);
    expect(again.state).toBe("DRAFT");
    expect(listEvents(contract.id).filter((e) => e.kind === "SIGNED_OFF")).toHaveLength(1);
  });

  it("refuses a contract with no conditions", () => {
    const contract = makeContract({ conditions: [] });
    expect(() => signOff(contract.id, "payer")).toThrow(/no conditions/);
    expect(getContract(contract.id)!.payer_signed_at).toBeNull();
  });

  it("is refused outside DRAFT", () => {
    for (const state of ["SIGNED", "FUNDED", "PAID"] as const) {
      const contract = contractIn(state);
      expect(() => signOff(contract.id, "payer")).toThrow(IllegalTransitionError);
      expect(getContract(contract.id)).toEqual(contract);
    }
  });
});

describe("editing conditions", () => {
  it("replaces the conditions in order", () => {
    const contract = makeContract();
    editConditions(contract.id, newConditions, "payer");
    expect(listConditions(contract.id).map((c) => [c.position, c.text, c.check_kind])).toEqual([
      [0, "Works at phone width", "responsive"],
    ]);
    expect(listEvents(contract.id).at(-1)).toMatchObject({ kind: "CONDITIONS_EDITED", detail: { count: 1 } });
  });

  it("clears both sign-offs, so both parties must sign again", () => {
    const contract = makeContract();
    signOff(contract.id, "payer");

    const edited = editConditions(contract.id, newConditions, "worker");
    expect(edited.payer_signed_at).toBeNull();
    expect(edited.worker_signed_at).toBeNull();
    expect(listEvents(contract.id).map((e) => e.kind)).toContain("SIGNOFFS_CLEARED");

    expect(signOff(contract.id, "worker").state).toBe("DRAFT");
    expect(signOff(contract.id, "payer").state).toBe("SIGNED");
  });

  it("records no SIGNOFFS_CLEARED event when nobody had signed", () => {
    const contract = makeContract();
    editConditions(contract.id, newConditions, "payer");
    expect(listEvents(contract.id).map((e) => e.kind)).not.toContain("SIGNOFFS_CLEARED");
  });

  it.each(CONTRACT_STATES.filter((s) => s !== "DRAFT"))("is locked in %s", (state) => {
    const contract = contractIn(state);
    const conditionsBefore = listConditions(contract.id);

    expect(() => editConditions(contract.id, newConditions, "payer")).toThrow(ContractLockedError);
    expect(() => editTerms(contract.id, { amount_cents: 1 }, "payer")).toThrow(ContractLockedError);
    expect(listConditions(contract.id)).toEqual(conditionsBefore);
    expect(getContract(contract.id)).toEqual(contract);
  });

  it("rejects a check kind that does not belong to the contract type", () => {
    const contract = makeContract();
    signOff(contract.id, "payer");
    expect(() =>
      editConditions(
        contract.id,
        [{ text: "PR merged", check_kind: "github_pr_merged", check_params: { repo: "a/b" } }],
        "payer",
      ),
    ).toThrow(InvalidConditionError);
    // nothing changed, sign-off kept
    expect(listConditions(contract.id)).toHaveLength(2);
    expect(getContract(contract.id)!.payer_signed_at).not.toBeNull();
  });

  it("rejects params that do not match the check kind", () => {
    const contract = makeContract();
    const bad = [{ text: "Has a form", check_kind: "dom_assert", check_params: {} }] as unknown as ConditionInput[];
    expect(() => editConditions(contract.id, bad, "payer")).toThrow(ZodError);
    expect(listConditions(contract.id)).toHaveLength(2);
  });
});

describe("editing terms", () => {
  it("updates only the given fields and clears sign-offs", () => {
    const contract = makeContract({ currency: "EUR" });
    signOff(contract.id, "worker");

    const edited = editTerms(contract.id, { title: "New title", amount_cents: 12345 }, "payer");

    expect(edited).toMatchObject({
      title: "New title",
      amount_cents: 12345,
      currency: "EUR",
      worker_signed_at: null,
      state: "DRAFT",
    });
    expect(listEvents(contract.id).map((e) => e.kind).slice(-2)).toEqual(["SIGNOFFS_CLEARED", "TERMS_EDITED"]);
  });

  it("does nothing for an empty patch", () => {
    const contract = makeContract();
    signOff(contract.id, "payer");
    const before = getContract(contract.id);
    expect(editTerms(contract.id, {}, "payer")).toEqual(before);
  });

  it("refuses a type change that would orphan the existing conditions", () => {
    const contract = makeContract();
    expect(() => editTerms(contract.id, { type: "code_bounty" }, "payer")).toThrow(InvalidConditionError);
    expect(getContract(contract.id)!.type).toBe("website_milestone");
  });

  it("validates the patch", () => {
    const contract = makeContract();
    expect(() => editTerms(contract.id, { payer_email: "not-an-email" }, "payer")).toThrow(ZodError);
    expect(() => editTerms(contract.id, { amount_cents: 0 }, "payer")).toThrow(ZodError);
  });

  it("keeps an edit to USD and at most $5,000.00, as creating does (DEF-18)", () => {
    const contract = makeContract();
    expect(() => editTerms(contract.id, { currency: "EUR" } as unknown as ContractTermsPatch, "payer")).toThrow(ZodError);
    expect(() => editTerms(contract.id, { amount_cents: 500_001 }, "payer")).toThrow(ZodError);
    expect(editTerms(contract.id, { amount_cents: 500_000, currency: "USD" }, "payer")).toMatchObject({ amount_cents: 500_000, currency: "USD" });
  });
});
