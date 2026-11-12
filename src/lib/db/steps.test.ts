/** Storage for the verifier's work log (verification_steps, migration 5). */
import { describe, expect, it } from "vitest";
import { websiteContractInput, withTempDb } from "@/test/helpers";
import { createContract } from "./contracts";
import { getDb } from "./index";
import { deleteStepsForSubmission, finishStep, listStepsForContract, listStepsForSubmission, startStep } from "./steps";
import { createSubmission } from "./submissions";

withTempDb();

const at = "2026-11-12T10:00:00.000Z";

function start(submissionId: string, label: string, conditionId: string | null = "cond") {
  return startStep({ submission_id: submissionId, condition_id: conditionId, kind: "network", label, started_at: at, detail: { host: "x" } });
}

describe("verification steps", () => {
  it("numbers steps per submission, starts them running, and ends each one once", () => {
    const contract = createContract(websiteContractInput());
    const a = createSubmission({ contract_id: contract.id, url: "https://a.example/" });
    const b = createSubmission({ contract_id: contract.id, url: "https://b.example/" });
    const first = start(a.id, "one");
    const second = start(a.id, "two", null);
    const other = start(b.id, "three");
    expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ status: "running", duration_ms: null, detail: { host: "x" }, result: {}, started_at: at });

    expect(finishStep(first.id, { status: "done", duration_ms: 12.6, detail: { host: "x", http_status: 200 }, result: { ok: true } })).toBe(true);
    expect(finishStep(first.id, { status: "failed", duration_ms: 99, detail: {}, result: {} })).toBe(false);
    expect(listStepsForSubmission(a.id)).toEqual([
      { ...first, status: "done", duration_ms: 13, detail: { host: "x", http_status: 200 }, result: { ok: true } },
      second,
    ]);
    expect(listStepsForContract(contract.id).map((s) => [s.submission_id, s.seq])).toEqual([
      [a.id, 1],
      [a.id, 2],
      [b.id, 1],
    ]);
  });

  it("deletes one submission's steps so a re-run starts again at seq 1", () => {
    const contract = createContract(websiteContractInput());
    const a = createSubmission({ contract_id: contract.id, url: "https://a.example/" });
    const b = createSubmission({ contract_id: contract.id, url: "https://b.example/" });
    start(a.id, "one");
    start(a.id, "two");
    start(b.id, "kept");
    expect(deleteStepsForSubmission(a.id)).toBe(2);
    expect(listStepsForSubmission(a.id)).toEqual([]);
    expect(start(a.id, "again").seq).toBe(1);
    expect(listStepsForSubmission(b.id).map((s) => s.label)).toEqual(["kept"]);
  });

  it("refuses to read a row with an unknown kind or status, and keeps only plain facts", () => {
    const contract = createContract(websiteContractInput());
    const a = createSubmission({ contract_id: contract.id, url: "https://a.example/" });
    const step = start(a.id, "one");
    getDb().prepare(`UPDATE verification_steps SET detail = ? WHERE id = ?`).run(JSON.stringify({ ok: 1, nested: { x: 1 }, list: [1] }), step.id);
    expect(listStepsForSubmission(a.id)[0].detail).toEqual({ ok: 1 });
    getDb().prepare(`UPDATE verification_steps SET kind = 'poetry' WHERE id = ?`).run(step.id);
    expect(() => listStepsForSubmission(a.id)).toThrow(/unknown kind/);
  });
});
