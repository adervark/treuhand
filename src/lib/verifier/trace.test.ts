/**
 * The work-log recorder: a no-op outside a scope, steps written as they
 * start and end, concurrency, failures, closing a scope, and that a storage
 * failure never reaches the check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { websiteContractInput, withTempDb } from "@/test/helpers";
import { createContract } from "@/lib/db/contracts";
import { getDb } from "@/lib/db/index";
import { listStepsForSubmission } from "@/lib/db/steps";
import { createSubmission } from "@/lib/db/submissions";
import { note, runWithTrace, step, toEvidenceTrace } from "./trace";

withTempDb();

afterEach(() => {
  vi.restoreAllMocks();
});

function submission() {
  const contract = createContract(websiteContractInput());
  return createSubmission({ contract_id: contract.id, url: "https://bakery.example/" });
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("outside a trace scope", () => {
  it("step just runs its function, note does nothing, and nothing is stored", async () => {
    const { id } = submission();
    const seen: unknown[] = [];
    const value = await step("network", "Request the page", (h) => {
      h.detail({ host: "x" });
      h.result({ ok: true });
      h.fail();
      seen.push("ran");
      return 7;
    });
    note("guard", "Note something");
    expect(value).toBe(7);
    expect(seen).toEqual(["ran"]);
    expect(listStepsForSubmission(id)).toEqual([]);
    await expect(step("network", "Throw", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("runWithTrace", () => {
  it("records steps in order with seq, timing and facts, and returns them", async () => {
    const { id } = submission();
    const { value, steps } = await runWithTrace(id, "cond-1", async () => {
      await step(
        "guard",
        "Check the address",
        async (h) => {
          h.detail({ addresses: 2, skipped: undefined, weird: Number.NaN, long: "x".repeat(400) });
          h.result({ vote: "pass" });
        },
        { host: "bakery.example" },
      );
      note("decision", "Record the verdict", { check_kind: "http_ok" }, { outcome: "pass", confidence: 1 });
      return "done";
    });
    expect(value).toBe("done");
    const stored = listStepsForSubmission(id);
    expect(stored).toEqual(steps);
    expect(stored.map((s) => [s.seq, s.kind, s.label, s.status, s.condition_id])).toEqual([
      [1, "guard", "Check the address", "done", "cond-1"],
      [2, "decision", "Record the verdict", "done", "cond-1"],
    ]);
    expect(stored[0].detail).toEqual({ host: "bakery.example", addresses: 2, weird: null, long: expect.any(String) });
    expect((stored[0].detail.long as string).length).toBeLessThanOrEqual(160);
    expect(stored[0].result).toEqual({ vote: "pass" });
    expect(stored[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(stored[0].started_at))).toBe(false);
    expect(stored[1].result).toEqual({ outcome: "pass", confidence: 1 });
    expect(toEvidenceTrace(steps)[0]).toEqual({
      seq: 1,
      kind: "guard",
      label: "Check the address",
      status: "done",
      started_at: stored[0].started_at,
      duration_ms: stored[0].duration_ms,
      detail: stored[0].detail,
      result: { vote: "pass" },
    });
  });

  it("writes a step as running when it starts, so a reader sees the run as far as it has got", async () => {
    const { id } = submission();
    const gate = deferred();
    const running = runWithTrace(id, null, () => step("browser", "Load the page", () => gate.promise, { host: "x" }));
    await Promise.resolve();
    expect(listStepsForSubmission(id)).toMatchObject([{ status: "running", duration_ms: null, detail: { host: "x" }, result: {} }]);
    gate.resolve();
    await running;
    expect(listStepsForSubmission(id)).toMatchObject([{ status: "done", duration_ms: expect.any(Number) }]);
  });

  it("records concurrent steps independently, in the order they started", async () => {
    const { id } = submission();
    const gates = [deferred(), deferred(), deferred()];
    const run = runWithTrace(id, "c", () =>
      Promise.allSettled(
        gates.map((gate, i) =>
          step("model", `Ask reviewer ${i + 1}`, async (h) => {
            await gate.promise;
            h.result({ vote: i === 1 ? "fail" : "pass" });
            if (i === 2) throw new Error("model down");
          }),
        ),
      ),
    );
    await Promise.resolve();
    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();
    await run;
    expect(listStepsForSubmission(id).map((s) => [s.seq, s.label, s.status, s.result])).toEqual([
      [1, "Ask reviewer 1", "done", { vote: "pass" }],
      [2, "Ask reviewer 2", "done", { vote: "fail" }],
      [3, "Ask reviewer 3", "failed", { vote: "pass", error: "model down" }],
    ]);
  });

  it("a throwing step is failed with the error in result, and the same error is rethrown", async () => {
    const { id } = submission();
    const error = new TypeError("no such host");
    let caught: unknown;
    await runWithTrace(id, "c", async () => {
      try {
        await step("guard", "Check the address", () => {
          throw error;
        });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBe(error);
    expect(listStepsForSubmission(id)).toMatchObject([{ status: "failed", detail: {}, result: { error: "no such host" } }]);
  });

  it("handle.fail() ends a step that returned normally as failed", async () => {
    const { id } = submission();
    await runWithTrace(id, "c", () => step("screenshot", "Take an evidence screenshot", (h) => h.fail()));
    expect(listStepsForSubmission(id)).toMatchObject([{ status: "failed" }]);
  });

  it("closing marks running steps as cut off and ignores anything recorded later", async () => {
    const { id } = submission();
    const gate = deferred();
    const late = deferred();
    let handleAfterClose: (() => void) | undefined;
    const { steps } = await runWithTrace(id, "c", async () => {
      // Left running in the background, like a runner the per-check time limit gave up on.
      void step("browser", "Load the page", async (h) => {
        handleAfterClose = () => h.detail({ late: true });
        await gate.promise;
        await step("measure", "Measure after the cut-off", () => undefined);
        note("guard", "Note after the cut-off");
        late.resolve();
      });
      note("guard", "Stop the check at its time limit", {}, { timed_out: true });
    });
    expect(steps.map((s) => [s.label, s.status, s.detail])).toEqual([
      ["Load the page", "failed", { cut_off: true }],
      ["Stop the check at its time limit", "done", {}],
    ]);
    handleAfterClose?.();
    gate.resolve();
    await late.promise;
    const stored = listStepsForSubmission(id);
    expect(stored).toEqual(steps);
    expect(stored[0].duration_ms).toEqual(expect.any(Number));
  });

  it("closes the scope and rethrows when the wrapped function throws", async () => {
    const { id } = submission();
    const gate = deferred();
    const run = runWithTrace(id, "c", async () => {
      void step("browser", "Load the page", () => gate.promise);
      await Promise.resolve();
      throw new Error("crashed");
    });
    await expect(run).rejects.toThrow("crashed");
    expect(listStepsForSubmission(id)).toMatchObject([{ status: "failed", detail: { cut_off: true } }]);
    gate.resolve();
  });

  it("a storage failure is logged once and never breaks or changes the wrapped function", async () => {
    const { id } = submission();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    getDb().exec("DROP TABLE verification_steps");
    const { value, steps } = await runWithTrace(id, "c", async () => {
      const a = await step("network", "Request the page", () => 1);
      note("guard", "Note something");
      const b = await step("measure", "Measure", async (h) => {
        h.detail({ x: 1 });
        return 2;
      });
      await expect(step("measure", "Throw", () => Promise.reject(new Error("real error")))).rejects.toThrow("real error");
      return a + b;
    });
    expect(value).toBe(3);
    expect(steps).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("work log");
  });
});
