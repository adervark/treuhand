/**
 * The one-line recap on a paid contract reads every figure from the contract's
 * own records: the passing attempt, its tests, the AI reviewers' votes, the
 * receipt and the time from submission to the contract becoming PAID.
 */
import { describe, expect, it } from "vitest";
import type { Contract, ContractState, Verdict } from "@/lib/types";
import type { ContractBundle } from "../api";
import { formatTook, readRecap } from "./recap";

function bundle(state: ContractState, overrides: Partial<ContractBundle> = {}): ContractBundle {
  const contract = {
    id: "c1",
    title: "Landing page",
    type: "website_milestone",
    payer_email: "payer@example.com",
    worker_email: "worker@example.com",
    amount_cents: 40000,
    currency: "USD",
    deadline_at: "2026-11-15T00:00:00.000Z",
    state,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
  } as Contract;
  return {
    contract,
    conditions: [
      { id: "k1", contract_id: "c1", position: 0, text: "Loads", check_kind: "http_ok", check_params: {} },
      { id: "k2", contract_id: "c1", position: 1, text: "Sells bread", check_kind: "ai_page_judgement", check_params: {} },
    ] as unknown as ContractBundle["conditions"],
    submissions: [
      { id: "s2", contract_id: "c1", url: "https://example.com/2", created_at: "2026-11-10T14:14:07.000Z" },
      { id: "s1", contract_id: "c1", url: "https://example.com/1", created_at: "2026-11-10T09:12:22.000Z" },
    ],
    verdicts: [
      verdict("v1", "s1", "k1", false),
      verdict("v2", "s2", "k1", true),
      verdict("v3", "s2", "k2", true, { panel: { votes: [{ vote: "pass" }, { vote: "pass" }, { vote: "fail" }], decision: "pass" } }),
    ],
    ledger: [],
    events: [
      { id: "e1", contract_id: "c1", kind: "STATE_CHANGED", detail: { from: "PASSED", to: "PAID" }, created_at: "2026-11-10T14:20:52.000Z" },
    ],
    dispute: null,
    notes: [],
    viewer: { role: "payer" },
    allowed_actions: [],
    verification: null,
    activity: { in_progress: null, last_failure: null },
    payout: { payout_batch_id: "B1", amount_cents: 40000, status: "SUCCESS", at: "2026-11-10T14:20:52.000Z" },
    terms_sha256: null,
    receipt: { receipt: { submission_id: "s2", outcome: "passed" } } as ContractBundle["receipt"],
    trace: { now: "2026-11-10T14:21:00.000Z", steps: [] },
    ...overrides,
  } as ContractBundle;
}

function verdict(id: string, submission: string, condition: string, passed: boolean, evidence: Verdict["evidence"] = {}): Verdict {
  return { id, submission_id: submission, condition_id: condition, passed, confidence: passed ? 0.9 : 0.8, reasoning: "", evidence, created_at: "2026-11-10T14:15:00.000Z" };
}

describe("readRecap", () => {
  it("summarises the passing attempt of a paid contract", () => {
    expect(readRecap(bundle("PAID"))).toEqual({
      attempt: 2,
      passed: 2,
      total: 2,
      panel: { tests: 1, reviewers: 3, agreed: 2 },
      signed: true,
      amountCents: 40000,
      tookMs: (6 * 60 + 45) * 1000,
    });
  });

  it("shows nothing before the contract is paid, or when a dispute settled it", () => {
    expect(readRecap(bundle("PASSED"))).toBeNull();
    expect(readRecap(bundle("SETTLED"))).toBeNull();
    expect(readRecap(bundle("PAID", { dispute: {} as ContractBundle["dispute"] }))).toBeNull();
  });

  it("shows nothing without the event that made it PAID", () => {
    expect(readRecap(bundle("PAID", { events: [] }))).toBeNull();
  });
});

describe("formatTook", () => {
  it("names the two largest units", () => {
    expect(formatTook(45_000)).toBe("45 s");
    expect(formatTook(405_000)).toBe("6 min 45 s");
    expect(formatTook(360_000)).toBe("6 min");
    expect(formatTook((2 * 60 + 5) * 60_000)).toBe("2 h 5 min");
    expect(formatTook((3 * 24 + 4) * 3_600_000)).toBe("3 d 4 h");
  });
});
