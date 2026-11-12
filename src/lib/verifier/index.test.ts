/**
 * `verifySubmission`: outcome rules, what is stored, re-run replacement, and
 * one end-to-end run through real browser checks against the fixture server.
 * Most tests replace the check runners in `checkRegistry` with stubs.
 */
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { websiteContractInput, withTempDb } from "@/test/helpers";
import { createContract } from "@/lib/db/contracts";
import { listStepsForSubmission } from "@/lib/db/steps";
import { createSubmission } from "@/lib/db/submissions";
import { listVerdictsForSubmission } from "@/lib/db/verdicts";
import type { CheckKind, NewContractInput } from "@/lib/types";
import { startFixtureServer, type FixtureServer } from "../../../test/fixtures/server";
import {
  checkRegistry,
  overallOutcome,
  resolveEvidencePath,
  toVerdictFields,
  unsafeAllowPrivateNetworkForTests,
  verdictOutcome,
  verifySubmission,
  type CheckResult,
} from "./index";
import { fail, inconclusive, pass } from "./result";
import { note, step, toEvidenceTrace } from "./trace";

withTempDb();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CONDITIONS: NewContractInput["conditions"] = [
  { text: "Loads", check_kind: "http_ok", check_params: {} },
  { text: "Has a contact form", check_kind: "dom_assert", check_params: { selector: "form" } },
  { text: "Works on a phone", check_kind: "responsive", check_params: {} },
];

function setup(url = "https://bakery.example/", conditions = CONDITIONS) {
  const contract = createContract(websiteContractInput({ conditions }));
  const submission = createSubmission({ contract_id: contract.id, url });
  return { contract, submission };
}

function stub(kind: CheckKind, result: CheckResult | (() => Promise<CheckResult>)) {
  return vi.spyOn(checkRegistry, kind).mockImplementation(typeof result === "function" ? result : async () => result);
}

describe("overallOutcome", () => {
  it.each([
    [["pass", "pass"], "passed"],
    [["pass", "inconclusive"], "inconclusive"],
    [["inconclusive", "fail", "pass"], "failed"],
    [["fail"], "failed"],
    [[], "inconclusive"],
  ] as const)("%j -> %s", (outcomes, expected) => {
    expect(overallOutcome([...outcomes])).toBe(expected);
  });
});

describe("toVerdictFields", () => {
  it("keeps a pass or fail at or above the threshold", () => {
    expect(toVerdictFields(pass("ok", {}, 0.8))).toMatchObject({ passed: true, confidence: 0.8, evidence: { outcome: "pass" } });
    expect(toVerdictFields(fail("no", {}, 0.9))).toMatchObject({ passed: false, confidence: 0.9, evidence: { outcome: "fail" } });
  });

  it("turns a pass or fail below the threshold into inconclusive, keeping the leaning", () => {
    expect(toVerdictFields(pass("ok", {}, 0.79))).toMatchObject({
      passed: false,
      confidence: 0,
      evidence: { outcome: "inconclusive", below_threshold: { leaned: "pass", confidence: 0.79 } },
    });
    expect(toVerdictFields(fail("no", {}, 0.5)).evidence).toMatchObject({ outcome: "inconclusive", below_threshold: { leaned: "fail" } });
  });

  it("treats a non-finite confidence as zero, and clamps above one", () => {
    expect(toVerdictFields(pass("ok", {}, Number.NaN)).evidence.outcome).toBe("inconclusive");
    expect(toVerdictFields(pass("ok", {}, 7)).confidence).toBe(1);
  });

  it("stores an inconclusive check as passed=false, confidence 0, with the error", () => {
    expect(toVerdictFields(inconclusive("timed out", { url: "x" }, new Error("ETIMEDOUT")))).toEqual({
      passed: false,
      confidence: 0,
      reasoning: "timed out",
      evidence: { url: "x", outcome: "inconclusive", error: { name: "Error", message: "ETIMEDOUT" } },
    });
  });
});

describe("verdictOutcome", () => {
  it("reads evidence.outcome, falling back to passed for older rows", () => {
    expect(verdictOutcome({ passed: false, evidence: { outcome: "inconclusive" } })).toBe("inconclusive");
    expect(verdictOutcome({ passed: true, evidence: {} })).toBe("pass");
    expect(verdictOutcome({ passed: false, evidence: {} })).toBe("fail");
  });
});

describe("verifySubmission", () => {
  it("passes when every condition passes, storing one verdict per condition in order", async () => {
    const { contract, submission } = setup();
    stub("http_ok", pass("HTTP 200", { http_status: 200 }));
    stub("dom_assert", pass("form found", { screenshots: ["data/evidence/x/1.jpg"] }));
    stub("responsive", pass("fits", {}, 0.95));

    const result = await verifySubmission(submission.id);
    expect(result).toMatchObject({ contractId: contract.id, submissionId: submission.id, outcome: "passed", allPassed: true, inconclusive: [] });
    expect(result.verdicts.map((v) => v.reasoning)).toEqual(["HTTP 200", "form found", "fits"]);
    expect(result.verdicts[2]).toMatchObject({ passed: true, confidence: 0.95 });
    expect(result.verdicts[0].evidence).toMatchObject({
      outcome: "pass",
      check_kind: "http_ok",
      http_status: 200,
      timings: { started_at: expect.any(String), duration_ms: expect.any(Number) },
    });
    expect(listVerdictsForSubmission(submission.id)).toEqual(result.verdicts);
  });

  it("any conclusive fail fails the run, even with an inconclusive check", async () => {
    const { submission } = setup();
    stub("http_ok", inconclusive("reset", {}));
    stub("dom_assert", fail("no form", {}));
    stub("responsive", pass("fits", {}));
    const result = await verifySubmission(submission.id);
    expect(result).toMatchObject({ outcome: "failed", allPassed: false });
    expect(result.inconclusive).toEqual([{ condition_id: result.verdicts[0].condition_id, reason: "reset" }]);
  });

  it("an inconclusive check with no fail makes the run inconclusive", async () => {
    const { submission } = setup();
    stub("http_ok", pass("200", {}));
    stub("dom_assert", inconclusive("The site could not be reached.", {}, new Error("ECONNRESET")));
    stub("responsive", pass("fits", {}));
    const result = await verifySubmission(submission.id);
    expect(result).toMatchObject({ outcome: "inconclusive", allPassed: false });
    expect(result.verdicts[1]).toMatchObject({
      passed: false,
      confidence: 0,
      evidence: { outcome: "inconclusive", error: { message: "ECONNRESET" } },
    });
  });

  it("a pass below the confidence threshold makes the run inconclusive, not passed", async () => {
    const { submission } = setup();
    stub("http_ok", pass("200", {}));
    stub("dom_assert", pass("form", {}));
    stub("responsive", pass("probably fits", {}, 0.7));
    const result = await verifySubmission(submission.id);
    expect(result).toMatchObject({ outcome: "inconclusive", allPassed: false });
    expect(result.verdicts[2]).toMatchObject({ passed: false, confidence: 0 });
  });

  it("a check that throws is stored as inconclusive, and the others still run", async () => {
    const { submission } = setup();
    stub("http_ok", async () => {
      throw new Error("chromium crashed");
    });
    const dom = stub("dom_assert", pass("form", {}));
    stub("responsive", pass("fits", {}));
    const result = await verifySubmission(submission.id);
    expect(result.outcome).toBe("inconclusive");
    expect(result.verdicts[0].reasoning).toBe("The check could not complete: chromium crashed");
    expect(result.verdicts[0].evidence).toMatchObject({ outcome: "inconclusive", error: { message: "chromium crashed" } });
    expect(dom).toHaveBeenCalledTimes(1);
  });

  it("a check that never finishes is inconclusive after its time limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { submission } = setup();
    stub("http_ok", () => new Promise<CheckResult>(() => undefined));
    stub("dom_assert", pass("form", {}));
    stub("responsive", pass("fits", {}));
    const running = verifySubmission(submission.id);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;
    expect(result.outcome).toBe("inconclusive");
    expect(result.verdicts[0].reasoning).toBe("The check did not finish within 60 s.");
  });

  it("passes each runner the contract, condition, submission and validated params", async () => {
    const { contract, submission } = setup("https://bakery.example/", [
      { text: "Phone", check_kind: "responsive", check_params: { path: "/menu" } },
    ]);
    const runner = stub("responsive", pass("fits", {}));
    await verifySubmission(submission.id);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: expect.objectContaining({ id: contract.id }),
        condition: expect.objectContaining({ check_kind: "responsive", text: "Phone" }),
        submission: expect.objectContaining({ id: submission.id, url: "https://bakery.example/" }),
        params: { path: "/menu", width: 375 },
      }),
    );
  });

  it("a re-run replaces that submission's verdicts and leaves other submissions alone", async () => {
    const { contract, submission } = setup();
    const other = createSubmission({ contract_id: contract.id, url: "https://other.example/" });
    stub("http_ok", fail("HTTP 404", {}));
    stub("dom_assert", pass("form", {}));
    stub("responsive", pass("fits", {}));
    const first = await verifySubmission(submission.id);
    const otherRun = await verifySubmission(other.id);
    expect(first.outcome).toBe("failed");

    stub("http_ok", pass("HTTP 200", {}));
    const second = await verifySubmission(submission.id);
    expect(second.outcome).toBe("passed");

    const stored = listVerdictsForSubmission(submission.id);
    expect(stored).toHaveLength(CONDITIONS.length);
    expect(stored.map((v) => v.id)).toEqual(second.verdicts.map((v) => v.id));
    expect(stored.map((v) => v.id)).not.toEqual(expect.arrayContaining([first.verdicts[0].id]));
    expect(stored[0].reasoning).toBe("HTTP 200");
    expect(listVerdictsForSubmission(other.id).map((v) => v.id)).toEqual(otherRun.verdicts.map((v) => v.id));
  });

  it("stores each verdict as soon as its check finishes, after clearing the earlier run's set", async () => {
    const { submission } = setup();
    stub("http_ok", pass("old 200", {}));
    stub("dom_assert", pass("old form", {}));
    stub("responsive", pass("old fits", {}));
    await verifySubmission(submission.id);

    // What is stored when each check starts: the page polls the same table.
    const seen: string[][] = [];
    const stored = () => listVerdictsForSubmission(submission.id).map((v) => v.reasoning);
    const observing = (result: CheckResult) => async () => {
      seen.push(stored());
      return result;
    };
    stub("http_ok", observing(pass("HTTP 200", {})));
    stub("dom_assert", observing(fail("no form", {})));
    stub("responsive", observing(pass("fits", {})));
    const result = await verifySubmission(submission.id);

    expect(seen).toEqual([[], ["HTTP 200"], ["HTTP 200", "no form"]]);
    expect(result.outcome).toBe("failed");
    expect(listVerdictsForSubmission(submission.id)).toEqual(result.verdicts);
  });

  it("a run that crashes part way leaves a partial set, which the next re-run replaces with one complete set", async () => {
    const { submission } = setup();
    stub("http_ok", pass("HTTP 200", {}));
    // Evidence that does not fit the verdict schema makes storing the second verdict throw.
    stub("dom_assert", pass("form", { screenshots: [42] as unknown as string[] }));
    const responsive = stub("responsive", pass("fits", {}));
    await expect(verifySubmission(submission.id)).rejects.toThrow();
    expect(listVerdictsForSubmission(submission.id).map((v) => v.reasoning)).toEqual(["HTTP 200"]);
    expect(responsive).not.toHaveBeenCalled();

    stub("dom_assert", pass("form", {}));
    const rerun = await verifySubmission(submission.id);
    expect(rerun.outcome).toBe("passed");
    const stored = listVerdictsForSubmission(submission.id);
    expect(stored).toHaveLength(CONDITIONS.length);
    expect(stored).toEqual(rerun.verdicts);
  });

  it("records each check's work log as it runs and copies it into that verdict's evidence.trace", async () => {
    const { submission } = setup();
    let duringDom: string[] = [];
    stub("http_ok", async () => {
      await step("network", "Request the page", (h) => h.detail({ http_status: 200 }), { host: "bakery.example" });
      return pass("HTTP 200", {});
    });
    stub("dom_assert", async () => {
      duringDom = listStepsForSubmission(submission.id).map((s) => `${s.label}:${s.status}`);
      note("measure", "Find the elements matching the selector", {}, { matched: 0 });
      return fail("no form", {});
    });
    stub("responsive", inconclusive("reset", {}));
    const result = await verifySubmission(submission.id);

    expect(duringDom).toEqual(["Request the page:done", "Record the verdict:done"]);
    const steps = listStepsForSubmission(submission.id);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const verdict of result.verdicts) {
      expect(verdict.evidence.trace).toEqual(toEvidenceTrace(steps.filter((s) => s.condition_id === verdict.condition_id)));
    }
    expect(steps.map((s) => [s.condition_id, s.kind, s.label])).toEqual([
      [result.verdicts[0].condition_id, "network", "Request the page"],
      [result.verdicts[0].condition_id, "decision", "Record the verdict"],
      [result.verdicts[1].condition_id, "measure", "Find the elements matching the selector"],
      [result.verdicts[1].condition_id, "decision", "Record the verdict"],
      [result.verdicts[2].condition_id, "decision", "Record the verdict"],
    ]);
    expect(steps[0]).toMatchObject({ status: "done", detail: { host: "bakery.example", http_status: 200 }, result: {} });
    // The verdict is in `result` only, never in the label or the neutral detail.
    expect(steps.filter((s) => s.kind === "decision").map((s) => [s.detail, s.result])).toEqual([
      [{ check_kind: "http_ok" }, { outcome: "pass", confidence: 1 }],
      [{ check_kind: "dom_assert" }, { outcome: "fail", confidence: 1 }],
      [{ check_kind: "responsive" }, { outcome: "inconclusive", confidence: 0, reason: "reset" }],
    ]);
    expect(listVerdictsForSubmission(submission.id)).toEqual(result.verdicts);
  });

  it("a re-run replaces that submission's work log", async () => {
    const { submission } = setup();
    stub("http_ok", async () => {
      note("network", "Request the page");
      return pass("HTTP 200", {});
    });
    stub("dom_assert", pass("form", {}));
    stub("responsive", pass("fits", {}));
    await verifySubmission(submission.id);
    const first = listStepsForSubmission(submission.id);
    expect(first).toHaveLength(4);

    stub("http_ok", pass("HTTP 200", {}));
    const second = await verifySubmission(submission.id);
    const steps = listStepsForSubmission(submission.id);
    expect(steps.map((s) => [s.seq, s.label])).toEqual([
      [1, "Record the verdict"],
      [2, "Record the verdict"],
      [3, "Record the verdict"],
    ]);
    expect(steps.map((s) => s.id)).not.toEqual(expect.arrayContaining([first[0].id]));
    expect(second.verdicts[0].evidence.trace).toEqual(toEvidenceTrace(steps.slice(0, 1)));
  });

  it("a check stopped at its time limit records the limit, and its unfinished steps are cut off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { submission } = setup();
    stub("http_ok", () => step("browser", "Load the page", () => new Promise<CheckResult>(() => undefined)));
    stub("dom_assert", pass("form", {}));
    stub("responsive", pass("fits", {}));
    const running = verifySubmission(submission.id);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;
    const steps = listStepsForSubmission(submission.id).filter((s) => s.condition_id === result.verdicts[0].condition_id);
    expect(steps.map((s) => [s.label, s.status, s.detail, s.result])).toEqual([
      ["Load the page", "failed", { cut_off: true }, {}],
      ["Stop the check at its time limit", "done", { limit_s: 60 }, { timed_out: true }],
      ["Record the verdict", "done", { check_kind: "http_ok" }, { outcome: "inconclusive", confidence: 0, reason: "The check did not finish within 60 s." }],
    ]);
    expect(result.verdicts[0].evidence.trace).toEqual(toEvidenceTrace(steps));
  });

  it("throws for a submission that does not exist or a contract with no conditions", async () => {
    await expect(verifySubmission("missing")).rejects.toThrow(/submission missing not found/);
    const { submission } = setup("https://bakery.example/", []);
    await expect(verifySubmission(submission.id)).rejects.toThrow(/has no conditions/);
  });
});

describe("verifySubmission end to end (real browser, fixture server)", () => {
  let server: FixtureServer;
  const created: string[] = [];

  beforeAll(async () => {
    server = await startFixtureServer();
    unsafeAllowPrivateNetworkForTests(true);
  });

  afterAll(async () => {
    unsafeAllowPrivateNetworkForTests(false);
    for (const dir of created) fs.rmSync(resolveEvidencePath(dir), { recursive: true, force: true });
    await server.close();
  });

  const WEBSITE: NewContractInput["conditions"] = [
    { text: "Loads", check_kind: "http_ok", check_params: {} },
    { text: "Shows the bakery's name", check_kind: "dom_assert", check_params: { selector: "#brand", text: "Bloom & Crumb" } },
    { text: "Works on a phone", check_kind: "responsive", check_params: {} },
    {
      text: "The contact form works",
      check_kind: "form_submits",
      check_params: {
        form_selector: "#contact-form",
        fields: { "#name": "Asha", "#email": "asha@example.com", "#message": "Hello" },
        success_text: "Thanks, we received your message",
      },
    },
  ];

  it(
    "stores a verdict and evidence screenshots under data/evidence/<submissionId>/ for each condition",
    async () => {
      const { submission } = setup(`${server.url}/good.html`, WEBSITE);
      created.push(`data/evidence/${submission.id}`);
      const result = await verifySubmission(submission.id);

      expect(result.outcome).toBe("passed");
      const stored = listVerdictsForSubmission(submission.id);
      expect(stored.map((v) => [v.evidence.check_kind, v.evidence.outcome, v.passed, v.confidence])).toEqual([
        ["http_ok", "pass", true, 1],
        ["dom_assert", "pass", true, 1],
        ["responsive", "pass", true, 1],
        ["form_submits", "pass", true, 1],
      ]);
      expect(stored[0].evidence).toMatchObject({ http_status: 200, final_url: `${server.url}/good.html` });

      // The work log: every step finished, in the order the checks ran, and copied into each verdict.
      const steps = listStepsForSubmission(submission.id);
      expect(steps.every((s) => s.status === "done" && s.duration_ms !== null)).toBe(true);
      const loadPage = ["Check the address is a public website", "Start an isolated browser behind the guard proxy", "Load the page"];
      const labels = (i: number) => steps.filter((s) => s.condition_id === stored[i].condition_id).map((s) => s.label);
      expect(labels(0)).toEqual(["Check the address is allowed", "Request the page", "Record the verdict"]);
      expect(labels(1)).toEqual([...loadPage, "Find the elements matching the selector", "Take an evidence screenshot", "Record the verdict"]);
      expect(labels(2)).toEqual([...loadPage, "Measure the page's layout at phone width", "Take an evidence screenshot", "Record the verdict"]);
      expect(labels(3)).toEqual([
        ...loadPage,
        "Find the form",
        "Fill in the form's fields",
        "Submit the form",
        "Wait for the success text to appear",
        "Take an evidence screenshot",
        "Record the verdict",
      ]);
      for (const verdict of stored) {
        expect(verdict.evidence.trace).toEqual(toEvidenceTrace(steps.filter((s) => s.condition_id === verdict.condition_id)));
      }
      const load = steps.find((s) => s.label === "Load the page")!;
      expect(load.detail).toMatchObject({ http_status: 200, attempts: 1, load_ms: expect.any(Number), host: expect.any(String) });
      expect(steps.find((s) => s.label === "Take an evidence screenshot")!.detail).toMatchObject({ bytes: expect.any(Number), viewport_width: 1280 });
      expect(steps.find((s) => s.label === "Find the form")!.result).toEqual({ forms_found: 1, visible: true });
      for (const verdict of stored.slice(1)) {
        const [shot] = verdict.evidence.screenshots as string[];
        expect(shot).toMatch(new RegExp(`^data/evidence/${submission.id}/${verdict.evidence.check_kind === "dom_assert" ? 1 : "\\d"}-[a-z_]+-[\\w-]+\\.jpg$`));
        expect(fs.statSync(resolveEvidencePath(shot)).size).toBeGreaterThan(1_000);
      }
    },
    90_000,
  );

  it(
    "fails a page that scrolls sideways on a phone, with the other conditions still passing",
    async () => {
      const { submission } = setup(`${server.url}/bad-overflow.html`, WEBSITE);
      created.push(`data/evidence/${submission.id}`);
      const result = await verifySubmission(submission.id);
      expect(result.outcome).toBe("failed");
      expect(result.verdicts.map(verdictOutcome)).toEqual(["pass", "pass", "fail", "pass"]);
      expect(result.verdicts[2].reasoning).toContain("div.gallery");
    },
    90_000,
  );
});
