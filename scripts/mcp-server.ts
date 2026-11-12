/**
 * Treuhand's MCP server over stdio, for agents that launch MCP servers as a
 * local process (Claude Desktop, Claude Code, Cursor, ...). It talks to a
 * running Treuhand app over HTTP: every tools/list and tools/call is relayed
 * to the app's `/api/mcp` endpoint with the agent token as a bearer token, so
 * the tools, their validation and their errors are exactly the app's
 * (src/lib/agent/mcp-server.ts). Guide: docs/agents.md.
 *
 *   TREUHAND_URL=http://localhost:3000 TREUHAND_TOKEN=treuhand_... pnpm exec tsx scripts/mcp-server.ts
 *
 * TREUHAND_URL   the app's base URL (default http://localhost:3000)
 * TREUHAND_TOKEN an agent token from scripts/agent-token.ts (required)
 *
 * stdout carries the MCP protocol; everything else goes to stderr. Imports
 * only the MCP SDK, so it runs from any working directory.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const NAME = "treuhand";
const VERSION = "1.0.0";

function fail(message: string): never {
  console.error(`treuhand mcp: ${message}`);
  process.exit(1);
}

const baseUrl = (process.env.TREUHAND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
const token = process.env.TREUHAND_TOKEN?.trim();
if (!token) fail("set TREUHAND_TOKEN to an agent token (create one with scripts/agent-token.ts).");

let endpoint: URL;
try {
  endpoint = new URL(`${baseUrl}/api/mcp`);
} catch {
  fail(`TREUHAND_URL is not a URL: ${baseUrl}`);
}

/** The text of a tool result's first text block. */
function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function connectRemote(): Promise<Client> {
  const remote = new Client({ name: `${NAME}-stdio-relay`, version: VERSION });
  await remote.connect(
    new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return remote;
}

async function main(): Promise<void> {
  let remote: Client;
  try {
    remote = await connectRemote();
  } catch (err) {
    fail(`cannot reach ${endpoint.href} with that token: ${err instanceof Error ? err.message : String(err)}`);
  }
  const whoami = await remote.callTool({ name: "whoami", arguments: {} });
  if (whoami.isError) fail(`the app refused the token: ${textOf(whoami)}`);
  const me = JSON.parse(textOf(whoami)) as { role: string; scopes: string[] };
  console.error(`treuhand mcp: relaying to ${endpoint.href} as the ${me.role} (scopes: ${me.scopes.join(", ")})`);

  serveStdio(
    () => {
      const server = new Server(
        { name: NAME, version: VERSION },
        { capabilities: { tools: {} }, instructions: remote.getInstructions() },
      );
      // Only the request's own fields are relayed: its `_meta` belongs to this
      // stdio connection's protocol era, not to the HTTP connection's.
      server.setRequestHandler("tools/list", async (request) => {
        const { tools, nextCursor } = await remote.listTools(
          request.params?.cursor ? { cursor: request.params.cursor } : undefined,
        );
        return nextCursor ? { tools, nextCursor } : { tools };
      });
      server.setRequestHandler("tools/call", async (request) => {
        const result = await remote.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} });
        return server.projectCallToolResult(result, undefined);
      });
      return server;
    },
    { onerror: (error) => console.error("treuhand mcp:", error.message) },
  );
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
