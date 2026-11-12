/**
 * "View as Payer / Worker" (the demo has no real auth). The current role lives in
 * a cookie; the matching demo identity comes from the `identities` table.
 * Server-only: reads request cookies and headers.
 *
 * An agent instead sends `Authorization: Bearer <agent token>`
 * (src/lib/agent/tokens.ts): the token's party replaces the cookie, so every
 * role rule is the same, and the token must also carry the scope the caller
 * names. Requests without that header (the web app) take the cookie path, unchanged.
 */
import { cookies, headers } from "next/headers";
import { agentFromAuthorization, requireAgentScope, type ScopeNeed } from "@/lib/agent/tokens";
import { ServiceError } from "@/lib/contract/service-errors";
import { getIdentity } from "@/lib/db/identities";
import type { Identity, Party } from "@/lib/types";

export const VIEW_AS_COOKIE = "clause_view_as";

/**
 * The role the page shows, sent by the browser client (src/components/api.ts)
 * on every request. A write whose header differs from the cookie answers 409
 * ROLE_MISMATCH: another tab switched the role since this page rendered.
 */
export const PAGE_ROLE_HEADER = "x-proviso-role";

/**
 * Defaults to "payer" when the cookie is missing or invalid. With an agent
 * token, the token's party, once the token is checked for `need` (by default
 * `write`; reads pass `read`, signing `sign`, funding `fund`, which no token
 * has); an invalid token or a missing scope throws `AgentAuthError`. Without
 * a token, a `need` other than `read` whose `PAGE_ROLE_HEADER` names the other
 * role throws `ServiceError` ROLE_MISMATCH.
 */
export async function getViewerRole(need: ScopeNeed = "write"): Promise<Party> {
  const requestHeaders = await headers();
  const agent = agentFromAuthorization(requestHeaders.get("authorization"));
  if (agent) {
    requireAgentScope(agent, need);
    return agent.role;
  }
  const value = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  const role: Party = value === "worker" ? "worker" : "payer";
  // Every tab shares the cookie: a tab still showing the other role must not act as this one (DEF-20).
  const shown = requestHeaders.get(PAGE_ROLE_HEADER);
  if (need !== "read" && (shown === "payer" || shown === "worker") && shown !== role) {
    throw new ServiceError(
      "ROLE_MISMATCH",
      `You switched to the ${role} in another tab, so this page was still showing the ${shown}. Nothing was done; the page now shows the ${role}.`,
    );
  }
  return role;
}

/** The current role and its seeded identity (null until `pnpm db:seed` has run). */
export async function getViewer(): Promise<{ role: Party; identity: Identity | null }> {
  const role = await getViewerRole("read");
  return { role, identity: getIdentity(role) };
}
