/**
 * What the contract page says about the money when the state alone would
 * mislead: a failed PayPal step the sweep retries (DEF-10, DEF-12), a 0
 * worker share settled by voiding the hold and an accepted split (DEF-13), a
 * deadline the sweep has not acted on yet (DEF-14), a lapsed contract (DEF-15).
 */
import { describe, expect, it } from "vitest";
import type { Contract, ContractState, Dispute } from "@/lib/types";
import type { ContractBundle } from "../api";
import { contractNotice, moneyPosition } from "./money";
import { moneyFlow } from "./money-flow";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const FUTURE = "2026-11-15T23:59:59.000Z";
const PAST = "2026-11-12T11:00:00.000Z";

function contract(state: ContractState, overrides: Partial<Contract> = {}): Contract {
  return {
    id: "c1",
    title: "Landing page",
    type: "website_milestone",
    payer_email: "payer@example.com",
    worker_email: "worker@example.com",
    amount_cents: 2500,
    currency: "USD",
    deadline_at: FUTURE,
    state,
    payer_signed_at: null,
    worker_signed_at: null,
    paypal_order_id: null,
    paypal_authorization_id: null,
    paypal_capture_id: null,
    paypal_payout_batch_id: null,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function row(kind: ContractBundle["ledger"][number]["kind"], cents = 2500): ContractBundle["ledger"][number] {
  return { id: `l-${kind}`, contract_id: "c1", kind, amount_cents: cents, paypal_ref: `REF-${kind}`, created_at: "2026-11-11T00:00:00.000Z" };
}

function dispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: "d1",
    contract_id: "c1",
    opened_by: "payer",
    payer_argument: "Nothing was delivered.",
    worker_argument: "A first version was delivered.",
    proposed_worker_cents: 0,
    proposal_reasoning: "No condition has a verdict.",
    payer_accepted: null,
    worker_accepted: null,
    state: "PROPOSED",
    created_at: "2026-11-11T00:00:00.000Z",
    updated_at: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

const failure = (action: string, step: string) => ({ action, step, message: "PayPal refused the request.", at: "2026-11-11T01:00:00.000Z" });

function bundle(c: Contract, extra: Partial<ContractBundle> = {}): ContractBundle {
  return {
    contract: c,
    conditions: [{ id: "k1" }, { id: "k2" }] as ContractBundle["conditions"],
    submissions: [],
    verdicts: [],
    ledger: [],
    events: [],
    dispute: null,
    notes: [],
    viewer: { role: "payer" },
    allowed_actions: [],
    verification: null,
    activity: { in_progress: null, last_failure: null },
    payout: null,
    terms_sha256: null,
    receipt: null,
    trace: { now: "2026-11-10T14:21:00.000Z", steps: [] },
    ...extra,
  };
}

/** Every word the diagram shows, to check no "moving" claim survives a failure. */
function flowText(b: ContractBundle): string {
  const flow = moneyFlow(b);
  return JSON.stringify([Object.values(flow.places), Object.values(flow.legs)]);
}

const held = { paypal_order_id: "O1", paypal_authorization_id: "A1" };

describe("a capture PayPal refused (DEF-10)", () => {
  const passed = bundle(contract("PASSED", held), {
    ledger: [row("AUTHORIZED")],
    activity: { in_progress: null, last_failure: failure("settle_pass", "capture") },
  });

  it("is said as a failure that is retried, not as the worker being paid", () => {
    expect(contractNotice(passed, NOW)).toEqual({
      tone: "disputed",
      text: "Every test passed, but PayPal refused to capture the hold. Proviso tries again automatically.",
    });
  });

  it("draws the capture as refused, with nothing moving", () => {
    const flow = moneyFlow(passed);
    expect(flow.legs.capture).toMatchObject({ status: "failed", verb: "Capture refused", note: "Proviso tries again automatically" });
    expect(Object.values(flow.legs).filter((l) => l.status === "moving")).toEqual([]);
    expect(flow.now).toEqual({ places: ["hold"], leg: null });
  });

  it("still draws a capture under way when nothing failed", () => {
    const flowing = moneyFlow({ ...passed, activity: { in_progress: "settle_pass", last_failure: null } });
    expect(flowing.legs.capture.status).toBe("moving");
    expect(contractNotice({ ...passed, activity: { in_progress: null, last_failure: null } }, NOW)).toBeNull();
  });
});

describe("a payout that failed after the capture (DEF-10)", () => {
  const captured = bundle(contract("PASSED", { ...held, paypal_capture_id: "C1" }), {
    ledger: [row("AUTHORIZED"), row("CAPTURED")],
    activity: { in_progress: null, last_failure: failure("settle_pass", "payout") },
  });

  it("says the payout has not reached the worker and is retried", () => {
    expect(contractNotice(captured, NOW)?.text).toMatch(/payout has not reached the worker\. Proviso keeps trying automatically\./);
    const flow = moneyFlow(captured);
    expect(flow.legs.payout).toMatchObject({ status: "failed", verb: "Payout failed" });
    expect(flow.places.capture.word).toBe("charged · step being retried");
    expect(flowText(captured)).not.toMatch(/paying out|is sending it|on its way/);
    const position = moneyPosition(captured.contract, captured.ledger, null, captured.activity.last_failure);
    expect(position.detail).not.toMatch(/on its way/);
    expect(position.detail).toMatch(/did not go through\. Proviso tries again automatically\./);
  });
});

describe("a split both parties accepted (DEF-12, DEF-13)", () => {
  const disputed = contract("DISPUTED", held);

  it("settles a 0 worker share by releasing the hold: no capture, no refund, no payout", () => {
    const pending = bundle(disputed, { ledger: [row("AUTHORIZED")], dispute: dispute() });
    const flow = moneyFlow(pending);
    expect(flow.legs.capture.status).toBe("closed");
    expect(flow.legs.refund.status).toBe("closed");
    expect(flow.legs.payout.status).toBe("closed");
    expect(flow.legs.release).toMatchObject({ status: "possible", trigger: "both accept the split", when: null });
    expect(flow.places.worker).toMatchObject({ status: "closed", cents: null, word: "nothing, if both accept" });
    expect(flow.places.returned).toMatchObject({ cents: 2500, word: "if both accept" });
  });

  it("drops \"if both accept\" once both have, and shows the failed release as retried", () => {
    const agreed = bundle(disputed, {
      ledger: [row("AUTHORIZED")],
      dispute: dispute({ payer_accepted: true, worker_accepted: true }),
      activity: { in_progress: null, last_failure: failure("settle_split", "void") },
    });
    expect(contractNotice(agreed, NOW)).toEqual({
      tone: "disputed",
      text: "Both accepted the split, but PayPal did not complete the settlement. It is being retried automatically.",
    });
    const flow = moneyFlow(agreed);
    expect(flow.legs.release).toMatchObject({ status: "failed", verb: "Release refused" });
    expect(flow.places.worker.word).toBe("nothing paid");
    expect(flow.places.returned.word).toBe("release being retried");
    expect(flowText(agreed)).not.toMatch(/both accept/);
    expect(moneyPosition(agreed.contract, agreed.ledger, null, agreed.activity.last_failure).detail).toMatch(
      /Both accepted the split; settling it with PayPal did not go through yet, and Proviso tries again automatically\./,
    );
  });

  it("names a non-zero split's steps as settling, not as waiting for acceptance", () => {
    const agreed = bundle(disputed, {
      ledger: [row("AUTHORIZED")],
      dispute: dispute({ proposed_worker_cents: 1250, payer_accepted: true, worker_accepted: true }),
    });
    expect(contractNotice(agreed, NOW)?.text).toBe("Both accepted the split. It is being settled with PayPal.");
    const flow = moneyFlow(agreed);
    expect(flow.legs.capture).toMatchObject({ status: "possible", trigger: "the agreed split is settled" });
    expect(flow.legs.payout.trigger).toBe("the agreed split is settled");
    expect(flow.places.worker).toMatchObject({ cents: 1250, word: "on settlement" });
    expect(flowText(agreed)).not.toMatch(/both accept/);
  });
});

describe("past the deadline (DEF-14, DEF-15)", () => {
  it("says the hold is being released before the sweep has expired the contract", () => {
    for (const state of ["FUNDED", "FAILED"] as const) {
      const late = bundle(contract(state, { ...held, deadline_at: PAST }), { ledger: [row("AUTHORIZED")] });
      expect(contractNotice(late, NOW)).toEqual({ tone: "returned", text: "The deadline passed. The hold is being released to the payer." });
      expect(contractNotice(late, Date.parse(PAST) - 1)).toBeNull();
      expect(contractNotice(late, null)).toBeNull();
    }
  });

  it("says a failed release is retried, and leaves a running verification alone", () => {
    const failed = bundle(contract("FUNDED", { ...held, deadline_at: PAST }), {
      activity: { in_progress: null, last_failure: failure("expire", "void") },
    });
    expect(contractNotice(failed, NOW)?.text).toBe("The deadline passed, but PayPal did not release the hold. Proviso tries again automatically.");
    const running = bundle(contract("VERIFYING", { ...held, deadline_at: PAST }), { activity: { in_progress: "verify", last_failure: null } });
    expect(contractNotice(running, NOW)).toBeNull();
  });

  it("says plainly that an unsigned or unfunded contract lapsed", () => {
    expect(contractNotice(bundle(contract("DRAFT", { deadline_at: PAST })), NOW)?.text).toMatch(/draft lapsed and can no longer be signed/);
    expect(contractNotice(bundle(contract("SIGNED", { deadline_at: PAST })), NOW)?.text).toMatch(/before the payer funded it, so this contract lapsed/);
    expect(contractNotice(bundle(contract("SIGNED")), NOW)).toBeNull();
  });
});
