/**
 * Loading a submitted page in a guarded, disposable Chromium.
 *
 * `withPage` vets the URL, starts the guard proxy, launches a fresh browser
 * whose every connection goes through that proxy, loads the page (one retry
 * on a transient failure), and hands the loaded page to the check. A failed
 * load becomes a fail (the page is not there: bad status, dead domain,
 * private address, bad certificate) or inconclusive (timeout, reset). The
 * browser is always closed, and a hard deadline closes it even if the page
 * hangs the renderer.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { VerdictEvidence } from "@/lib/types";
import type { CheckResult } from "./index";
import { startGuardProxy, type GuardProxy, type ProxyLogEntry } from "./guard-proxy";
import { assertAllowedUrl, BlockedTargetError, HostNotFoundError, resolvePublicHost } from "./net-guard";
import { describeError, fail, inconclusive } from "./result";

export const NAVIGATION_TIMEOUT_MS = 20_000;
const NETWORK_IDLE_WAIT_MS = 4_000;
const DEFAULT_DEADLINE_MS = 75_000;
const RETRY_DELAY_MS = 1_000;

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

/**
 * The page a check looks at: the submitted URL, with the condition's `path`
 * appended to its path (so `/contact` on `https://x.dev/site/` is
 * `https://x.dev/site/contact`). Assigning `pathname` cannot change the host.
 */
export function targetUrl(submissionUrl: string, pagePath?: string): string {
  const url = new URL(submissionUrl);
  url.hash = "";
  if (pagePath) url.pathname = url.pathname.replace(/\/+$/, "") + pagePath;
  return url.href;
}

export interface PageOptions {
  viewport?: { width: number; height: number };
  /** Emulates a phone: honours `<meta name="viewport">`, touch, mobile UA. */
  mobile?: boolean;
  /** Hard limit for the whole browser session. */
  deadlineMs?: number;
}

export interface LoadedPage {
  page: Page;
  context: BrowserContext;
  url: string;
  finalUrl: string;
  status: number;
  loadMs: number;
  /** Load facts for the verdict's evidence. */
  evidence: VerdictEvidence;
}

type LoadFailure = { kind: "fail" | "transient"; reasoning: string; error?: unknown };

function proxyFailureFor(log: ProxyLogEntry[], host: string): ProxyLogEntry | undefined {
  return log.find((entry) => entry.host === host && entry.outcome !== "error") ?? log.find((e) => e.host === host);
}

function classifyNavigationError(error: unknown, url: URL, proxy: GuardProxy): LoadFailure {
  const message = error instanceof Error ? error.message : String(error);
  const netError = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (error instanceof Error && error.name === "TimeoutError") {
    return { kind: "transient", reasoning: `The page did not finish loading within ${NAVIGATION_TIMEOUT_MS / 1000} s.`, error };
  }
  if (/Download is starting/i.test(message)) {
    return { kind: "fail", reasoning: "The URL starts a file download instead of showing a web page.", error };
  }
  if (netError?.startsWith("ERR_CERT_") || netError?.startsWith("ERR_SSL_")) {
    return { kind: "fail", reasoning: `The site's HTTPS connection is invalid (${netError}).`, error };
  }
  if (netError === "ERR_TOO_MANY_REDIRECTS") {
    return { kind: "fail", reasoning: "The page redirects in a loop (too many redirects).", error };
  }
  if (netError === "ERR_NAME_NOT_RESOLVED") {
    return { kind: "fail", reasoning: `The domain ${url.hostname} does not resolve.`, error };
  }
  if (netError === "ERR_TUNNEL_CONNECTION_FAILED" || netError === "ERR_EMPTY_RESPONSE" || netError === "ERR_PROXY_CONNECTION_FAILED") {
    // The guard proxy refused or could not reach a target; find out which and why.
    const entry = proxyFailureFor(proxy.log, url.hostname.replace(/^\[|\]$/g, "")) ?? proxy.log.at(-1);
    if (entry?.outcome === "blocked") {
      return { kind: "fail", reasoning: `The page led to a refused address: ${entry.reason}`, error };
    }
    if (entry?.outcome === "not_found") return { kind: "fail", reasoning: entry.reason, error };
    return { kind: "transient", reasoning: `The site could not be reached (${entry?.reason ?? netError}).`, error };
  }
  return { kind: "transient", reasoning: `The page could not be loaded (${netError ?? message.split("\n")[0]}).`, error };
}

/**
 * Runs an in-page script (an expression string returning JSON) in a fresh
 * isolated world of the page's main frame. The DOM is the page's, but the
 * JavaScript globals and prototypes are not: a hostile page that redefines
 * `innerText`, `getBoundingClientRect`, `scrollWidth`, `innerWidth` or
 * `querySelectorAll` in its own world cannot change what the verifier reads.
 * (`page.evaluate` runs in the page's world, where it can.)
 */
export async function evaluateIsolated<T>(page: Page, expression: string): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "clause-verifier",
    });
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`In-page script failed: ${exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text}`);
    }
    return result.value as T;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function launch(proxy: GuardProxy, options: PageOptions): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: true,
    // "<-loopback>" sends localhost and 127.0.0.1 through the guard proxy too (Chromium bypasses
    // proxies for loopback by default; Playwright undoes that unless an env var says otherwise).
    proxy: { server: proxy.url, bypass: "<-loopback>" },
    args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking"],
    timeout: 30_000,
  });
  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? DESKTOP_VIEWPORT,
      isMobile: options.mobile ?? false,
      hasTouch: options.mobile ?? false,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return { browser, context };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function load(
  context: BrowserContext,
  url: URL,
  proxy: GuardProxy,
): Promise<{ ok: true; page: Page; response: Response; loadMs: number; attempts: number } | { ok: false; failure: LoadFailure; attempts: number; status?: number }> {
  let last: LoadFailure | null = null;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    const page = await context.newPage();
    const started = Date.now();
    try {
      const response = await page.goto(url.href, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      if (!response) {
        last = { kind: "transient", reasoning: "The browser got no response for the page." };
      } else if (response.status() >= 500) {
        lastStatus = response.status();
        last = { kind: "fail", reasoning: `The page returned HTTP ${response.status()}.` };
      } else {
        const loadMs = Date.now() - started;
        await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_WAIT_MS }).catch(() => undefined);
        return { ok: true, page, response, loadMs, attempts: attempt };
      }
    } catch (error) {
      last = classifyNavigationError(error, url, proxy);
      if (last.kind === "fail") {
        await page.close().catch(() => undefined);
        return { ok: false, failure: last, attempts: attempt };
      }
    }
    await page.close().catch(() => undefined);
  }
  return { ok: false, failure: last!, attempts: 2, status: lastStatus };
}

/**
 * Runs `check` on the loaded page and always tears the browser down.
 * `baseEvidence` is merged into every result, including load failures.
 */
export async function withPage(
  rawUrl: string,
  options: PageOptions,
  baseEvidence: VerdictEvidence,
  check: (loaded: LoadedPage) => Promise<CheckResult>,
): Promise<CheckResult> {
  const evidence: VerdictEvidence = { ...baseEvidence, url: rawUrl };

  let url: URL;
  try {
    url = assertAllowedUrl(rawUrl);
    await resolvePublicHost(url.hostname);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return fail(`The verifier will not visit this URL: ${error.message}`, { ...evidence, refused: error.message });
    }
    if (error instanceof HostNotFoundError) return fail(error.message, { ...evidence, dns: "not found" });
    return inconclusive(`The domain ${rawUrl} could not be looked up right now.`, evidence, error);
  }

  const proxy = await startGuardProxy();
  let browser: Browser | null = null;
  let timedOut = false;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const killer = setTimeout(() => {
    timedOut = true;
    void browser?.close().catch(() => undefined);
  }, deadlineMs);
  const proxyEvidence = () =>
    proxy.log.length > 0 ? { refused_or_failed_requests: proxy.log.slice(0, 10).map((e) => ({ ...e })) } : {};

  try {
    const launched = await launch(proxy, options);
    browser = launched.browser;
    const loaded = await load(launched.context, url, proxy);
    if (!loaded.ok) {
      const loadEvidence = {
        ...evidence,
        ...(loaded.status ? { http_status: loaded.status } : {}),
        load_attempts: loaded.attempts,
        ...proxyEvidence(),
      };
      if (loaded.failure.kind === "fail") return fail(loaded.failure.reasoning, loadEvidence);
      return inconclusive(
        `${loaded.failure.reasoning} Tried ${loaded.attempts} time${loaded.attempts === 1 ? "" : "s"}.`,
        loadEvidence,
        loaded.failure.error,
      );
    }

    const status = loaded.response.status();
    const finalUrl = loaded.page.url();
    const pageEvidence: VerdictEvidence = {
      ...evidence,
      final_url: finalUrl,
      http_status: status,
      load_ms: loaded.loadMs,
      load_attempts: loaded.attempts,
      ...proxyEvidence(),
    };
    if (loaded.response.headers()["x-clause-proxy"] === "blocked") {
      return fail("The page redirected to a private or local network address, which the verifier refuses to visit.", pageEvidence);
    }
    if (status < 200 || status >= 300) {
      return fail(`The page returned HTTP ${status}, not a successful (2xx) response.`, pageEvidence);
    }
    return await check({
      page: loaded.page,
      context: launched.context,
      url: url.href,
      finalUrl,
      status,
      loadMs: loaded.loadMs,
      evidence: pageEvidence,
    });
  } catch (error) {
    if (timedOut) {
      return inconclusive(`The check did not finish within ${deadlineMs / 1000} s, so the browser was stopped.`, {
        ...evidence,
        ...proxyEvidence(),
      });
    }
    return inconclusive(`The browser check could not complete: ${describeError(error).message}`, { ...evidence, ...proxyEvidence() }, error);
  } finally {
    clearTimeout(killer);
    await browser?.close().catch(() => undefined);
    await proxy.close();
  }
}
