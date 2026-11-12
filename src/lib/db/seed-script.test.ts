/** `pnpm db:seed` (scripts/db-seed.ts), run as a real process against a temp database. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { getIdentity } from "@/lib/db/identities";
import { withTempDb } from "@/test/helpers";

const db = withTempDb();

function seed(env: Record<string, string>, ...args: string[]) {
  const { DEMO_PAYER_EMAIL: _p, DEMO_WORKER_EMAIL: _w, ...base } = process.env;
  const root = process.cwd();
  return spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "scripts", "db-seed.ts"), ...args], {
    cwd: root,
    env: { ...base, CLAUSE_DB_PATH: db.path(), ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const seededEmails = () => {
  closeDb();
  return [getIdentity("payer")?.email ?? null, getIdentity("worker")?.email ?? null];
};

describe("db:seed", () => {
  it("stops with an error naming the unset demo email, and seeds nothing", () => {
    const run = seed({ DEMO_PAYER_EMAIL: "buyer@sandbox.test" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("DEMO_WORKER_EMAIL is not set");
    expect(run.stderr).not.toContain("DEMO_PAYER_EMAIL");
    expect(seededEmails()).toEqual([null, null]);
  }, 30_000);

  it("seeds placeholder identities only when asked to with --placeholder-identities", () => {
    const run = seed({}, "--placeholder-identities");
    expect(run.status, run.stderr).toBe(0);
    expect(seededEmails()).toEqual(["payer@example.com", "worker@example.com"]);
  }, 30_000);

  it("seeds the emails it is given", () => {
    const run = seed({ DEMO_PAYER_EMAIL: "buyer@sandbox.test", DEMO_WORKER_EMAIL: "seller@sandbox.test" });
    expect(run.status, run.stderr).toBe(0);
    expect(seededEmails()).toEqual(["buyer@sandbox.test", "seller@sandbox.test"]);
  }, 30_000);
});
