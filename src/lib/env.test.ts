import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clauseModel,
  contestWindowSeconds,
  githubToken,
  MissingEnvError,
  PAYPAL_API_BASE,
  requireAI,
  requirePayPal,
  requirePayPalWebhook,
} from "./env";

const KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "CLAUSE_MODEL",
  "GITHUB_TOKEN",
  "CLAUSE_CONTEST_WINDOW_SECONDS",
];

beforeEach(() => {
  for (const key of KEYS) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requirePayPal", () => {
  it("names every missing variable", () => {
    expect(() => requirePayPal()).toThrow(MissingEnvError);
    expect(() => requirePayPal()).toThrow(
      "PayPal is not configured: missing PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET. Set them in .env (see .env.example).",
    );
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    expect(() => requirePayPal()).toThrow(/missing PAYPAL_CLIENT_SECRET\. Set it/);
  });

  it("treats whitespace as missing", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "  ");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    expect(() => requirePayPal()).toThrow(/missing PAYPAL_CLIENT_ID\b/);
  });

  it("returns credentials and the sandbox base URL", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    expect(requirePayPal()).toEqual({ clientId: "id", clientSecret: "secret", apiBase: PAYPAL_API_BASE });
    expect(PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });

  it("needs the webhook id for webhook verification", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    expect(() => requirePayPalWebhook()).toThrow(/missing PAYPAL_WEBHOOK_ID/);
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "wh");
    expect(requirePayPalWebhook().webhookId).toBe("wh");
  });
});

describe("requireAI", () => {
  it("throws a specific error without a key", () => {
    const error = (() => {
      try {
        requireAI();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MissingEnvError);
    expect(error).toMatchObject({ feature: "AI (DeepSeek)", missing: ["DEEPSEEK_API_KEY"] });
    expect(String(error)).toMatch(/missing DEEPSEEK_API_KEY\. Set it in \.env/);
  });

  it("returns the key with the default base URL and model", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    expect(requireAI()).toEqual({ apiKey: "sk-test", baseURL: "https://api.deepseek.com", model: "deepseek-flash" });
  });

  it("uses the configured base URL and model", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://proxy.example/v1/");
    vi.stubEnv("CLAUSE_MODEL", "deepseek-v4-pro");
    expect(requireAI()).toEqual({ apiKey: "sk-test", baseURL: "https://proxy.example/v1", model: "deepseek-v4-pro" });
    expect(clauseModel()).toBe("deepseek-v4-pro");
  });
});

describe("optional settings", () => {
  it("GITHUB_TOKEN is optional", () => {
    expect(githubToken()).toBeUndefined();
    vi.stubEnv("GITHUB_TOKEN", "ghp_x");
    expect(githubToken()).toBe("ghp_x");
  });

  it("contest window defaults to 0 and rejects junk", () => {
    expect(contestWindowSeconds()).toBe(0);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "30");
    expect(contestWindowSeconds()).toBe(30);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "-1");
    expect(() => contestWindowSeconds()).toThrow(/whole number/);
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "soon");
    expect(() => contestWindowSeconds()).toThrow(/whole number/);
  });
});
