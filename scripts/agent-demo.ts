/**
 * TEST-ONLY demo: a buyer's agent and a worker's agent run a whole contract
 * through Proviso's MCP tools, each through a real MCP client from the SDK,
 * against a running app on a scratch database. Not part of the app.
 *
 *   CLAUSE_DB_PATH=/tmp/demo.db pnpm exec tsx scripts/agent-demo.ts [--app http://localhost:3400] [--url https://example.com/]
 *
 * The app under test must run with the same CLAUSE_DB_PATH, seeded
 * (`db:seed --placeholder-identities` is enough) and configured for the
 * drafter and the verifier (DeepSeek). The script refuses data/clause.db.
 *
 * - The buyer's agent connects over Streamable HTTP to `<app>/api/mcp`.
 * - The worker's agent connects over stdio to scripts/mcp-server.ts, which
 *   relays to the same endpoint.
 * - Both tokens are created here with signing allowed (scripts/agent-token.ts
 *   --allow-sign), so the agents sign; by default a person signs.
 * - Funding stays human: the buyer's agent asks for the funding instructions,
 *   then the script stands in for the payer's approval in PayPal with the
 *   fixture helper `scripts/flow-e2e.ts fund`, which writes a made-up hold.
 *   NO MONEY IS HELD, so the capture after a pass fails at PayPal (404) and
 *   shows up as the money summary's last_failure.
 * - The worker submits a real public URL; the app's verifier checks it.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAgentToken } from "@/lib/agent/tokens";
import { closeDb } from "@/lib/db";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP = option("--app", "http://localhost:3400").replace(/\/+$/, "");
const WORK_URL = option("--url", "https://example.com/");

function requireSeparateDb(): string {
  const target = process.env.CLAUSE_DB_PATH;
  const real = path.join(ROOT, "data", "clause.db");
  if (!target || target === ":memory:" || path.resolve(target) === path.resolve(real)) {
    console.error("Set CLAUSE_DB_PATH to the scratch database the app under test uses. This script never touches data/clause.db.");
    process.exit(1);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

let step = 0;
function heading(who: string, what: string): void {
  step += 1;
  console.log(`\n[${String(step).padStart(2, "0")}] ${who}: ${what}`);
}
function line(text: string): void {
  console.log(`     ${text}`);
}
function human(text: string): void {
  console.log(`     HUMAN STEP: ${text}`);
}
function clip(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

class ToolError extends Error {}

/** Calls a tool and returns its JSON; a tool error throws with the API's error body. */
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new ToolError(`${name} -> ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

async function buyerClient(token: string): Promise<Client> {
  const client = new Client({ name: "buyer-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${APP}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function workerClient(token: string): Promise<Client> {
  const client = new Client({ name: "worker-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: TSX,
      args: [path.join(ROOT, "scripts", "mcp-server.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PROVISO_URL: APP, PROVISO_TOKEN: token },
      stderr: "inherit",
    }),
  );
  return client;
}

// ---------------------------------------------------------------------------
// Shapes read from the tools (only the fields the demo prints)
// ---------------------------------------------------------------------------

interface Draft {
  kind: "draft" | "refusal";
  contract?: Record<string, unknown> & { title: string; conditions: { text: string; check_kind: string }[]; notes: string[] };
  vague_conditions?: { condition: string; reason: string; suggested_rewrite: string | null }[];
}
interface ContractView {
  contract: { id: string; state: string; amount_cents: number; currency: string; deadline_at: string; terms_sha256: string | null };
  page_url: string;
  next_step: string;
  you_can_now: string[];
  needs_a_person: { action: string; why: string }[];
  conditions: { position: number; text: string; check_kind: string; check_params: unknown }[];
  notes: string[];
}
interface PanelVote {
  reviewer: string;
  vote: string;
  confidence: number | null;
  reasoning: string;
}
interface Verification {
  status: string;
  state: string;
  message: string | null;
  submission?: { id: string; url: string };
  checks?: {
    position: number;
    condition: string;
    check_kind: string;
    outcome: string;
    confidence?: number;
    reasoning?: string;
    evidence_links?: string[];
    reviewer_panel?: { size: number; decision: string; agreement: number; votes: PanelVote[] } | null;
  }[];
  receipt: { receipt_sha256: string; signature: { key_fingerprint: string } } | null;
  next_step: string;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const db = requireSeparateDb();
  console.log(`Proviso agent demo against ${APP} (database ${db})`);

  const buyerToken = createAgentToken({ role: "payer", allowSign: true, label: "demo buyer agent" });
  const workerToken = createAgentToken({ role: "worker", allowSign: true, label: "demo worker agent" });
  closeDb();
  console.log(`Created agent tokens ${buyerToken.row.id} (payer: ${buyerToken.row.scopes.join(",")}) and ${workerToken.row.id} (worker: ${workerToken.row.scopes.join(",")}).`);

  const buyer = await buyerClient(buyerToken.token);
  const worker = await workerClient(workerToken.token);
  try {
    heading("buyer agent", `connected over Streamable HTTP (${buyer.getProtocolEra()} protocol era)`);
    const tools = await buyer.listTools();
    line(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
    const me = await call<{ role: string; scopes: string[]; cannot: string[] }>(buyer, "whoami");
    line(`acts as the ${me.role}, scopes ${me.scopes.join(", ")}; cannot: ${me.cannot.join("; ")}`);

    heading("worker agent", `connected over stdio through scripts/mcp-server.ts (${worker.getProtocolEra()} protocol era)`);
    const wme = await call<{ role: string; scopes: string[] }>(worker, "whoami");
    line(`acts as the ${wme.role}, scopes ${wme.scopes.join(", ")}`);

    const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const prompt =
      `I'll pay $25.00 USD for a one-page website at a public URL, delivered by ${deadline} 23:59 UTC. ` +
      `It's done when: the page loads successfully; a paragraph on the page contains the words "documentation ` +
      `examples"; and the page explains to a visitor that the domain is meant for use as an example in documentation.`;
    heading("buyer agent", "draft_contract from plain English (the real drafter)");
    line(`prompt: ${prompt}`);
    const draft = await call<Draft>(buyer, "draft_contract", { prompt, type: "website_milestone" });
    if (draft.kind !== "draft" || !draft.contract) {
      line(`the drafter refused: ${JSON.stringify(draft.vague_conditions)}`);
      throw new Error("The drafter refused the deal; rerun with a clearer prompt.");
    }
    line(`title: ${draft.contract.title}; amount_cents ${String(draft.contract.amount_cents)} ${String(draft.contract.currency)}; deadline ${String(draft.contract.deadline_at)}`);
    for (const c of draft.contract.conditions) line(`condition (${c.check_kind}): ${c.text}`);
    for (const n of draft.contract.notes) line(`drafter's note: ${clip(n)}`);

    heading("buyer agent", "create_contract from the draft");
    const created = await call<{ contract: { id: string; state: string }; page_url: string; next_step: string }>(
      buyer,
      "create_contract",
      draft.contract,
    );
    const id = created.contract.id;
    line(`contract ${id} is ${created.contract.state}: ${created.page_url}`);
    line(`next: ${created.next_step}`);

    heading("worker agent", "get_contract: reads the tests before agreeing");
    const asWorker = await call<ContractView>(worker, "get_contract", { contract_id: id });
    for (const c of asWorker.conditions) line(`${c.position}. [${c.check_kind}] ${c.text} ${JSON.stringify(c.check_params)}`);
    line(`you_can_now: ${asWorker.you_can_now.join(", ")}`);

    heading("buyer agent + worker agent", "sign_contract (both tokens were created with --allow-sign)");
    const s1 = await call<{ next_step: string }>(buyer, "sign_contract", { contract_id: id });
    line(`buyer: ${s1.next_step}`);
    const s2 = await call<{ contract: { state: string }; next_step: string }>(worker, "sign_contract", { contract_id: id });
    line(`worker: ${s2.contract.state}. ${s2.next_step}`);

    heading("buyer agent", "get_funding_instructions (an agent can never fund)");
    const funding = await call<{
      can_be_funded_now: boolean;
      amount_cents: number;
      currency: string;
      funding_page_url: string;
      instructions_for_the_payer: string[];
    }>(buyer, "get_funding_instructions", { contract_id: id });
    line(`can be funded now: ${funding.can_be_funded_now}; ${funding.amount_cents} cents ${funding.currency} at ${funding.funding_page_url}`);
    for (const instruction of funding.instructions_for_the_payer) human(instruction);
    try {
      await call(buyer, "fund_contract", { contract_id: id });
    } catch (err) {
      line(`(calling a funding tool anyway fails: ${clip((err as Error).message, 160)})`);
    }

    heading("demo stand-in for the payer", "PayPal approval simulated with scripts/flow-e2e.ts fund (made-up hold, no money)");
    const funded = execFileSync(TSX, [path.join(ROOT, "scripts", "flow-e2e.ts"), "fund", id], {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
    });
    line(funded.trim());

    heading("worker agent", `submit_work ${WORK_URL}`);
    const submitted = await call<{ submission_id: string; state: string; next_step: string }>(worker, "submit_work", {
      contract_id: id,
      url: WORK_URL,
    });
    line(`submission ${submitted.submission_id}; contract ${submitted.state}. ${submitted.next_step}`);

    heading("worker agent", "get_verification, polled until the run finishes");
    const started = Date.now();
    let verification: Verification;
    for (;;) {
      verification = await call<Verification>(worker, "get_verification", { contract_id: id });
      if (verification.status !== "running") break;
      if (Date.now() - started > 6 * 60_000) throw new Error("Verification still running after 6 minutes.");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    line(`finished in ${Math.round((Date.now() - started) / 1000)} s: status ${verification.status}, contract ${verification.state}`);

    heading("buyer agent", "get_verification: the verdict, the evidence and the panel's votes");
    const verdict = await call<Verification>(buyer, "get_verification", { contract_id: id });
    line(`status ${verdict.status}${verdict.message ? ` (${verdict.message})` : ""}; contract ${verdict.state}`);
    for (const check of verdict.checks ?? []) {
      line(`${check.position}. [${check.check_kind}] ${check.outcome.toUpperCase()} (confidence ${check.confidence ?? "-"}): ${check.condition}`);
      if (check.reasoning) line(`   reasoning: ${clip(check.reasoning)}`);
      for (const link of check.evidence_links ?? []) line(`   evidence: ${link}`);
      if (check.reviewer_panel) {
        line(`   reviewer panel of ${check.reviewer_panel.size}: decision ${check.reviewer_panel.decision}, agreement ${check.reviewer_panel.agreement}`);
        for (const v of check.reviewer_panel.votes) line(`     - ${v.reviewer}: ${v.vote} (${v.confidence ?? "-"}) ${clip(v.reasoning, 160)}`);
      }
    }
    line(`next: ${verdict.next_step}`);

    heading("buyer agent", "check_receipt: the signed verification receipt");
    const receipt = await call<{
      holds?: boolean;
      checks?: { check: string; ok: boolean | null; detail: string }[];
      receipt: { receipt_sha256: string; receipt: { outcome: string; terms_sha256: string | null }; signature: { key_fingerprint: string } } | null;
      message?: string;
    }>(buyer, "check_receipt", { contract_id: id });
    if (!receipt.receipt) line(receipt.message ?? "no receipt");
    else {
      line(`receipt ${receipt.receipt.receipt_sha256}: outcome ${receipt.receipt.receipt.outcome}, terms ${receipt.receipt.receipt.terms_sha256}`);
      line(`signed by key ${receipt.receipt.signature.key_fingerprint}; holds: ${receipt.holds}`);
      for (const c of receipt.checks ?? []) line(`   ${c.ok === null ? "n/a " : c.ok ? "ok  " : "FAIL"} ${c.check}: ${clip(c.detail, 120)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    heading("buyer agent", "get_ledger: follows the money");
    const ledger = await call<{
      state: string;
      contract_amount_cents: number;
      held_by_paypal_cents: number;
      paid_to_worker_cents: number;
      ledger: { kind: string; amount_cents: number; paypal_ref: string | null }[];
      last_failure: { action: string; step: string; message: string } | null;
    }>(buyer, "get_ledger", { contract_id: id });
    line(`contract ${ledger.state}; amount ${ledger.contract_amount_cents}; held ${ledger.held_by_paypal_cents}; paid to worker ${ledger.paid_to_worker_cents}`);
    for (const row of ledger.ledger) line(`   ${row.kind} ${row.amount_cents} (${row.paypal_ref})`);
    if (ledger.last_failure) {
      line(`last_failure: ${ledger.last_failure.action}/${ledger.last_failure.step}: ${clip(ledger.last_failure.message, 200)}`);
      line("(expected in this demo: the hold is made up, so PayPal cannot capture it)");
    }

    const final = await call<ContractView>(worker, "get_contract", { contract_id: id });
    heading("worker agent", "get_contract: where things stand");
    line(`state ${final.contract.state}; terms_sha256 ${final.contract.terms_sha256}`);
    line(`next: ${final.next_step}`);
    console.log("\nDone.");
  } finally {
    await buyer.close();
    await worker.close();
  }
}

main().catch((err) => {
  console.error(err instanceof ToolError ? `Tool error: ${err.message}` : err);
  process.exit(1);
});
