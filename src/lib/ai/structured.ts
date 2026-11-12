/**
 * One structured call to the model: system + user prompt in, a zod-validated
 * value out. DeepSeek's JSON output mode (`response_format: json_object`)
 * guarantees syntactically valid JSON or a blank reply; the zod schema checks
 * the shape and any business rules. When either fails, the reply and the exact
 * problem are sent back and the model tries again, at most `maxAttempts`
 * times, after which AIOutputError is thrown. Network and HTTP errors are not
 * retried here (the openai client already retries those) and propagate as-is.
 *
 * Thinking mode stays on: it is DeepSeek's default, JSON output works with it,
 * and the drafter and mediator are judgement calls. (Tool calling with a forced
 * `tool_choice` would need thinking off, which is why JSON output is used.)
 */
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { getAIClient } from "./client";

export const DEFAULT_MAX_ATTEMPTS = 3;
/** Covers the reasoning tokens as well as the JSON reply. */
const MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 120_000;

/** The model returned no usable output within the attempt budget. */
export class AIOutputError extends Error {
  constructor(
    /** Which AI role failed, e.g. "drafter". */
    readonly task: string,
    readonly attempts: number,
    /** One entry per failed attempt, in order. */
    readonly problems: string[],
  ) {
    super(
      `${task}: the model returned no valid output in ${attempts} attempt${attempts === 1 ? "" : "s"}. ` +
        `Last problem: ${problems.at(-1) ?? "unknown"}`,
    );
    this.name = "AIOutputError";
  }
}

/** DeepSeek's extension of the OpenAI chat request. */
type DeepSeekChatParams = ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: "enabled" | "disabled" };
};

export interface JsonCallRequest<T> {
  /** Names the AI role in errors. */
  task: string;
  system: string;
  user: string;
  /** Validates the parsed JSON; its error messages are what the model sees on a retry. */
  schema: z.ZodType<T>;
  maxAttempts?: number;
}

export async function callJson<T>(request: JsonCallRequest<T>): Promise<T> {
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const { client, model } = getAIClient();
  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
  const problems: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const params: DeepSeekChatParams = {
      model,
      messages,
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
      max_tokens: MAX_TOKENS,
    };
    const response = await client.chat.completions.create(params, { timeout: REQUEST_TIMEOUT_MS });
    const choice = response.choices[0];
    const content = choice?.message.content ?? "";
    const outcome = validate(content, choice?.finish_reason, request.schema);
    if (outcome.ok) return outcome.value;

    problems.push(outcome.problem);
    messages = [
      ...messages,
      { role: "assistant", content: content.trim() || "(blank reply)" },
      {
        role: "user",
        content:
          `Your reply could not be used:\n${outcome.problem}\n\n` +
          "Reply again with the complete JSON object, corrected, in exactly the format the instructions give.",
      },
    ];
  }
  throw new AIOutputError(request.task, maxAttempts, problems);
}

function validate<T>(
  content: string,
  finishReason: string | undefined,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  if (finishReason === "length") return { ok: false, problem: "The reply was cut off before the JSON was complete." };
  // JSON output mode replaces output it cannot parse with spaces.
  if (!content.trim()) return { ok: false, problem: "The reply was blank: it was not a JSON object." };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { ok: false, problem: `The reply was not valid JSON (${(error as Error).message}).` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, problem: `The JSON did not match the required format:\n${z.prettifyError(result.error)}` };
}
