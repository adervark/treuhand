/**
 * `/api/mcp`: Proviso's MCP server over Streamable HTTP, for AI agents
 * (tools in src/lib/agent/mcp-server.ts, guide in docs/agents.md).
 *
 * Every request needs `Authorization: Bearer <agent token>`
 * (scripts/agent-token.ts); there is no cookie path here, so no token means
 * 401. Stateless: each request gets a fresh MCP server built for the token's
 * party. 2026-07-28 clients are served on the SDK's per-request path, older
 * (2025) clients by its stateless fallback, where GET and DELETE answer 405.
 */
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { buildMcpServer } from "@/lib/agent/mcp-server";
import { agentFromAuthorization, AgentAuthError, type AgentPrincipal } from "@/lib/agent/tokens";
import { errorResponse, toErrorResponse } from "../_lib/http";

interface McpAuthExtra extends Record<string, unknown> {
  agent: AgentPrincipal;
  baseUrl: string;
}

const handler = createMcpHandler(
  ({ authInfo }) => {
    const extra = authInfo?.extra as McpAuthExtra | undefined;
    // Unreachable: serve() authenticates every request before it reaches the handler.
    if (!extra) throw new Error("MCP request without an authenticated agent");
    return buildMcpServer(extra.agent, extra.baseUrl);
  },
  {
    responseMode: "json",
    onerror: (error) => console.error("MCP endpoint error", error),
  },
);

/** The app's origin as the client reached it, for the links tools return. */
function baseUrlOf(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function unauthorized(response: Response): Response {
  if (response.status === 401) response.headers.set("WWW-Authenticate", 'Bearer realm="proviso"');
  return response;
}

async function serve(request: Request): Promise<Response> {
  let agent: AgentPrincipal | null;
  try {
    agent = agentFromAuthorization(request.headers.get("authorization"));
  } catch (err) {
    return unauthorized(err instanceof AgentAuthError ? errorResponse(err.code, err.message) : toErrorResponse(err));
  }
  if (!agent) {
    return unauthorized(
      errorResponse(
        "UNAUTHORIZED",
        "The MCP endpoint needs `Authorization: Bearer <agent token>`. Create one with scripts/agent-token.ts (see docs/agents.md).",
      ),
    );
  }
  const authInfo: AuthInfo = {
    token: agent.tokenId,
    clientId: agent.label || `${agent.role}-agent`,
    scopes: agent.scopes,
    extra: { agent, baseUrl: baseUrlOf(request) } satisfies McpAuthExtra,
  };
  return handler.fetch(request, { authInfo });
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
