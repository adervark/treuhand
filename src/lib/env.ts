/**
 * Environment access. Variables are read when a getter is called, not at
 * import, so the app builds and pages that need no keys render without them.
 * Each external client calls its `require*()` getter, which throws
 * MissingEnvError naming every missing variable. There are no mock fallbacks.
 */

export class MissingEnvError extends Error {
  constructor(
    readonly feature: string,
    readonly missing: string[],
  ) {
    super(
      `${feature} is not configured: missing ${missing.join(", ")}. ` +
        `Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`,
    );
    this.name = "MissingEnvError";
  }
}

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireAll<const K extends string>(feature: string, names: readonly K[]): Record<K, string> {
  const missing = names.filter((name) => !read(name));
  if (missing.length > 0) throw new MissingEnvError(feature, missing);
  return Object.fromEntries(names.map((name) => [name, read(name)])) as Record<K, string>;
}

/** PayPal REST API base: Clause runs against the sandbox only. */
export const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";

export const DEFAULT_CLAUSE_MODEL = "deepseek-flash";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** PayPal REST credentials for orders, payouts and refunds. */
export function requirePayPal(): { clientId: string; clientSecret: string; apiBase: string } {
  const env = requireAll("PayPal", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  return { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, apiBase: PAYPAL_API_BASE };
}

/** PayPal webhook signature verification needs the webhook id as well as the credentials. */
export function requirePayPalWebhook(): { clientId: string; clientSecret: string; apiBase: string; webhookId: string } {
  const env = requireAll("PayPal webhooks", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]);
  return {
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    apiBase: PAYPAL_API_BASE,
    webhookId: env.PAYPAL_WEBHOOK_ID,
  };
}

/** PayPal client id alone, for the browser-side JS SDK button. */
export function requirePayPalClientId(): string {
  return requireAll("PayPal checkout button", ["PAYPAL_CLIENT_ID"]).PAYPAL_CLIENT_ID;
}

/**
 * DeepSeek through its OpenAI-compatible API: pass these to the `openai`
 * client as `new OpenAI({ apiKey, baseURL })` and use `model` per request.
 */
export function requireAI(): { apiKey: string; baseURL: string; model: string } {
  const env = requireAll("AI (DeepSeek)", ["DEEPSEEK_API_KEY"]);
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: (read("DEEPSEEK_BASE_URL") ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ""),
    model: clauseModel(),
  };
}

export function clauseModel(): string {
  return read("CLAUSE_MODEL") ?? DEFAULT_CLAUSE_MODEL;
}

/** Optional: raises GitHub API rate limits when set. */
export function githubToken(): string | undefined {
  return read("GITHUB_TOKEN");
}

/**
 * Opt-in: post each finished run's verdict as a comment on a code bounty's
 * pull request (src/lib/contract/service-pr-comment.ts). Off unless set to
 * 1, true, yes or on; it also needs GITHUB_TOKEN.
 */
export function githubPrComments(): boolean {
  const raw = read("CLAUSE_GITHUB_PR_COMMENTS")?.toLowerCase();
  if (raw === undefined || ["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  throw new Error(`CLAUSE_GITHUB_PR_COMMENTS must be 1 or 0 (or true/false, yes/no, on/off), got "${raw}"`);
}

/**
 * The app's public origin from RENDER_EXTERNAL_URL (the base page metadata
 * uses), or undefined when it is unset, not https, or a loopback host: links
 * posted outside the app never point at localhost.
 */
export function publicAppUrl(): string | undefined {
  const raw = read("RENDER_EXTERNAL_URL");
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "0.0.0.0";
  return url.protocol === "https:" && !loopback ? url.origin : undefined;
}

/** Seconds between PASSED and automatic payout; 0 (the default) pays at once. */
export function contestWindowSeconds(): number {
  const raw = read("CLAUSE_CONTEST_WINDOW_SECONDS");
  if (raw === undefined) return 0;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(`CLAUSE_CONTEST_WINDOW_SECONDS must be a whole number of seconds, got "${raw}"`);
  }
  return seconds;
}
