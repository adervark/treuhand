/**
 * Shared AI client for the drafter, mediator and verifier. DeepSeek is used
 * through its OpenAI-compatible API, so this is the `openai` client pointed
 * at DEEPSEEK_BASE_URL. Nothing is read or sent at import time: env is read
 * when `getAIClient()` is called, and the network only on a request.
 */
import OpenAI from "openai";
import { requireAI } from "@/lib/env";

export interface AIClient {
  client: OpenAI;
  /** Model id for requests (CLAUSE_MODEL, default deepseek-flash). */
  model: string;
}

/**
 * Returns a configured client and the model to use.
 * Throws MissingEnvError (src/lib/env.ts) when DEEPSEEK_API_KEY is not set.
 *
 *   const { client, model } = getAIClient();
 *   const res = await client.chat.completions.create({ model, messages, tools });
 */
export function getAIClient(): AIClient {
  const { apiKey, baseURL, model } = requireAI();
  return { client: new OpenAI({ apiKey, baseURL }), model };
}
