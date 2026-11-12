/**
 * Treuhand as MCP tools, for AI agents acting for the payer or the worker.
 * Served over Streamable HTTP at `/api/mcp` (src/app/api/mcp/route.ts), one
 * server per request; the stdio entry (scripts/mcp-server.ts) relays a local
 * MCP client to that endpoint over HTTP with the same bearer token.
 *
 * Every tool is a thin wrapper over the contract service, called with the
 * party of the caller's agent token (src/lib/agent/tokens.ts), so the role
 * rules are the web app's. Inputs are validated with the HTTP API's own
 * schemas (src/app/api/_lib/schemas.ts) and every failure is the HTTP API's
 * error, `{ "error": { "code", "message" }, "http_status" }` (docs/api.md),
 * returned as a tool error. Two steps stay with people: the payer approving
 * the PayPal payment (no tool can fund), and signing unless the token was
 * created with `--allow-sign`.
 */
import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from "@modelcontextprotocol/server";
import { after } from "next/server";
import { z } from "zod";
import { ArgumentBody, CreateContractBody, DraftBody, SubmitBody } from "@/app/api/_lib/schemas";
import { toErrorResponse } from "@/app/api/_lib/http";
import {
  answerProposal,
  createFromProposal,
  draftFromPrompt,
  getContractDetail,
  getContractReceipts,
  listAllContracts,
  openDispute,
  rerunVerification,
  respondToDispute,
  signContract,
  submitWork,
  type AllowedAction,
  type ContractDetail,
} from "@/lib/contract/service";
import { getIdentity } from "@/lib/db/identities";
import { ContractStateSchema, type Condition, type LedgerKind, type Verdict } from "@/lib/types";
import { checkReceipt, receiptHolds } from "@/lib/verifier/receipt-core";
import { verifierPublicKey } from "@/lib/verifier/signing-key";
import { hasScope, requireAgentScope, type AgentPrincipal, type ScopeNeed } from "./tokens";

export const MCP_SERVER_NAME = "treuhand";
export const MCP_SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Inputs: the HTTP API's schemas, validated inside the handler so a bad input
// gets the API's VALIDATION_ERROR ("<field>: <problem>"), not the SDK's own.
// ---------------------------------------------------------------------------

/** Advertises `schema` as the tool's JSON Schema but lets every value through to the handler, which parses it. */
function advertise(schema: z.ZodType): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "treuhand",
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}

const contractId = z
  .string({ error: (issue) => (issue.input === undefined || issue.input === null ? "is required" : "must be a string") })
  .trim()
  .min(1, "is empty")
  .describe("The contract's id, from list_contracts or create_contract.");

const ContractIdInput = z.object({ contract_id: contractId });
const ListInput = z.object({
  state: ContractStateSchema.optional().describe("Only contracts in this state. Omit for all."),
});
const VerificationInput = z.object({
  contract_id: contractId,
  submission_id: z
    .string()
    .trim()
    .min(1, "is empty")
    .optional()
    .describe("A specific submission. Omit for the latest one."),
});
const ReceiptInput = z.object({
  contract_id: contractId,
  receipt_sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex digits")
    .optional()
    .describe("A specific receipt's receipt_sha256. Omit for the contract's latest receipt."),
});
const SubmitInput = ContractIdInput.extend(SubmitBody.shape);
const ArgumentInput = ContractIdInput.extend(ArgumentBody.shape);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** The HTTP API's error body and status for whatever the service threw. */
export async function toolError(err: unknown): Promise<CallToolResult> {
  const response = toErrorResponse(err);
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ...body, http_status: response.status }) }] };
}

interface Ctx {
  agent: AgentPrincipal;
  /** Origin of the app, for links (contract page, evidence images, receipts). */
  baseUrl: string;
}

const pageUrl = (ctx: Ctx, id: string) => `${ctx.baseUrl}/contracts/${encodeURIComponent(id)}`;

/** `data/evidence/<submissionId>/<file>` -> the evidence route's URL. */
function evidenceUrl(ctx: Ctx, stored: string): string {
  const relative = stored.replace(/^data\/evidence\//, "");
  return `${ctx.baseUrl}/api/evidence/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/** Which MCP tool performs each allowed action, and the scope it needs; null when no tool does. */
const ACTION_TOOLS: Record<AllowedAction, { tool: string | null; need: ScopeNeed }> = {
  edit_conditions: { tool: null, need: "write" },
  sign: { tool: "sign_contract", need: "sign" },
  fund: { tool: null, need: "fund" },
  submit: { tool: "submit_work", need: "write" },
  rerun_verification: { tool: "rerun_verification", need: "write" },
  dispute: { tool: "open_dispute", need: "write" },
  respond: { tool: "respond_to_dispute", need: "write" },
  accept: { tool: "accept_proposal", need: "write" },
  decline: { tool: "decline_proposal", need: "write" },
};

function agentActions(ctx: Ctx, detail: ContractDetail) {
  const youCanNow: string[] = [];
  const needsAPerson: { action: AllowedAction; why: string; where: string }[] = [];
  for (const action of detail.allowed_actions) {
    const { tool, need } = ACTION_TOOLS[action];
    if (tool && hasScope(ctx.agent, need)) {
      youCanNow.push(tool);
      continue;
    }
    const why =
      action === "fund"
        ? "Funding is approved by the payer in PayPal's own window; no agent can fund. See get_funding_instructions."
        : action === "sign"
          ? `Your token has no sign scope, so the ${ctx.agent.role} signs in person (or creates a token with --allow-sign).`
          : action === "edit_conditions"
            ? "Conditions are edited on the contract page; editing clears both signatures."
            : "Your token is read-only.";
    needsAPerson.push({ action, why, where: pageUrl(ctx, detail.contract.id) });
  }
  return { you_can_now: youCanNow, needs_a_person: needsAPerson };
}

function nextStep(ctx: Ctx, detail: ContractDetail): string {
  const { contract, verification, dispute } = detail;
  const role = ctx.agent.role;
  switch (contract.state) {
    case "DRAFT": {
      const unsigned = [!contract.payer_signed_at && "payer", !contract.worker_signed_at && "worker"].filter(Boolean);
      return `Waiting for ${unsigned.join(" and ")} to sign (sign_contract, or on the contract page). Read the conditions and notes first: they are what the verifier will test.`;
    }
    case "SIGNED":
      return "Both signed. Waiting for the payer, a person, to fund it with PayPal on the contract page (get_funding_instructions).";
    case "FUNDED":
      return role === "worker"
        ? `Funded. Deliver the work and submit its public URL with submit_work before ${contract.deadline_at}.`
        : `Funded: PayPal holds the money. Waiting for the worker to submit work before ${contract.deadline_at}.`;
    case "SUBMITTED":
    case "VERIFYING":
      if (!verification || verification.status === "running") {
        return "Verification is running. Call get_verification again in 15-30 seconds.";
      }
      return `Verification could not finish (${verification.status}): ${verification.message ?? "no detail"}. Call rerun_verification (before the deadline) or open_dispute.`;
    case "PASSED":
      return "Every condition passed. The worker is paid automatically after the contest window; payout.status in get_ledger shows PayPal's progress. A dispute is possible only until the money is captured.";
    case "FAILED":
      return role === "worker"
        ? "At least one condition failed (see get_verification). Fix the work and submit_work again before the deadline, or open_dispute."
        : "At least one condition failed (see get_verification). The worker may resubmit before the deadline; either party may open_dispute.";
    case "PAID":
      return "Done: the worker was paid. get_ledger shows the money trail.";
    case "EXPIRED":
      return "The deadline passed without a pass: the PayPal hold was voided and the payer was not charged.";
    case "DISPUTED":
      if (dispute?.state === "PROPOSED") {
        return `The mediator proposed ${dispute.proposed_worker_cents} cents to the worker. Call accept_proposal or decline_proposal (declining escalates to a person).`;
      }
      return "A dispute is open. Each party gives its argument with respond_to_dispute; once both have, the mediator proposes a split.";
    case "SETTLED":
      return "Settled: the money was split as both parties agreed, or refunded. get_ledger shows the money trail.";
    case "ESCALATED":
      return "The split was declined. A person decides outside the app.";
  }
}

const LEDGER_KINDS: readonly LedgerKind[] = ["AUTHORIZED", "CAPTURED", "PAID_OUT", "REFUNDED", "VOIDED"];

function moneySummary(detail: ContractDetail) {
  const totals = Object.fromEntries(LEDGER_KINDS.map((kind) => [kind, 0])) as Record<LedgerKind, number>;
  for (const row of detail.ledger) totals[row.kind] += row.amount_cents;
  const held = totals.CAPTURED === 0 && totals.VOIDED === 0 ? totals.AUTHORIZED : 0;
  return {
    currency: detail.contract.currency,
    contract_amount_cents: detail.contract.amount_cents,
    held_by_paypal_cents: held,
    captured_cents: totals.CAPTURED,
    paid_to_worker_cents: totals.PAID_OUT,
    refunded_to_payer_cents: totals.REFUNDED,
    voided_cents: totals.VOIDED,
    payout: detail.payout,
    last_failure: detail.activity.last_failure,
  };
}

/** A panel vote as stored in `evidence.panel.votes` (src/lib/verifier/ai-judgement.ts), reduced to what a reader needs. */
const PanelSchema = z.object({
  size: z.number(),
  rule: z.string(),
  decision: z.string(),
  agreement: z.number(),
  votes: z.array(
    z.object({
      reviewer: z.string(),
      vote: z.string(),
      criterion_met: z.boolean().nullable(),
      confidence: z.number().nullable(),
      reasoning: z.string(),
    }),
  ),
});

/** The reviewer panel of an AI-judged check, or null for a check without one. */
function reviewerPanel(raw: unknown) {
  const parsed = PanelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { size, rule, decision, agreement, votes } = parsed.data;
  return {
    size,
    rule,
    decision,
    agreement,
    votes: votes.map(({ reviewer, vote, criterion_met, confidence, reasoning }) => ({
      reviewer,
      vote,
      criterion_met,
      confidence,
      reasoning,
    })),
  };
}

function checkRows(ctx: Ctx, conditions: Condition[], verdicts: Verdict[], running: boolean) {
  return conditions.map((condition) => {
    const verdict = verdicts.find((v) => v.condition_id === condition.id);
    if (!verdict) {
      return {
        position: condition.position,
        condition: condition.text,
        check_kind: condition.check_kind,
        outcome: running ? "pending" : "not_run",
      };
    }
    const { screenshots = [], panel, ...evidence } = verdict.evidence;
    return {
      position: condition.position,
      condition: condition.text,
      check_kind: condition.check_kind,
      outcome: verdict.evidence.outcome ?? (verdict.passed ? "pass" : "fail"),
      passed: verdict.passed,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
      reviewer_panel: reviewerPanel(panel),
      evidence_links: screenshots.map((stored) => evidenceUrl(ctx, stored)),
      evidence,
    };
  });
}

/** The latest submission's check rows, or null before any submission. */
function latestChecks(ctx: Ctx, detail: ContractDetail) {
  const latest = detail.submissions[0];
  if (!latest) return null;
  return checkRows(
    ctx,
    detail.conditions,
    detail.verdicts.filter((v) => v.submission_id === latest.id),
    detail.verification?.status === "running",
  );
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** One MCP server for one request, acting as `agent`. */
export function buildMcpServer(agent: AgentPrincipal, baseUrl: string): McpServer {
  const ctx: Ctx = { agent, baseUrl: baseUrl.replace(/\/+$/, "") };
  const role = agent.role;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Treuhand holds a payer's money with a PayPal authorization and pays the worker through PayPal Payouts " +
        "when an AI verifier proves the delivered work meets conditions both parties signed. Your token acts " +
        "as one party (whoami). Typical flow: payer drafts (draft_contract) and creates (create_contract); both " +
        "sign; the payer, a person, funds it in PayPal (get_funding_instructions); the worker submits a URL (submit_work); " +
        "anyone reads the verdict (get_verification) and follows the money (get_ledger). get_contract always says " +
        "what you can do now and what needs a person.",
    },
  );

  /** Registers a tool that needs `need`, parses its input with `schema`, and maps any failure to the API's error. */
  function tool<S extends z.ZodType>(
    name: string,
    need: ScopeNeed,
    config: { title: string; description: string; annotations?: ToolAnnotations },
    schema: S,
    run: (input: z.infer<S>) => unknown,
  ): void {
    server.registerTool(name, { ...config, inputSchema: advertise(schema) }, async (args: unknown) => {
      try {
        requireAgentScope(agent, need);
        return ok(await run(schema.parse(args ?? {})));
      } catch (err) {
        return toolError(err);
      }
    });
  }

  tool(
    "whoami",
    "read",
    {
      title: "Who am I",
      description:
        "Says which party your token acts as (payer or worker), its scopes, and that party's email. Call it first " +
        "if you are unsure of your role. Scopes: read (read everything), write (act as your party), sign (sign " +
        "contracts; only when a person delegated signing). No token can fund a contract.",
      annotations: READ_ONLY,
    },
    z.object({}),
    () => {
      const identity = getIdentity(role);
      return {
        role,
        scopes: agent.scopes,
        token_id: agent.tokenId,
        label: agent.label,
        acts_as: identity ? { display_name: identity.display_name, email: identity.email } : null,
        cannot: [
          "fund a contract: the payer approves the PayPal payment in PayPal's window",
          ...(hasScope(agent, "sign") ? [] : ["sign: a person signs on the contract page"]),
          ...(hasScope(agent, "write") ? [] : ["change anything: this token is read-only"]),
        ],
      };
    },
  );

  tool(
    "list_contracts",
    "read",
    {
      title: "List contracts",
      description:
        "Lists every contract, newest first, with its id, title, state, amount (integer cents), deadline and who " +
        "has signed. Use it to find a contract id. Optional `state` filter (DRAFT, SIGNED, FUNDED, VERIFYING, " +
        "PASSED, FAILED, PAID, EXPIRED, DISPUTED, SETTLED, ESCALATED, SUBMITTED).",
      annotations: READ_ONLY,
    },
    ListInput,
    ({ state }) => ({
      contracts: listAllContracts()
        .filter((c) => !state || c.state === state)
        .map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          state: c.state,
          amount_cents: c.amount_cents,
          currency: c.currency,
          deadline_at: c.deadline_at,
          payer_signed: c.payer_signed_at !== null,
          worker_signed: c.worker_signed_at !== null,
          page_url: pageUrl(ctx, c.id),
        })),
    }),
  );

  tool(
    "get_contract",
    "read",
    {
      title: "Get a contract",
      description:
        "Reads one contract: its state, terms and terms_sha256 (the fingerprint of the agreed terms, fixed at " +
        "signing), the conditions the verifier will test (check kind and params), the drafter's notes, the " +
        "verification of the latest submission (status, and per condition its outcome, reasoning and the AI " +
        "reviewer panel's votes), the dispute, a money summary, the latest signed verification receipt, and " +
        "`next_step`. `you_can_now` lists the tools you may call on it right now; `needs_a_person` " +
        "lists steps only a person can take (funding always; signing unless your token has the sign scope). " +
        "Fails with NOT_FOUND for an unknown id.",
      annotations: READ_ONLY,
    },
    ContractIdInput,
    ({ contract_id }) => {
      const detail = getContractDetail(contract_id, role);
      const { contract } = detail;
      return {
        contract: {
          id: contract.id,
          title: contract.title,
          type: contract.type,
          state: contract.state,
          amount_cents: contract.amount_cents,
          currency: contract.currency,
          deadline_at: contract.deadline_at,
          payer_email: contract.payer_email,
          worker_email: contract.worker_email,
          payer_signed_at: contract.payer_signed_at,
          worker_signed_at: contract.worker_signed_at,
          created_at: contract.created_at,
          terms_sha256: detail.terms_sha256,
        },
        page_url: pageUrl(ctx, contract.id),
        you: { role, scopes: agent.scopes },
        next_step: nextStep(ctx, detail),
        allowed_actions: detail.allowed_actions,
        ...agentActions(ctx, detail),
        conditions: detail.conditions.map((c) => ({
          position: c.position,
          text: c.text,
          check_kind: c.check_kind,
          check_params: c.check_params,
        })),
        notes: detail.notes,
        verification: detail.verification && {
          ...detail.verification,
          checks: latestChecks(ctx, detail),
        },
        submissions: detail.submissions.map((s) => ({ id: s.id, url: s.url, created_at: s.created_at })),
        dispute: detail.dispute,
        activity: detail.activity,
        money: moneySummary(detail),
        latest_receipt: detail.receipt,
      };
    },
  );

  tool(
    "draft_contract",
    "write",
    {
      title: "Draft a contract from plain English (payer)",
      description:
        "Payer only. Turns a deal in plain English (up to 4000 characters) into a proposed contract whose " +
        "conditions a machine can check. Say what the work is, the amount, the currency, the deadline, and each " +
        "condition. Optional `type`: code_bounty (a GitHub pull request) or website_milestone (a public web page). " +
        "Returns {kind:'draft', contract} or {kind:'refusal', vague_conditions} when a condition cannot be checked " +
        "(rewrite it with the suggested_rewrite, or drop it). In a draft, amount_cents, currency or deadline_at " +
        "is null when the deal did not state it: fill it in, show `notes` to both parties, then pass the contract " +
        "to create_contract. Creates nothing. Errors: FORBIDDEN (worker token), AI_ERROR, NOT_CONFIGURED.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    DraftBody,
    ({ prompt, type }) => draftFromPrompt(role, prompt, type),
  );

  tool(
    "create_contract",
    "write",
    {
      title: "Create a contract from a draft (payer)",
      description:
        "Payer only. Creates a DRAFT contract between the payer and the worker from a proposed contract: pass the " +
        "`contract` object from draft_contract (possibly edited) with every term filled in: title, type, " +
        "amount_cents (integer cents > 0), currency (3 letters, default USD), deadline_at (ISO 8601 with zone, in " +
        "the future), conditions (at least one, each {text, check_kind, check_params}), notes. Returns the " +
        "contract and its page URL. Nothing is signed or funded yet: next, both parties sign. Errors: " +
        "VALIDATION_ERROR naming the field, INVALID_CONDITION (check kind not allowed for the type), FORBIDDEN.",
    },
    CreateContractBody,
    (body) => {
      const contract = createFromProposal(role, body);
      return {
        contract,
        page_url: pageUrl(ctx, contract.id),
        next_step: "Both parties sign (sign_contract, or a person on the contract page). Then the payer funds it in PayPal.",
      };
    },
  );

  tool(
    "sign_contract",
    "sign",
    {
      title: "Sign a contract",
      description:
        "Signs a DRAFT contract as your party. When both have signed it becomes SIGNED and its terms are fixed. " +
        "Signing twice is a no-op. Needs the sign scope, which a token has only when a person created it with " +
        "--allow-sign: contracts are signed by people unless a party delegates signing. Read the conditions and " +
        "notes (get_contract) before signing; they are exactly what the verifier will test. Errors: FORBIDDEN " +
        "(no sign scope), ILLEGAL_TRANSITION (not DRAFT, or no conditions), NOT_FOUND.",
      annotations: { idempotentHint: true },
    },
    ContractIdInput,
    ({ contract_id }) => {
      const contract = signContract(contract_id, role);
      return {
        contract,
        next_step:
          contract.state === "SIGNED"
            ? "Both signed. The payer, a person, now funds it in PayPal (get_funding_instructions)."
            : `Signed as ${role}. Waiting for the other party to sign.`,
      };
    },
  );

  tool(
    "get_funding_instructions",
    "read",
    {
      title: "How the payer funds a contract",
      description:
        "Funding is never done by an agent: the payer, a person, approves the PayPal payment in PayPal's own " +
        "window, which places a hold (nothing is charged until the work passes). This tool returns where and " +
        "how: the contract page URL, the amount, whether it can be funded now, and step-by-step instructions to " +
        "give the payer. It does not create a PayPal order or move money. Call get_contract afterwards: the " +
        "state becomes FUNDED.",
      annotations: READ_ONLY,
    },
    ContractIdInput,
    ({ contract_id }) => {
      const asPayer = getContractDetail(contract_id, "payer");
      const { contract } = asPayer;
      const url = pageUrl(ctx, contract.id);
      const fundable = asPayer.allowed_actions.includes("fund");
      const why = fundable
        ? null
        : contract.state === "DRAFT"
          ? "Both parties must sign before it can be funded."
          : contract.state === "SIGNED"
            ? asPayer.activity.in_progress
              ? "Another action is running on this contract; try again shortly."
              : "The deadline has passed."
            : `It is already past funding (state ${contract.state}).`;
      return {
        contract_id: contract.id,
        state: contract.state,
        amount_cents: contract.amount_cents,
        currency: contract.currency,
        who: "the payer, a person",
        can_be_funded_now: fundable,
        why_not: why,
        funding_page_url: url,
        instructions_for_the_payer: [
          `Open ${url} in a browser.`,
          "In the header's view switch, choose Payer.",
          "Click the PayPal button in the funding section and approve the payment in PayPal's window. PayPal holds " +
            "the amount; it is captured only when the work passes, and released if the deadline passes first.",
        ],
        after_funding: "The contract becomes FUNDED and the worker can submit work.",
      };
    },
  );

  tool(
    "submit_work",
    "write",
    {
      title: "Submit work (worker)",
      description:
        "Worker only. Submits the delivered work as a public http(s) URL: the pull request URL for a code_bounty, " +
        "the page URL for a website_milestone. Allowed when the contract is FUNDED, or FAILED (to resubmit), " +
        "before the deadline. The contract becomes VERIFYING at once and the verifier runs in the background " +
        "(usually 10-60 s); poll get_verification. A pass pays the worker automatically. Private-network and " +
        "localhost URLs fail verification. Returns the submission id. Errors: VALIDATION_ERROR, FORBIDDEN, " +
        "ILLEGAL_TRANSITION, DEADLINE_PASSED, BUSY, NOT_FOUND.",
    },
    SubmitInput,
    ({ contract_id, url }) => {
      const job = submitWork(contract_id, role, url);
      after(job.run);
      return {
        submission_id: job.submissionId,
        state: "VERIFYING",
        next_step: "Verification is running. Call get_verification in 15-30 seconds, and again until its status is not running.",
      };
    },
  );

  tool(
    "get_verification",
    "read",
    {
      title: "Get verification results",
      description:
        "Reads the verifier's results for the latest submission (or `submission_id`): the run status (running, " +
        "passed, failed, inconclusive, error), and for each condition its outcome (pass, fail, inconclusive, " +
        "pending, not_run), confidence, the verifier's reasoning, the reviewer panel for AI-judged checks (each " +
        "reviewer's vote, confidence and reasoning; a pass or fail needs every reviewer to agree), links to " +
        "evidence screenshots, and the raw evidence. Also the signed verification receipt for that submission " +
        "once a run has finished (check it with check_receipt). Poll it while status is running. Inconclusive " +
        "means a check could not complete (neither pass nor fail): rerun_verification or open_dispute.",
      annotations: READ_ONLY,
    },
    VerificationInput,
    ({ contract_id, submission_id }) => {
      const detail = getContractDetail(contract_id, role);
      const submission = submission_id
        ? detail.submissions.find((s) => s.id === submission_id)
        : detail.submissions[0];
      if (!submission) {
        if (submission_id) throw new z.ZodError([{ code: "custom", path: ["submission_id"], message: "is not a submission of this contract", input: submission_id }]);
        return { contract_id, state: detail.contract.state, status: "no_submission", next_step: nextStep(ctx, detail) };
      }
      const latest = submission.id === detail.submissions[0]?.id;
      const status = latest ? (detail.verification?.status ?? "not_run") : "superseded";
      const receipt = getContractReceipts(contract_id).receipts.find((r) => r.receipt.submission_id === submission.id) ?? null;
      return {
        contract_id,
        state: detail.contract.state,
        submission: { id: submission.id, url: submission.url, created_at: submission.created_at },
        status,
        message: latest ? (detail.verification?.message ?? null) : "A newer submission replaced this one.",
        checks: checkRows(
          ctx,
          detail.conditions,
          detail.verdicts.filter((v) => v.submission_id === submission.id),
          status === "running",
        ),
        receipt,
        public_key_url: `${ctx.baseUrl}/api/verifier/public-key`,
        receipts_url: `${ctx.baseUrl}/api/contracts/${encodeURIComponent(contract_id)}/receipts`,
        next_step: nextStep(ctx, detail),
      };
    },
  );

  tool(
    "rerun_verification",
    "write",
    {
      title: "Re-run an inconclusive verification",
      description:
        "Either party. Re-runs verification of the latest submission when the last run was inconclusive, " +
        "crashed or was interrupted (the contract is still VERIFYING), before the deadline. Not for a failed " +
        "run: after a fail the worker resubmits with submit_work. Poll get_verification afterwards. Errors: " +
        "ILLEGAL_TRANSITION (not VERIFYING), DEADLINE_PASSED, BUSY (a run is in progress), NOT_FOUND.",
    },
    ContractIdInput,
    ({ contract_id }) => {
      const job = rerunVerification(contract_id, role);
      after(job.run);
      return { submission_id: job.submissionId, next_step: "Call get_verification in 15-30 seconds." };
    },
  );

  tool(
    "open_dispute",
    "write",
    {
      title: "Open a dispute",
      description:
        "Either party. Opens a dispute with your argument (1-4000 characters): why the verdict or the work is " +
        "wrong. Allowed when the contract is FUNDED, FAILED, PASSED, or VERIFYING after an inconclusive run, and " +
        "only until the money is captured for a payout. The contract becomes DISPUTED; the other party answers " +
        "with respond_to_dispute, then an AI mediator proposes a split. Errors: VALIDATION_ERROR, " +
        "ILLEGAL_TRANSITION, BUSY, NOT_FOUND.",
    },
    ArgumentInput,
    ({ contract_id, argument }) => ({ dispute: openDispute(contract_id, role, argument) }),
  );

  tool(
    "respond_to_dispute",
    "write",
    {
      title: "Argue in a dispute",
      description:
        "Either party, while the dispute is OPEN. Stores (or revises) your argument (1-4000 characters). Once " +
        "both parties have argued, the AI mediator proposes how much of the amount goes to the worker (the " +
        "dispute becomes PROPOSED, with proposed_worker_cents and proposal_reasoning). If the mediator fails, " +
        "your argument is kept and calling again retries. Errors: VALIDATION_ERROR, DISPUTE_STATE, NOT_FOUND, " +
        "BUSY, AI_ERROR, NOT_CONFIGURED.",
    },
    ArgumentInput,
    async ({ contract_id, argument }) => ({ dispute: await respondToDispute(contract_id, role, argument) }),
  );

  tool(
    "accept_proposal",
    "write",
    {
      title: "Accept the mediator's split",
      description:
        "Either party, while the dispute is PROPOSED. Records your acceptance of the mediator's proposed split. " +
        "When both parties have accepted, the money moves in this same call: PayPal captures the hold, refunds " +
        "the payer's share and pays the worker's share. Cannot be undone once both accept. Calling again resumes " +
        "a settlement that failed part-way. Errors: DISPUTE_STATE, NOT_FOUND, BUSY, PAYPAL_ERROR, NOT_CONFIGURED.",
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ContractIdInput,
    async ({ contract_id }) => answerProposal(contract_id, role, true),
  );

  tool(
    "decline_proposal",
    "write",
    {
      title: "Decline the mediator's split",
      description:
        "Either party, while the dispute is PROPOSED and you have not accepted. Declines the split: the dispute " +
        "and the contract become ESCALATED and a person decides outside the app; if nobody settles it by the " +
        "deadline the hold is voided. Errors: DISPUTE_STATE (no proposal, or you already accepted), NOT_FOUND, BUSY.",
      annotations: { destructiveHint: true },
    },
    ContractIdInput,
    async ({ contract_id }) => answerProposal(contract_id, role, false),
  );

  tool(
    "get_ledger",
    "read",
    {
      title: "Follow the money",
      description:
        "Reads a contract's money trail: every PayPal movement (AUTHORIZED hold, CAPTURED, PAID_OUT to the " +
        "worker, REFUNDED to the payer, VOIDED hold) with amount in integer cents and PayPal reference, oldest " +
        "first; totals; the worker's payout status as PayPal reports it (PENDING until PayPal says SUCCESS); and " +
        "the latest failed money step, if any, which the app retries on its own.",
      annotations: READ_ONLY,
    },
    ContractIdInput,
    ({ contract_id }) => {
      const detail = getContractDetail(contract_id, role);
      return {
        contract_id,
        state: detail.contract.state,
        ...moneySummary(detail),
        ledger: detail.ledger.map((row) => ({
          kind: row.kind,
          amount_cents: row.amount_cents,
          paypal_ref: row.paypal_ref,
          at: row.created_at,
        })),
      };
    },
  );

  tool(
    "check_receipt",
    "read",
    {
      title: "Fetch and check a verification receipt",
      description:
        "Fetches a signed verification receipt (the latest for the contract, or the one with `receipt_sha256`) " +
        "and checks it: recomputes its hash, verifies the Ed25519 signature against the verifier's public key, " +
        "recomputes the agreed-terms hash from the contract, and compares each verdict's evidence, reasoning and " +
        "outcome with what was signed. Returns `holds` (true when no check failed), each check with its detail " +
        "(ok null means it could not be compared, e.g. a later re-run replaced that verdict), the receipt, and " +
        "the key. This check runs on the server; to check without trusting it, use the receipt, public_key_url " +
        "and scripts/verify-receipt.ts. A receipt is a record: it never moves money. Returns receipt null " +
        "before any verification run has finished.",
      annotations: READ_ONLY,
    },
    ReceiptInput,
    ({ contract_id, receipt_sha256 }) => {
      const { receipts, terms_sha256 } = getContractReceipts(contract_id);
      const receipt = receipt_sha256 ? receipts.find((r) => r.receipt_sha256 === receipt_sha256) : receipts[0];
      if (!receipt) {
        if (receipt_sha256) {
          throw new z.ZodError([
            { code: "custom", path: ["receipt_sha256"], message: "is not a receipt of this contract", input: receipt_sha256 },
          ]);
        }
        return { contract_id, receipt: null, message: "No verification run has finished on this contract yet." };
      }
      const detail = getContractDetail(contract_id, role);
      const key = verifierPublicKey();
      const checks = checkReceipt(receipt, key.public_key_pem, {
        contract: detail.contract,
        conditions: detail.conditions,
        verdicts: detail.verdicts,
      });
      return {
        contract_id,
        holds: receiptHolds(checks),
        checks,
        receipt,
        terms_sha256,
        public_key: { algorithm: key.algorithm, fingerprint: key.fingerprint },
        public_key_url: `${ctx.baseUrl}/api/verifier/public-key`,
        receipts_url: `${ctx.baseUrl}/api/contracts/${encodeURIComponent(contract_id)}/receipts`,
      };
    },
  );

  return server;
}
