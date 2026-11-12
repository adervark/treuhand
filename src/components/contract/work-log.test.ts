import { describe, expect, it } from "vitest";
import type { TraceStep } from "@/lib/contract/service";
import {
  clockOffset,
  factLabel,
  factText,
  formatDuration,
  formatStepTime,
  groupSteps,
  logPhase,
  logSummary,
  MAX_ELAPSED_MS,
  redactSteps,
  runMetrics,
  serverTime,
  stepBar,
  stepElapsed,
  stepState,
  stepWindow,
  visibleSteps,
  type LogPhase,
} from "./work-log";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

let seq = 0;
function step(p: Partial<TraceStep> & { start: number }): TraceStep {
  seq++;
  const { start, ...rest } = p;
  return {
    id: `s${seq}`,
    submission_id: "sub1",
    condition_id: "c1",
    seq,
    kind: "browser",
    label: "Load the page in an isolated browser",
    status: "done",
    started_at: at(start),
    duration_ms: 100,
    detail: {},
    result: {},
    ...rest,
  };
}

describe("logPhase", () => {
  it("hides a queued row, runs a checking or voting row, decides the rest", () => {
    expect(logPhase({ outcome: "queued" })).toBe("hidden");
    expect(logPhase({ outcome: "checking" })).toBe("running");
    expect(logPhase({ outcome: "checking", voting: 1 })).toBe("running");
    expect(logPhase({ outcome: "pass", voting: 0 })).toBe("running");
    expect(logPhase({ outcome: "pass" })).toBe("decided");
    expect(logPhase({ outcome: "fail" })).toBe("decided");
    expect(logPhase({ outcome: "inconclusive" })).toBe("decided");
    expect(logPhase({ outcome: "not_run" })).toBe("decided");
  });
});

describe("redactSteps", () => {
  const vote = step({ start: 0, kind: "model", detail: { reviewer: "Strict reader" }, result: { vote: "pass", confidence: 0.9 } });
  const decision = step({ start: 10, kind: "decision", result: { decision: "pass" } });
  const load = step({ start: 0, detail: { status: 200 } });

  it("shows nothing for a hidden row", () => {
    expect(redactSteps([load, vote, decision], "hidden")).toEqual([]);
  });

  it("drops decisions and result facts while running, keeping detail facts", () => {
    const out = redactSteps([load, vote, decision], "running");
    expect(out.map((s) => s.id)).toEqual([load.id, vote.id]);
    expect(out[1].result).toEqual({});
    expect(out[1].detail).toEqual({ reviewer: "Strict reader" });
    // The input is not mutated.
    expect(vote.result).toEqual({ vote: "pass", confidence: 0.9 });
  });

  it("shows everything once decided", () => {
    expect(redactSteps([load, vote, decision], "decided")).toEqual([load, vote, decision]);
  });
});

describe("groupSteps and visibleSteps", () => {
  const a2 = step({ start: 50, condition_id: "a", seq: 2 });
  const a1 = step({ start: 0, condition_id: "a", seq: 1 });
  const b = step({ start: 200, condition_id: "b", seq: 3, kind: "model", result: { vote: "fail" } });
  const bDecision = step({ start: 300, condition_id: "b", seq: 4, kind: "decision", result: { decision: "fail" } });
  const sign = step({ start: 400, condition_id: null, seq: 5, kind: "record", result: { outcome: "failed" } });
  const other = step({ start: 0, submission_id: "sub2", condition_id: "a", seq: 1 });

  it("groups one submission's steps by condition in start order, run-level steps apart", () => {
    const g = groupSteps([sign, b, a2, other, a1, bDecision], "sub1");
    expect(g.byCondition.get("a")?.map((s) => s.seq)).toEqual([1, 2]);
    expect(g.byCondition.get("b")?.map((s) => s.seq)).toEqual([3, 4]);
    expect(g.run.map((s) => s.id)).toEqual([sign.id]);
    expect([...g.byCondition.values()].flat()).not.toContain(other);
  });

  it("applies each row's phase, and hides run-level results until every check is decided", () => {
    const g = groupSteps([a1, a2, b, bDecision, sign], "sub1");
    const running = new Map<string, LogPhase>([
      ["a", "decided"],
      ["b", "running"],
    ]);
    const out = visibleSteps(g, running);
    expect(out.map((s) => s.seq)).toEqual([1, 2, 3, 5]);
    expect(out.find((s) => s.id === b.id)?.result).toEqual({});
    expect(out.find((s) => s.id === sign.id)?.result).toEqual({});

    const decided = new Map<string, LogPhase>([
      ["a", "decided"],
      ["b", "decided"],
    ]);
    const all = visibleSteps(g, decided);
    expect(all.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.find((s) => s.id === sign.id)?.result).toEqual({ outcome: "failed" });
  });

  it("shows nothing for a condition with no phase (queued)", () => {
    const g = groupSteps([a1, b], "sub1");
    expect(visibleSteps(g, new Map([["a", "decided"]])).map((s) => s.id)).toEqual([a1.id]);
  });
});

describe("clock", () => {
  it("computes the server-minus-client offset and applies it", () => {
    const offset = clockOffset(at(5000), T0);
    expect(offset).toBe(5000);
    expect(serverTime(T0 + 100, offset)).toBe(T0 + 5100);
    expect(clockOffset("not a date", T0)).toBe(0);
  });

  it("times a running step against the server clock, never negative or absurd", () => {
    const running = step({ start: 1000, status: "running", duration_ms: null });
    expect(stepElapsed(running, T0 + 3400, true)).toBe(2400);
    // Client clock behind the step's start: zero, not negative.
    expect(stepElapsed(running, T0, true)).toBe(0);
    expect(stepElapsed(running, T0 + 1000 + MAX_ELAPSED_MS + 1, true)).toBeNull();
    expect(stepElapsed(running, T0 + 3400, false)).toBeNull();
    expect(stepElapsed(running, null, true)).toBeNull();
    expect(stepElapsed(step({ start: 0, duration_ms: 812 }), T0 + 99_999, true)).toBe(812);
  });

  it("calls a step still running after its run ended cut off", () => {
    const running = step({ start: 0, status: "running", duration_ms: null });
    expect(stepState(running, true)).toBe("running");
    expect(stepState(running, false)).toBe("cut_off");
    expect(stepState(step({ start: 0, status: "failed" }), false)).toBe("failed");
    // The verifier ends a step its check's time limit cut short as failed with detail.cut_off.
    expect(stepState(step({ start: 0, status: "failed", detail: { cut_off: true } }), true)).toBe("cut_off");
    expect(stepState(step({ start: 0, status: "failed", detail: { cut_off: false } }), true)).toBe("failed");
  });
});

describe("waterfall", () => {
  it("spans first start to last end, and to server now while a step runs", () => {
    const steps = [step({ start: 0, duration_ms: 400 }), step({ start: 500, duration_ms: 1500 })];
    expect(stepWindow(steps, null, false)).toEqual({ start: T0, end: T0 + 2000 });
    const live = [...steps, step({ start: 2000, status: "running", duration_ms: null })];
    expect(stepWindow(live, T0 + 3000, true)).toEqual({ start: T0, end: T0 + 3000 });
    expect(stepWindow([], null, false)).toBeNull();
  });

  it("places bars by offset and width, concurrent steps side by side in time", () => {
    const guard = step({ start: 0, duration_ms: 1000 });
    const r1 = step({ start: 1000, kind: "model", status: "running", duration_ms: null });
    const r2 = step({ start: 1000, kind: "model", status: "running", duration_ms: null });
    const now = T0 + 4000;
    const w = stepWindow([guard, r1, r2], now, true)!;
    expect(stepBar(guard, w, now, true)).toEqual({ offset: 0, width: 0.25 });
    expect(stepBar(r1, w, now, true)).toEqual({ offset: 0.25, width: 0.75 });
    expect(stepBar(r2, w, now, true)).toEqual(stepBar(r1, w, now, true));
  });

  it("gives a zero-length window one full bar and never overflows", () => {
    const s = step({ start: 0, duration_ms: 0 });
    expect(stepBar(s, { start: T0, end: T0 }, null, false)).toEqual({ offset: 0, width: 1 });
    const late = step({ start: 900, duration_ms: 500 });
    const bar = stepBar(late, { start: T0, end: T0 + 1000 }, null, false);
    expect(bar.offset).toBe(0.9);
    expect(bar.width).toBeCloseTo(0.1, 10);
    expect(bar.offset + bar.width).toBeLessThanOrEqual(1);
  });
});

describe("runMetrics", () => {
  it("counts steps, time per kind, running and failed, and the wall clock", () => {
    const steps = [
      step({ start: 0, kind: "guard", duration_ms: 20 }),
      step({ start: 20, kind: "browser", duration_ms: 980 }),
      step({ start: 1000, kind: "model", status: "running", duration_ms: null }),
      step({ start: 1000, kind: "model", status: "failed", duration_ms: 1500 }),
      step({ start: 1000, kind: "model", status: "running", duration_ms: null }),
    ];
    const m = runMetrics(steps, T0 + 3000, true);
    expect(m.total).toBe(5);
    expect(m.running).toBe(2);
    expect(m.failed).toBe(1);
    expect(m.elapsedMs).toBe(3000);
    expect(m.byKind).toEqual([
      { kind: "guard", count: 1, ms: 20 },
      { kind: "browser", count: 1, ms: 980 },
      { kind: "model", count: 3, ms: 2000 + 1500 + 2000 },
    ]);

    // After the run: the running steps were cut off and count as failed; their time is unknown.
    const after = runMetrics(steps, T0 + 9000, false);
    expect(after.running).toBe(0);
    expect(after.failed).toBe(3);
    expect(after.elapsedMs).toBe(2500);
  });

  it("is empty without steps", () => {
    expect(runMetrics([], null, false)).toEqual({ total: 0, running: 0, failed: 0, elapsedMs: null, byKind: [] });
  });
});

describe("formatting", () => {
  it("formats durations as ms, tenths of a second, then m:ss", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(340.4)).toBe("340 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(4249)).toBe("4.2 s");
    expect(formatDuration(59_990)).toBe("59.9 s");
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(-5)).toBe("0 ms");
  });

  it("ticks a running figure in tenths without changing unit", () => {
    expect(formatDuration(340, true)).toBe("0.3 s");
    expect(formatDuration(1290, true)).toBe("1.2 s");
    expect(formatDuration(61_000, true)).toBe("1:01");
  });

  it("gives a step's start to the millisecond", () => {
    expect(formatStepTime("2026-11-12T10:04:05.083Z", "utc")).toBe("Nov 12 10:04:05.083 UTC");
    expect(formatStepTime("nonsense", "utc")).toBe("nonsense");
  });

  it("renders facts as text", () => {
    expect(factText(null)).toBe("none");
    expect(factText(true)).toBe("yes");
    expect(factText(200)).toBe("200");
    expect(factText("<b>x</b>")).toBe("<b>x</b>");
    expect(factLabel("status_code")).toBe("status code");
  });

  it("summarises a check's log", () => {
    expect(logSummary({ total: 9, running: 0, failed: 1, elapsedMs: 4200, byKind: [] })).toBe("9 steps · 4.2 s · 1 failed step");
    expect(logSummary({ total: 1, running: 0, failed: 0, elapsedMs: 80, byKind: [] })).toBe("1 step · 80 ms");
  });
});
