/**
 * Creates, lists and revokes agent API tokens (src/lib/agent/tokens.ts): the
 * bearer tokens an AI agent uses to act for the payer or the worker through
 * MCP (`/api/mcp`, scripts/mcp-server.ts) or the HTTP API.
 *
 *   pnpm exec tsx scripts/agent-token.ts create --role payer|worker [--allow-sign] [--read-only] [--label <text>]
 *   pnpm exec tsx scripts/agent-token.ts list
 *   pnpm exec tsx scripts/agent-token.ts revoke <token id>
 *
 * Works on the app's database: data/clause.db, or CLAUSE_DB_PATH. `create`
 * prints the token once; only its SHA-256 is stored, so a lost token is
 * revoked and replaced, never recovered. Scopes: `read` and `write` by
 * default; `--allow-sign` adds `sign` (the agent may sign contracts for its
 * party); `--read-only` gives `read` alone. No token can fund a contract.
 */
import { closeDb, dbPath } from "@/lib/db";
import { listAgentTokens, revokeAgentToken } from "@/lib/db/agent-tokens";
import { createAgentToken } from "@/lib/agent/tokens";
import { PartySchema } from "@/lib/types";

const USAGE = `usage:
  agent-token.ts create --role payer|worker [--allow-sign] [--read-only] [--label <text>]
  agent-token.ts list
  agent-token.ts revoke <token id>`;

class UsageError extends Error {}

function create(args: string[]): void {
  let role: string | undefined;
  let label = "";
  let allowSign = false;
  let readOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-sign") allowSign = true;
    else if (arg === "--read-only") readOnly = true;
    else if (arg === "--role" || arg === "--label") {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--role") role = value;
      else label = value;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  const party = PartySchema.safeParse(role);
  if (!party.success) throw new UsageError("--role must be payer or worker");
  if (allowSign && readOnly) throw new UsageError("--allow-sign and --read-only cannot be combined");

  const { token, row } = createAgentToken({ role: party.data, allowSign, readOnly, label });
  console.log(`Created an agent token for the ${row.role} in ${dbPath()}`);
  console.log(`  id:     ${row.id}`);
  console.log(`  scopes: ${row.scopes.join(", ")}${row.scopes.includes("sign") ? "" : "  (signing stays with a person)"}`);
  if (row.label) console.log(`  label:  ${row.label}`);
  console.log("");
  console.log(token);
  console.log("");
  console.log("This is the only time the token is shown; only its SHA-256 is stored.");
  console.log("Send it as `Authorization: Bearer <token>`, or set TREUHAND_TOKEN for scripts/mcp-server.ts.");
}

function list(): void {
  const rows = listAgentTokens();
  if (rows.length === 0) {
    console.log(`No agent tokens in ${dbPath()}.`);
    return;
  }
  for (const row of rows) {
    const status = row.revoked_at ? `revoked ${row.revoked_at}` : "active";
    console.log(
      `${row.id}  ${row.role.padEnd(6)}  ${row.scopes.join(",").padEnd(15)}  created ${row.created_at}  ${status}${row.label ? `  "${row.label}"` : ""}`,
    );
  }
}

function revoke(id: string | undefined): void {
  if (!id) throw new UsageError("revoke needs a token id (see list)");
  if (!revokeAgentToken(id)) {
    console.error(`No active agent token with id ${id} in ${dbPath()}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Revoked ${id}. Requests with it now get 401 UNAUTHORIZED.`);
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create") create(args);
    else if (command === "list") list();
    else if (command === "revoke") revoke(args[0]);
    else throw new UsageError(command ? `unknown command ${command}` : "no command");
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n${USAGE}`);
    process.exitCode = 2;
  } finally {
    closeDb();
  }
}

main();
