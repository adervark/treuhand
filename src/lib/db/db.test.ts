import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { makeContract, withTempDb, websiteContractInput } from "@/test/helpers";
import { closeDb, dbPath, getDb } from "./index";
import { MIGRATIONS, migrate } from "./schema";
import { createContract, getContract, listContracts, setPaypalRefs } from "./contracts";
import { getCondition, InvalidConditionError, listConditions } from "./conditions";
import { createSubmission, getLatestSubmission, getSubmission, listSubmissions } from "./submissions";
import { createVerdict, getVerdict, listVerdictsForContract, listVerdictsForSubmission } from "./verdicts";
import { getLedgerEntry, listLedgerEntries, recordLedgerEntry } from "./ledger";
import { createDispute, getActiveDispute, getDispute, listDisputes, updateDispute } from "./disputes";
import { listEvents, recordEvent } from "./events";
import { getIdentity, listIdentities, upsertIdentity } from "./identities";
import type { NewContractInput, PaypalRefs } from "@/lib/types";

const tempDb = withTempDb();

describe("connection and schema", () => {
  it("creates the file and its directory on first use", () => {
    expect(dbPath()).toBe(tempDb.path());
    expect(fs.existsSync(tempDb.path())).toBe(false);
    getDb();
    expect(fs.existsSync(tempDb.path())).toBe(true);
  });

  it("creates every table and records the schema version", () => {
    const db = getDb();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map((t) => t.name)
      .sort();
    expect(tables).toEqual(
      ["agent_tokens", "conditions", "contracts", "disputes", "events", "identities", "ledger", "receipts", "submissions", "verdicts"].sort(),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("migrates a file created at an earlier version without losing its rows", () => {
    const old = new Database(path.join(path.dirname(path.dirname(tempDb.path())), "old.db"));
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.pragma("user_version = 2");
    old.prepare(`INSERT INTO contracts (id, title, type, payer_email, worker_email, amount_cents, deadline_at, created_at, updated_at)
                 VALUES ('c1', 'Old', 'website_milestone', 'p@x.test', 'w@x.test', 100, '2030-01-01T00:00:00.000Z', 'now', 'now')`).run();
    expect(migrate(old)).toBe(MIGRATIONS.length);
    expect(old.prepare(`SELECT id, title, terms_hash FROM contracts`).all()).toEqual([{ id: "c1", title: "Old", terms_hash: null }]);
    expect(old.prepare(`SELECT COUNT(*) AS n FROM receipts`).get()).toEqual({ n: 0 });
    expect(migrate(old)).toBe(MIGRATIONS.length);
    old.close();
  });

  it("applies new migrations to a handle kept open across a dev reload", () => {
    const db = getDb();
    db.pragma("user_version = 2");
    db.exec(`DROP TABLE receipts; ALTER TABLE contracts DROP COLUMN terms_hash;`);
    (globalThis as { __clauseDb?: { version?: number } }).__clauseDb!.version = undefined; // as cached by older code
    expect(getDb()).toBe(db);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM receipts`).get()).toEqual({ n: 0 });
  });

  it("is safe to migrate repeatedly and keeps data across reopen", () => {
    const contract = makeContract();
    expect(migrate(getDb())).toBe(MIGRATIONS.length);
    expect(migrate(getDb())).toBe(MIGRATIONS.length);
    closeDb();
    expect(getContract(contract.id)).toEqual(contract);
  });

  it("enforces foreign keys", () => {
    expect(() => createSubmission({ contract_id: "missing", url: "https://example.com/" })).toThrow(/FOREIGN KEY/);
  });
});

describe("contracts", () => {
  it("creates a DRAFT with defaults, its conditions and a CONTRACT_CREATED event", () => {
    const contract = createContract(websiteContractInput(), "payer");
    expect(contract).toMatchObject({
      title: "Landing page",
      type: "website_milestone",
      state: "DRAFT",
      currency: "USD",
      amount_cents: 20000,
      payer_signed_at: null,
      worker_signed_at: null,
      paypal_order_id: null,
      paypal_authorization_id: null,
      paypal_capture_id: null,
      paypal_payout_batch_id: null,
    });
    expect(contract.created_at).toBe(contract.updated_at);
    expect(listConditions(contract.id)).toHaveLength(2);
    expect(listEvents(contract.id)).toMatchObject([
      { kind: "CONTRACT_CREATED", detail: { actor: "payer", title: "Landing page" } },
    ]);
  });

  it("rejects invalid input", () => {
    expect(() => createContract(websiteContractInput({ payer_email: "nope" }))).toThrow(ZodError);
    expect(() => createContract(websiteContractInput({ amount_cents: 0 }))).toThrow(ZodError);
    expect(() => createContract(websiteContractInput({ deadline_at: "tomorrow" }))).toThrow(ZodError);
    expect(listContracts()).toEqual([]);
  });

  it("rejects conditions of the wrong type and writes nothing", () => {
    expect(() =>
      createContract(
        websiteContractInput({
          conditions: [{ text: "PR merged", check_kind: "github_pr_merged", check_params: { repo: "a/b" } }],
        }),
      ),
    ).toThrow(InvalidConditionError);
    expect(listContracts()).toEqual([]);
  });

  it("returns null for an unknown id", () => {
    expect(getContract("missing")).toBeNull();
  });

  it("lists newest first and filters by state and party email", () => {
    const a = makeContract({ title: "A" });
    const b = makeContract({ title: "B", worker_email: "other@example.com" });
    expect(listContracts().map((c) => c.title)).toEqual(["B", "A"]);
    expect(listContracts({ email: "other@example.com" }).map((c) => c.id)).toEqual([b.id]);
    expect(listContracts({ email: "payer@example.com" })).toHaveLength(2);
    expect(listContracts({ state: "DRAFT" })).toHaveLength(2);
    expect(listContracts({ state: "PAID" })).toEqual([]);
    expect(listContracts({ state: "DRAFT", email: "worker@example.com" }).map((c) => c.id)).toEqual([a.id]);
  });

  it("sets only the given PayPal refs and never the state", () => {
    const contract = makeContract();
    setPaypalRefs(contract.id, { paypal_order_id: "ORDER-1" });
    const updated = setPaypalRefs(contract.id, {
      paypal_authorization_id: "AUTH-1",
      state: "PAID",
    } as Partial<PaypalRefs>);
    expect(updated).toMatchObject({
      paypal_order_id: "ORDER-1",
      paypal_authorization_id: "AUTH-1",
      paypal_capture_id: null,
      state: "DRAFT",
    });
    expect(() => setPaypalRefs("missing", { paypal_order_id: "x" })).toThrow(/not found/);
  });
});

describe("conditions", () => {
  it("round-trips check params and keeps position order", () => {
    const contract = makeContract({
      type: "code_bounty",
      conditions: [
        { text: "Merged", check_kind: "github_pr_merged", check_params: { repo: "acme/app" } },
        { text: "Refs #9", check_kind: "github_pr_references_issue", check_params: { repo: "acme/app", issue: 9 } },
      ],
    });
    const conditions = listConditions(contract.id);
    expect(conditions.map((c) => [c.position, c.check_kind, c.check_params])).toEqual([
      [0, "github_pr_merged", { repo: "acme/app" }],
      [1, "github_pr_references_issue", { repo: "acme/app", issue: 9 }],
    ]);
    expect(getCondition(conditions[1].id)).toEqual(conditions[1]);
    expect(getCondition("missing")).toBeNull();
  });

  it("stores ai_page_judgement and rejects the old ai_visual_judgement name", () => {
    const contract = makeContract({
      conditions: [
        { text: "Shows hours", check_kind: "ai_page_judgement", check_params: { criterion: "Are hours shown?" } },
      ],
    });
    expect(listConditions(contract.id).map((c) => [c.check_kind, c.check_params])).toEqual([
      ["ai_page_judgement", { criterion: "Are hours shown?" }],
    ]);
    const old = { text: "Looks right", check_kind: "ai_visual_judgement", check_params: { criterion: "?" } };
    expect(() => makeContract({ conditions: [old] as unknown as NewContractInput["conditions"] })).toThrow(ZodError);
  });

  it("applies param defaults", () => {
    const contract = makeContract({
      conditions: [{ text: "Phone width", check_kind: "responsive", check_params: { width: 375 } }],
    });
    const [condition] = listConditions(contract.id);
    expect(condition.check_kind === "responsive" && condition.check_params.width).toBe(375);
  });
});

describe("submissions", () => {
  it("creates, gets and lists newest first", () => {
    const contract = makeContract();
    const first = createSubmission({ contract_id: contract.id, url: "https://example.com/v1" });
    const second = createSubmission({ contract_id: contract.id, url: "https://example.com/v2" });
    expect(getSubmission(first.id)).toEqual(first);
    expect(listSubmissions(contract.id).map((s) => s.id)).toEqual([second.id, first.id]);
    expect(getLatestSubmission(contract.id)).toEqual(second);
    expect(getLatestSubmission(makeContract().id)).toBeNull();
    expect(getSubmission("missing")).toBeNull();
  });

  it("rejects a URL that is not a URL", () => {
    const contract = makeContract();
    expect(() => createSubmission({ contract_id: contract.id, url: "not a url" })).toThrow(ZodError);
  });
});

describe("verdicts", () => {
  it("round-trips booleans and evidence and lists by submission and contract", () => {
    const contract = makeContract();
    const [c1, c2] = listConditions(contract.id);
    const s1 = createSubmission({ contract_id: contract.id, url: "https://example.com/v1" });
    const s2 = createSubmission({ contract_id: contract.id, url: "https://example.com/v2" });
    const v1 = createVerdict({
      submission_id: s1.id,
      condition_id: c1.id,
      passed: false,
      confidence: 0.4,
      reasoning: "404",
      evidence: { responses: [{ status: 404 }] },
    });
    const v2 = createVerdict({
      submission_id: s2.id,
      condition_id: c2.id,
      passed: true,
      confidence: 1,
      reasoning: "form found",
      evidence: { screenshots: ["data/evidence/a.png"], selector: "form" },
    });

    expect(getVerdict(v1.id)).toEqual(v1);
    expect(getVerdict(v2.id)).toMatchObject({ passed: true, evidence: { screenshots: ["data/evidence/a.png"] } });
    expect(listVerdictsForSubmission(s1.id)).toEqual([v1]);
    expect(listVerdictsForContract(contract.id)).toEqual([v1, v2]);
    expect(getVerdict("missing")).toBeNull();
  });

  it("rejects confidence outside 0..1", () => {
    const contract = makeContract();
    const [condition] = listConditions(contract.id);
    const submission = createSubmission({ contract_id: contract.id, url: "https://example.com/" });
    expect(() =>
      createVerdict({
        submission_id: submission.id,
        condition_id: condition.id,
        passed: true,
        confidence: 1.5,
        reasoning: "",
        evidence: {},
      }),
    ).toThrow(ZodError);
  });
});

describe("ledger", () => {
  it("records entries and round-trips raw", () => {
    const contract = makeContract();
    const entry = recordLedgerEntry({
      contract_id: contract.id,
      kind: "AUTHORIZED",
      amount_cents: 20000,
      paypal_ref: "AUTH-1",
      raw: { id: "AUTH-1", status: "CREATED" },
    });
    expect(getLedgerEntry(entry.id)).toEqual(entry);
    expect(entry.raw).toEqual({ id: "AUTH-1", status: "CREATED" });
  });

  it("is idempotent on (kind, paypal_ref)", () => {
    const contract = makeContract();
    const first = recordLedgerEntry({ contract_id: contract.id, kind: "CAPTURED", amount_cents: 100, paypal_ref: "C" });
    const again = recordLedgerEntry({ contract_id: contract.id, kind: "CAPTURED", amount_cents: 100, paypal_ref: "C" });
    expect(again).toEqual(first);
    // same ref under a different kind is a different movement
    recordLedgerEntry({ contract_id: contract.id, kind: "REFUNDED", amount_cents: 100, paypal_ref: "C" });
    // entries without a ref are never merged
    recordLedgerEntry({ contract_id: contract.id, kind: "VOIDED", amount_cents: 0, paypal_ref: null });
    recordLedgerEntry({ contract_id: contract.id, kind: "VOIDED", amount_cents: 0, paypal_ref: null });
    expect(listLedgerEntries({ contract_id: contract.id }).map((e) => e.kind)).toEqual([
      "CAPTURED",
      "REFUNDED",
      "VOIDED",
      "VOIDED",
    ]);
  });

  it("lists all contracts or one, oldest first", () => {
    const a = makeContract();
    const b = makeContract();
    recordLedgerEntry({ contract_id: a.id, kind: "AUTHORIZED", amount_cents: 1, paypal_ref: "A" });
    recordLedgerEntry({ contract_id: b.id, kind: "AUTHORIZED", amount_cents: 2, paypal_ref: "B" });
    expect(listLedgerEntries().map((e) => e.paypal_ref)).toEqual(["A", "B"]);
    expect(listLedgerEntries({ contract_id: b.id }).map((e) => e.paypal_ref)).toEqual(["B"]);
  });

  it("rejects an unknown kind", () => {
    const contract = makeContract();
    expect(() =>
      recordLedgerEntry({
        contract_id: contract.id,
        kind: "STOLEN" as "CAPTURED",
        amount_cents: 1,
        paypal_ref: "X",
      }),
    ).toThrow(ZodError);
    expect(listLedgerEntries()).toEqual([]);
  });
});

describe("disputes", () => {
  it("opens with nulls in state OPEN", () => {
    const contract = makeContract();
    const dispute = createDispute({ contract_id: contract.id, opened_by: "worker", worker_argument: "It works" });
    expect(dispute).toMatchObject({
      opened_by: "worker",
      worker_argument: "It works",
      payer_argument: null,
      proposed_worker_cents: null,
      payer_accepted: null,
      worker_accepted: null,
      state: "OPEN",
    });
    expect(getDispute(dispute.id)).toEqual(dispute);
    expect(getDispute("missing")).toBeNull();
  });

  it("updates fields, round-trips acceptance booleans and tracks the active dispute", () => {
    const contract = makeContract();
    const dispute = createDispute({ contract_id: contract.id, opened_by: "payer" });
    expect(getActiveDispute(contract.id)?.id).toBe(dispute.id);

    updateDispute(dispute.id, {
      payer_argument: "Form is broken",
      proposed_worker_cents: 14000,
      proposal_reasoning: "Most conditions passed",
      state: "PROPOSED",
    });
    updateDispute(dispute.id, { payer_accepted: true, worker_accepted: false });
    const updated = getDispute(dispute.id)!;
    expect(updated).toMatchObject({
      payer_argument: "Form is broken",
      worker_argument: null,
      proposed_worker_cents: 14000,
      proposal_reasoning: "Most conditions passed",
      payer_accepted: true,
      worker_accepted: false,
      state: "PROPOSED",
    });
    expect(getActiveDispute(contract.id)?.id).toBe(dispute.id);

    expect(updateDispute(dispute.id, { worker_accepted: null, state: "SETTLED" })).toMatchObject({
      worker_accepted: null,
      state: "SETTLED",
    });
    expect(getActiveDispute(contract.id)).toBeNull();
    expect(listDisputes(contract.id)).toHaveLength(1);
  });

  it("rejects bad updates", () => {
    const contract = makeContract();
    const dispute = createDispute({ contract_id: contract.id, opened_by: "payer" });
    expect(() => updateDispute("missing", { state: "SETTLED" })).toThrow(/not found/);
    expect(() => updateDispute(dispute.id, { state: "WON" as "SETTLED" })).toThrow(ZodError);
    expect(() => updateDispute(dispute.id, { proposed_worker_cents: -1 })).toThrow(ZodError);
    expect(getDispute(dispute.id)).toEqual(dispute);
  });
});

describe("events", () => {
  it("appends and lists oldest first with detail round-tripped", () => {
    const contract = makeContract();
    recordEvent({ contract_id: contract.id, kind: "TERMS_EDITED", detail: { fields: ["title"], nested: { a: 1 } } });
    const events = listEvents(contract.id);
    expect(events.map((e) => e.kind)).toEqual(["CONTRACT_CREATED", "TERMS_EDITED"]);
    expect(events[1].detail).toEqual({ fields: ["title"], nested: { a: 1 } });
  });
});

describe("identities", () => {
  it("upserts, gets and lists payer first", () => {
    upsertIdentity({ role: "worker", display_name: "W", email: "w@example.com" });
    upsertIdentity({ role: "payer", display_name: "P", email: "p@example.com" });
    upsertIdentity({ role: "payer", display_name: "P2", email: "p2@example.com" });
    expect(getIdentity("payer")).toEqual({ role: "payer", display_name: "P2", email: "p2@example.com" });
    expect(listIdentities().map((i) => i.role)).toEqual(["payer", "worker"]);
  });

  it("returns null before seeding and rejects a bad email", () => {
    expect(getIdentity("worker")).toBeNull();
    expect(() => upsertIdentity({ role: "worker", display_name: "W", email: "nope" })).toThrow(ZodError);
  });
});
