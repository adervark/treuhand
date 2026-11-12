import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { listAgentTokens, revokeAgentToken } from "@/lib/db/agent-tokens";
import { withTempDb } from "@/test/helpers";
import {
  AgentAuthError,
  FUND_REFUSAL,
  TOKEN_PREFIX,
  agentFromAuthorization,
  createAgentToken,
  hasScope,
  hashToken,
  requireAgentScope,
  type AgentPrincipal,
} from "./tokens";

withTempDb();

const bearer = (token: string) => `Bearer ${token}`;

function authError(fn: () => unknown): AgentAuthError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AgentAuthError);
    return err as AgentAuthError;
  }
  throw new Error("expected an AgentAuthError");
}

describe("hashing", () => {
  it("is the SHA-256 hex of the token's UTF-8 bytes", () => {
    expect(hashToken("treuhand_abc")).toBe(createHash("sha256").update("treuhand_abc").digest("hex"));
    expect(hashToken("treuhand_abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("treuhand_abc")).not.toBe(hashToken("treuhand_abd"));
  });

  it("stores only the hash, never the token", () => {
    const { token, row } = createAgentToken({ role: "payer" });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(TOKEN_PREFIX.length + 40);
    const stored = getDb().prepare("SELECT * FROM agent_tokens WHERE id = ?").get(row.id) as Record<string, unknown>;
    expect(stored.token_sha256).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("gives every token a different secret", () => {
    const a = createAgentToken({ role: "worker" }).token;
    const b = createAgentToken({ role: "worker" }).token;
    expect(a).not.toBe(b);
  });
});

describe("scopes at creation", () => {
  it("is read and write by default; signing only with allowSign; read alone when readOnly", () => {
    expect(createAgentToken({ role: "payer" }).row.scopes).toEqual(["read", "write"]);
    expect(createAgentToken({ role: "payer", allowSign: true }).row.scopes).toEqual(["read", "write", "sign"]);
    expect(createAgentToken({ role: "worker", readOnly: true }).row.scopes).toEqual(["read"]);
    expect(() => createAgentToken({ role: "worker", readOnly: true, allowSign: true })).toThrow(/read-only/);
  });

  it("keeps the role and label it was created with", () => {
    const { row } = createAgentToken({ role: "worker", label: "worker agent" });
    expect(listAgentTokens()).toEqual([row]);
    expect(row).toMatchObject({ role: "worker", label: "worker agent", revoked_at: null });
  });
});

describe("agentFromAuthorization", () => {
  it("is null without a header, so the caller falls back to its no-token path", () => {
    expect(agentFromAuthorization(null)).toBeNull();
    expect(agentFromAuthorization(undefined)).toBeNull();
  });

  it("maps a valid token to its party and scopes", () => {
    const { token, row } = createAgentToken({ role: "worker", allowSign: true, label: "w" });
    expect(agentFromAuthorization(bearer(token))).toEqual({
      tokenId: row.id,
      role: "worker",
      scopes: ["read", "write", "sign"],
      label: "w",
    });
    expect(agentFromAuthorization(`bearer   ${token}  `)?.role).toBe("worker");
  });

  it("refuses a header that is present but not a valid bearer token", () => {
    const { token } = createAgentToken({ role: "payer" });
    for (const header of ["", "Basic dXNlcjpwYXNz", token, `Bearer ${token} extra`, "Bearer sk-not-ours", `Bearer ${token}x`]) {
      expect(authError(() => agentFromAuthorization(header)).code).toBe("UNAUTHORIZED");
    }
  });

  it("refuses a revoked token", () => {
    const { token, row } = createAgentToken({ role: "payer", allowSign: true });
    expect(agentFromAuthorization(bearer(token))?.role).toBe("payer");
    expect(revokeAgentToken(row.id)).toBe(true);
    const err = authError(() => agentFromAuthorization(bearer(token)));
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toMatch(/revoked/);
    expect(revokeAgentToken(row.id)).toBe(false);
  });
});

describe("requireAgentScope", () => {
  const agent = (scopes: AgentPrincipal["scopes"]): AgentPrincipal => ({ tokenId: "t", role: "payer", scopes, label: "" });

  it("refuses signing without the sign scope", () => {
    const err = authError(() => requireAgentScope(agent(["read", "write"]), "sign"));
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toMatch(/--allow-sign/);
    expect(() => requireAgentScope(agent(["read", "write", "sign"]), "sign")).not.toThrow();
  });

  it("refuses funding to every token, whatever its scopes", () => {
    const all = agent(["read", "write", "sign"]);
    const err = authError(() => requireAgentScope(all, "fund"));
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe(FUND_REFUSAL);
    expect(hasScope(all, "fund")).toBe(false);
  });

  it("refuses writes to a read-only token", () => {
    expect(authError(() => requireAgentScope(agent(["read"]), "write")).code).toBe("FORBIDDEN");
    expect(() => requireAgentScope(agent(["read"]), "read")).not.toThrow();
  });
});
