/**
 * Agent API token rows (migration 4). Only the SHA-256 of a token is stored;
 * the token itself is printed once, when scripts/agent-token.ts creates it.
 * Token logic (format, hashing, scopes) lives in src/lib/agent/tokens.ts.
 */
import { z } from "zod";
import { PartySchema, type Party } from "@/lib/types";
import { getDb, newId, nowIso } from "./index";

export const AGENT_SCOPES = ["read", "write", "sign"] as const;
export const AgentScopeSchema = z.enum(AGENT_SCOPES);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const AgentTokenRowSchema = z.object({
  id: z.string().min(1),
  role: PartySchema,
  scopes: z.array(AgentScopeSchema),
  label: z.string(),
  created_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
});
/** A stored token without its hash. */
export type AgentTokenRow = z.infer<typeof AgentTokenRowSchema>;

type Row = Omit<AgentTokenRow, "scopes"> & { scopes: string };

function fromRow(row: Row): AgentTokenRow {
  return AgentTokenRowSchema.parse({ ...row, scopes: JSON.parse(row.scopes) });
}

const COLUMNS = "id, role, scopes, label, created_at, revoked_at";

export function insertAgentToken(input: {
  tokenSha256: string;
  role: Party;
  scopes: AgentScope[];
  label: string;
}): AgentTokenRow {
  const row: Row = {
    id: newId(),
    role: input.role,
    scopes: JSON.stringify(input.scopes),
    label: input.label,
    created_at: nowIso(),
    revoked_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO agent_tokens (id, token_sha256, role, scopes, label, created_at, revoked_at)
       VALUES (@id, @token_sha256, @role, @scopes, @label, @created_at, @revoked_at)`,
    )
    .run({ ...row, token_sha256: input.tokenSha256 });
  return fromRow(row);
}

/** The token with this hash, revoked or not; null when there is none. */
export function findAgentTokenByHash(tokenSha256: string): AgentTokenRow | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM agent_tokens WHERE token_sha256 = ?`)
    .get(tokenSha256) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Oldest first. */
export function listAgentTokens(): AgentTokenRow[] {
  return (getDb().prepare(`SELECT ${COLUMNS} FROM agent_tokens ORDER BY created_at, rowid`).all() as Row[]).map(
    fromRow,
  );
}

/** Revokes the token with this id. Returns false when there is no such token or it was already revoked. */
export function revokeAgentToken(id: string): boolean {
  const result = getDb()
    .prepare(`UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowIso(), id);
  return result.changes > 0;
}
