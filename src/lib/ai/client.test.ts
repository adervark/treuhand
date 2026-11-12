import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError } from "@/lib/env";
import { getAIClient } from "./client";

beforeEach(() => {
  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "CLAUSE_MODEL"]) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getAIClient", () => {
  it("throws MissingEnvError naming DEEPSEEK_API_KEY when it is not set", () => {
    expect(() => getAIClient()).toThrow(MissingEnvError);
    expect(() => getAIClient()).toThrow(/missing DEEPSEEK_API_KEY/);
  });

  it("returns an OpenAI client pointed at DeepSeek with the default model", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    const { client, model } = getAIClient();
    expect(client).toBeInstanceOf(OpenAI);
    expect(client.apiKey).toBe("sk-test");
    expect(client.baseURL).toBe("https://api.deepseek.com");
    expect(model).toBe("deepseek-flash");
  });

  it("uses DEEPSEEK_BASE_URL and CLAUSE_MODEL when set", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://proxy.example/v1");
    vi.stubEnv("CLAUSE_MODEL", "deepseek-v4-pro");
    const { client, model } = getAIClient();
    expect(client.baseURL).toBe("https://proxy.example/v1");
    expect(model).toBe("deepseek-v4-pro");
  });

  it("makes no network call when building the client", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    getAIClient();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
