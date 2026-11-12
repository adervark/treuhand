/**
 * Agent API tokens: per-party bearer tokens that let an AI agent act for the
 * payer or the worker, through MCP (`/api/mcp`) or the HTTP API. Created,
 * listed and revoked with scripts/agent-token.ts. A token maps
 * to the same party the web app's "view as" cookie selects (src/lib/viewer.ts),
 * so every role rule in the contract service applies unchanged; scopes only
 * narrow what the party could do:
 *
 * - `read`:  read contracts, verification results, receipts and the ledger.
 * - `write`: act as the party (draft and create as payer, submit work as
 *            worker, re-run verification, open and answer disputes).
 * - `sign`:  sign contracts as the party. Contracts are signed by people, so
 *            this is off unless the token was created with `--allow-sign`.
 *
 * Funding is never available to a token: the payer approves the PayPal
 * payment in PayPal's own window.
 *
 * A token is `treuhand_` + 32 random bytes (base64url). Only its SHA-256 is
 * stored; a fast hash is enough for a 256-bit random secret, and looking it up
 * by hash never compares the secret itself.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  findAgentTokenByHash,
  insertAgentToken,
  type AgentScope,
  type AgentTokenRow,
} from "@/lib/db/agent-tokens";
import type { Party } from "@/lib/types";

export { AGENT_SCOPES, type AgentScope, type AgentTokenRow } from "@/lib/db/agent-tokens";

export const TOKEN_PREFIX = "treuhand_";
/** Prefixes of tokens created under the product's earlier name. They stay valid; new tokens never use them. */
export const EARLIER_TOKEN_PREFIXES = ["proviso_"] as const;

/** SHA-256 (hex) of the token's UTF-8 bytes: what the database stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreateTokenOptions {
  role: Party;
  /** Adds the `sign` scope. */
  allowSign?: boolean;
  /** Only the `read` scope. */
  readOnly?: boolean;
  label?: string;
}

/** Creates and stores a token. The returned `token` is the only copy of the secret. */
export function createAgentToken(options: CreateTokenOptions): { token: string; row: AgentTokenRow } {
  if (options.allowSign && options.readOnly) throw new Error("A read-only token cannot also sign.");
  const scopes: AgentScope[] = options.readOnly
    ? ["read"]
    : options.allowSign
      ? ["read", "write", "sign"]
      : ["read", "write"];
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = insertAgentToken({ tokenSha256: hashToken(token), role: options.role, scopes, label: options.label ?? "" });
  return { token, row };
}

/** Who a valid token acts as. */
export interface AgentPrincipal {
  tokenId: string;
  role: Party;
  scopes: AgentScope[];
  label: string;
}

export class AgentAuthError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "AgentAuthError";
  }
}

/**
 * Reads an `Authorization` header. Null when there is none (the caller falls
 * back to whatever it does without a token). Any header that is present but
 * is not `Bearer <a valid, unrevoked agent token>` is refused, never ignored.
 */
export function agentFromAuthorization(header: string | null | undefined): AgentPrincipal | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) throw new AgentAuthError("UNAUTHORIZED", "The Authorization header must be `Bearer <agent token>`.");
  const token = match[1];
  if (![TOKEN_PREFIX, ...EARLIER_TOKEN_PREFIXES].some((prefix) => token.startsWith(prefix))) {
    throw new AgentAuthError("UNAUTHORIZED", `That is not a Treuhand agent token (they start with "${TOKEN_PREFIX}").`);
  }
  const row = findAgentTokenByHash(hashToken(token));
  if (!row) throw new AgentAuthError("UNAUTHORIZED", "Unknown agent token.");
  if (row.revoked_at) throw new AgentAuthError("UNAUTHORIZED", `This agent token was revoked at ${row.revoked_at}.`);
  return { tokenId: row.id, role: row.role, scopes: row.scopes, label: row.label };
}

/** A scope an action needs; `fund` is never granted to any token. */
export type ScopeNeed = AgentScope | "fund";

export const FUND_REFUSAL =
  "An agent token can never fund a contract: the payer approves the PayPal payment in PayPal's own window. " +
  "Give the payer the contract page link (MCP tool get_funding_instructions) instead.";

function scopeRefusal(agent: AgentPrincipal, need: AgentScope): string {
  switch (need) {
    case "sign":
      return (
        `This token cannot sign: contracts are signed by people unless the ${agent.role} delegates signing by ` +
        `creating a token with --allow-sign. Ask the ${agent.role} to sign on the contract page.`
      );
    case "write":
      return "This token is read-only (scope `read`): it cannot change contracts.";
    case "read":
      return "This token lacks the `read` scope.";
  }
}

export function hasScope(agent: AgentPrincipal, need: ScopeNeed): boolean {
  return need !== "fund" && agent.scopes.includes(need);
}

/** Throws FORBIDDEN unless the token carries `need`. */
export function requireAgentScope(agent: AgentPrincipal, need: ScopeNeed): void {
  if (need === "fund") throw new AgentAuthError("FORBIDDEN", FUND_REFUSAL);
  if (!hasScope(agent, need)) throw new AgentAuthError("FORBIDDEN", scopeRefusal(agent, need));
}
