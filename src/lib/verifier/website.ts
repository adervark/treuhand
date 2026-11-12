/**
 * Deterministic website checks. Each one is decided by code from what the
 * page actually does; nothing here asks the model.
 */
import http from "node:http";
import https from "node:https";
import type { Locator } from "playwright";
import type { CheckContext, CheckResult } from "./index";
import { evaluateIsolated, targetUrl, withPage } from "./browser";
import { saveScreenshot } from "./evidence";
import { assertAllowedUrl, BlockedTargetError, guardedLookup, HostNotFoundError, resolvePublicHost } from "./net-guard";
import { clip, describeError, fail, inconclusive, pass } from "./result";
import { VISIBLE_TEXT_JS } from "./visible-text";

const HTTP_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; ProvisoVerifier/1.0)";
const SUCCESS_WAIT_MS = 10_000;

async function screenshotEvidence(ctx: CheckContext, label: string, take: () => Promise<Buffer>): Promise<string[]> {
  try {
    return [await saveScreenshot(ctx, label, await take())];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// http_ok
// ---------------------------------------------------------------------------

interface Hop {
  url: string;
  status: number;
  location?: string;
  content_type?: string;
}

/** One GET without following redirects; connects only to vetted public addresses. */
function getOnce(url: URL): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: HTTP_TIMEOUT_MS,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      },
      (res) => {
        const hop: Hop = { url: url.href, status: res.statusCode ?? 0 };
        if (typeof res.headers.location === "string") hop.location = res.headers.location;
        if (res.headers["content-type"]) hop.content_type = String(res.headers["content-type"]);
        res.destroy(); // the status is all this check needs
        resolve(hop);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

async function followRedirects(start: URL): Promise<Hop[]> {
  const hops: Hop[] = [];
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await resolvePublicHost(url.hostname); // IP literals skip `lookup`, so check every hop here too
    const hop = await getOnce(url);
    hops.push(hop);
    if (hop.status < 300 || hop.status >= 400 || !hop.location) return hops;
    url = assertAllowedUrl(new URL(hop.location, url).href);
  }
  throw Object.assign(new Error(`more than ${MAX_REDIRECTS} redirects`), { code: "ETOOMANYREDIRECTS" });
}

export async function checkHttpOk(ctx: CheckContext<"http_ok">): Promise<CheckResult> {
  const url = targetUrl(ctx.submission.url, ctx.params.path);
  const evidence = { url };
  let start: URL;
  try {
    start = assertAllowedUrl(url);
  } catch (error) {
    return fail(`The verifier will not visit this URL: ${(error as Error).message}`, evidence);
  }

  let lastError: unknown = null;
  let lastHops: Hop[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const started = Date.now();
    try {
      const hops = await followRedirects(start);
      const final = hops.at(-1)!;
      const result = { ...evidence, responses: hops, final_url: final.url, http_status: final.status, duration_ms: Date.now() - started, attempts: attempt };
      if (final.status >= 200 && final.status < 300) {
        return pass(`The page answered HTTP ${final.status}${hops.length > 1 ? ` after ${hops.length - 1} redirect(s)` : ""}.`, result);
      }
      if (final.status >= 500 && attempt === 1) {
        lastHops = hops;
        continue;
      }
      if (final.status >= 300 && final.status < 400) {
        return fail(`The page answered HTTP ${final.status} without a usable redirect target.`, result);
      }
      return fail(`The page answered HTTP ${final.status}, not a successful (2xx) response.`, result);
    } catch (error) {
      if (error instanceof BlockedTargetError) {
        return fail(`The URL leads to an address the verifier refuses to visit: ${error.message}`, { ...evidence, refused: error.message });
      }
      if (error instanceof HostNotFoundError || (error as NodeJS.ErrnoException).code === "ENOTFOUND") {
        return fail(`The domain ${start.hostname} does not resolve.`, { ...evidence, dns: "not found" });
      }
      if ((error as NodeJS.ErrnoException).code === "EBLOCKED") {
        return fail(`The URL resolves to an address the verifier refuses to visit: ${(error as Error).message}`, evidence);
      }
      if ((error as NodeJS.ErrnoException).code === "ETOOMANYREDIRECTS") {
        return fail(`The page redirects more than ${MAX_REDIRECTS} times.`, evidence);
      }
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) {
        return fail(`The site's HTTPS connection is invalid (${code}).`, { ...evidence, error: describeError(error) });
      }
      lastError = error;
    }
  }
  if (lastError === null) {
    const final = lastHops.at(-1)!;
    return fail(`The page answered HTTP ${final.status} twice, not a successful (2xx) response.`, {
      ...evidence,
      responses: lastHops,
      http_status: final.status,
      attempts: 2,
    });
  }
  return inconclusive(`The site could not be reached: ${describeError(lastError).message}. Tried twice.`, { ...evidence, attempts: 2 }, lastError);
}

// ---------------------------------------------------------------------------
// dom_assert
// ---------------------------------------------------------------------------

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const MAX_ELEMENTS = 500;

interface DomElement {
  /** null when a visitor can see it; otherwise why not. Elements in <head> count as present. */
  hidden: string | null;
  in_head: boolean;
  text: string;
  html: string;
  /** Document coordinates, for the evidence screenshot. */
  box: { x: number; y: number; width: number; height: number };
}

/**
 * In-page script, run with `evaluateIsolated` so the page's own scripts
 * cannot fake an element's text or visibility. Finds the elements matching a
 * CSS selector (open shadow roots included, as Playwright's CSS engine does)
 * and says for each whether a visitor can see it: not hidden by display,
 * visibility or opacity, not zero-size, not moved off the page, not clipped
 * to a 1-2 px box. Each element's text leaves out hidden text inside it
 * (same-colour, tiny, transparent, off-screen; see visible-text.ts).
 */
const domAssertScript = (selector: string, max: number) => `(() => {
  ${VISIBLE_TEXT_JS}
  const selector = ${JSON.stringify(selector)};
  const found = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll(selector)) found.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
  };
  try {
    visit(document);
  } catch (error) {
    if (error instanceof DOMException && error.name === "SyntaxError") return { invalid: error.message };
    throw error;
  }
  const textShown = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const elementHidden = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "contents") {
      for (const child of el.childNodes) {
        if (child.nodeType === 1 && !elementHidden(child)) return null;
        if (child.nodeType === 3 && child.data.trim() && textShown(child)) return null;
      }
      return "nothing in it is displayed";
    }
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
      return "not displayed (display, visibility or opacity)";
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return "zero size";
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return "moved off the page";
    if ((style.overflow !== "visible" || style.clipPath !== "none" || style.clip !== "auto") && (r.width <= 2 || r.height <= 2)) {
      return "clipped to a tiny box";
    }
    return null;
  };
  // Measure first: blanking hidden text below could shift the layout.
  const elements = found.slice(0, ${max}).map((el) => {
    const inHead = !!el.closest("head");
    const r = el.getBoundingClientRect();
    return {
      el,
      hidden: inHead ? null : elementHidden(el),
      in_head: inHead,
      html: el.outerHTML.slice(0, 300),
      box: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
    };
  });
  // An element's text is what a visitor can read in it: hidden text inside it does not count.
  const hiddenNodes = document.body ? hiddenTextNodes(document.body) : [];
  const texts = withHiddenTextBlanked(hiddenNodes, () =>
    elements.map(({ el, in_head }) =>
      String((el instanceof HTMLMetaElement ? el.content : in_head ? el.textContent : el.innerText ?? el.textContent) ?? "").slice(0, 5000),
    ),
  );
  return {
    count: found.length,
    elements: elements.map(({ el, ...rest }, i) => ({ ...rest, text: texts[i] })),
    hidden_text: { count: hiddenNodes.length, sample: hiddenNodes.slice(0, 5).map((h) => ({ reason: h.reason, text: h.text.trim().slice(0, 160) })) },
  };
})()`;

export async function checkDomAssert(ctx: CheckContext<"dom_assert">): Promise<CheckResult> {
  const { selector, text } = ctx.params;
  const url = targetUrl(ctx.submission.url, ctx.params.path);
  return withPage(url, {}, { selector, ...(text ? { text } : {}) }, async ({ page, evidence }) => {
    const found = await evaluateIsolated<
      { invalid: string } | { count: number; elements: DomElement[]; hidden_text: { count: number; sample: { reason: string; text: string }[] } }
    >(
      page,
      domAssertScript(selector, MAX_ELEMENTS),
    );
    if ("invalid" in found) {
      return fail(`The condition's selector "${selector}" is not valid, so it can never match; this needs the parties or a human.`, {
        ...evidence,
        error: { name: "SyntaxError", message: clip(found.invalid, 300) },
      });
    }
    const { count } = found;
    const matches = found.elements.map((el) => ({
      visible: el.hidden === null,
      ...(el.hidden ? { hidden: el.hidden } : {}),
      in_head: el.in_head,
      text: clip(el.text, 200),
      html: clip(el.html, 200),
      matches_text: text === undefined || normalize(el.text).includes(normalize(text)),
    }));
    const firstIndex = matches.findIndex((m) => m.visible && m.matches_text);
    const firstMatch = firstIndex >= 0 ? found.elements[firstIndex] : null;

    const box = firstMatch && !firstMatch.in_head ? firstMatch.box : null;
    let screenshots = box
      ? await screenshotEvidence(ctx, "element", () =>
          page.screenshot({
            type: "jpeg",
            quality: 75,
            fullPage: true,
            clip: {
              x: Math.max(0, box.x - 8),
              y: Math.max(0, box.y - 8),
              width: Math.max(1, box.width + 16),
              height: Math.max(1, Math.min(box.height + 16, 3_000)),
            },
            timeout: 10_000,
          }),
        )
      : [];
    if (screenshots.length === 0) {
      screenshots = await screenshotEvidence(ctx, "page", () => page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }));
    }
    const observed = {
      ...evidence,
      screenshots,
      matched_elements: count,
      elements: matches.slice(0, 5),
      ...(found.hidden_text.count > 0 ? { hidden_text_ignored: found.hidden_text } : {}),
    };

    if (count === 0) return fail(`No element on the page matches "${selector}".`, observed);
    if (firstMatch) {
      return pass(
        text === undefined
          ? `Found ${count} element(s) matching "${selector}", at least one visible.`
          : `An element matching "${selector}" is visible and contains "${text}".`,
        observed,
      );
    }
    if (!matches.some((m) => m.visible)) {
      return fail(`${count} element(s) match "${selector}", but none is visible on the page.`, observed);
    }
    return fail(`Elements match "${selector}", but none of the visible ones contains "${text}".`, observed);
  });
}

// ---------------------------------------------------------------------------
// responsive
// ---------------------------------------------------------------------------

/**
 * In-page script (a string so bundler helpers never leak into the page).
 * Lists elements that stick out past the phone's width.
 */
const overflowScript = (width: number) => `(() => {
  const width = ${width};
  const doc = document.documentElement;
  const offenders = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > width + 1 || r.left < -1) {
      const id = el.id ? "#" + el.id : "";
      const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
      offenders.push({ element: el.tagName.toLowerCase() + id + cls, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }
  }
  offenders.sort((a, b) => b.width - a.width);
  return {
    inner_width: window.innerWidth,
    client_width: doc.clientWidth,
    scroll_width: doc.scrollWidth,
    body_scroll_width: document.body ? document.body.scrollWidth : 0,
    viewport_meta: (document.querySelector('meta[name="viewport"]') || {}).content || null,
    offenders: offenders.slice(0, 5),
  };
})()`;

interface OverflowMeasure {
  inner_width: number;
  client_width: number;
  scroll_width: number;
  body_scroll_width: number;
  viewport_meta: string | null;
  offenders: { element: string; left: number; right: number; width: number }[];
}

export async function checkResponsive(ctx: CheckContext<"responsive">): Promise<CheckResult> {
  const width = ctx.params.width;
  const url = targetUrl(ctx.submission.url, ctx.params.path);
  const viewport = { width, height: 812 };
  return withPage(url, { viewport, mobile: true }, { width }, async ({ page, evidence }) => {
    const measure = await evaluateIsolated<OverflowMeasure>(page, overflowScript(width));
    const screenshots = await screenshotEvidence(ctx, `${width}px`, () =>
      page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }),
    );
    const observed = { ...evidence, screenshots, measurements: measure };

    if (!/width\s*=\s*device-width/i.test(measure.viewport_meta ?? "")) {
      return fail(
        `The page has no mobile viewport tag (<meta name="viewport" content="width=device-width">), so a ${width} px wide ` +
          `phone lays it out ${measure.inner_width} px wide and shrinks it to fit.`,
        observed,
      );
    }
    const pageWidth = Math.max(measure.inner_width, measure.scroll_width);
    if (pageWidth > width + 1) {
      const worst = measure.offenders[0];
      return fail(
        `On a ${width} px wide phone the page is ${pageWidth} px wide, so it scrolls sideways or is shrunk to fit` +
          (worst ? ` (widest element sticking out: ${worst.element}, ${worst.width} px).` : "."),
        observed,
      );
    }
    return pass(`At ${width} px wide the page fits the screen (${measure.scroll_width} px) with no sideways scrolling.`, observed);
  });
}

// ---------------------------------------------------------------------------
// form_submits
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["true", "on", "yes", "1", "checked"]);

async function countVisible(locator: Locator): Promise<number> {
  try {
    return await locator.filter({ visible: true }).count();
  } catch {
    return 0; // mid-navigation: the old document is gone and the new one is not ready
  }
}

export async function checkFormSubmits(ctx: CheckContext<"form_submits">): Promise<CheckResult> {
  const { form_selector, fields, success_text } = ctx.params;
  const url = targetUrl(ctx.submission.url, ctx.params.path);
  return withPage(url, {}, { form_selector, success_text }, async ({ page, evidence }) => {
    const requests: { method: string; url: string; status?: number }[] = [];
    // A fail before submitting still shows both parties what the page looked like.
    const failWithPage = async (reasoning: string, extra: Record<string, unknown> = {}) =>
      fail(reasoning, {
        ...evidence,
        ...extra,
        screenshots: await screenshotEvidence(ctx, "page", () => page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 })),
      });
    const form = page.locator(form_selector).first();
    let formCount: number;
    try {
      formCount = await page.locator(form_selector).count();
    } catch (error) {
      return fail(`The condition's form selector "${form_selector}" is not valid; this needs the parties or a human.`, {
        ...evidence,
        error: describeError(error),
      });
    }
    if (formCount === 0) return failWithPage(`No form matching "${form_selector}" is on the page.`);
    if (!(await form.isVisible())) return failWithPage(`The form "${form_selector}" is on the page but not visible.`);

    const filled: { selector: string; value: string; how: string }[] = [];
    for (const [selector, value] of Object.entries(fields)) {
      const inForm = form.locator(selector);
      let field: Locator;
      try {
        field = (await inForm.count()) > 0 ? inForm.first() : page.locator(selector).first();
        if ((await field.count()) === 0) return failWithPage(`The form has no field matching "${selector}".`, { filled });
      } catch (error) {
        return fail(`The field selector "${selector}" is not valid; this needs the parties or a human.`, {
          ...evidence,
          error: describeError(error),
        });
      }
      const kind = await field.evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
      }));
      try {
        if (kind.tag === "select") {
          await field.selectOption(value, { timeout: 5_000 });
          filled.push({ selector, value, how: "selected" });
        } else if (kind.tag === "input" && (kind.type === "checkbox" || kind.type === "radio")) {
          if (TRUTHY.has(value.trim().toLowerCase())) await field.check({ timeout: 5_000 });
          else await field.uncheck({ timeout: 5_000 });
          filled.push({ selector, value, how: "checked" });
        } else {
          await field.fill(value, { timeout: 5_000 });
          filled.push({ selector, value, how: "typed" });
        }
      } catch (error) {
        return failWithPage(`The field "${selector}" could not be filled in: ${describeError(error).message}`, { filled });
      }
    }

    const success = page.getByText(success_text);
    const before = await countVisible(success);

    page.on("request", (req) => {
      if (req.method() !== "GET" || req.isNavigationRequest()) requests.push({ method: req.method(), url: req.url() });
    });
    page.on("response", (res) => {
      const entry = requests.find((r) => r.url === res.url() && r.status === undefined);
      if (entry) entry.status = res.status();
    });

    const submitButton = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    let how: string;
    try {
      if ((await submitButton.count()) > 0 && (await submitButton.isVisible())) {
        await submitButton.click({ timeout: 5_000 });
        how = "clicked the submit button";
      } else {
        const isForm = await form.evaluate((el) => el instanceof HTMLFormElement);
        if (!isForm) return failWithPage(`"${form_selector}" has no visible submit button and is not a <form>, so it cannot be submitted.`, { filled });
        await form.evaluate((el) => (el as HTMLFormElement).requestSubmit());
        how = "submitted the form (no visible submit button)";
      }
    } catch (error) {
      return failWithPage(`The form could not be submitted: ${describeError(error).message}`, { filled });
    }

    const started = Date.now();
    let after = before;
    while (Date.now() - started < SUCCESS_WAIT_MS) {
      after = await countVisible(success);
      if (after > before) break;
      await page.waitForTimeout(250);
    }
    const waitedMs = Date.now() - started;
    const screenshots = await screenshotEvidence(ctx, "after-submit", () =>
      page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }),
    );
    const observed = {
      ...evidence,
      screenshots,
      filled,
      submitted: how,
      requests: requests.slice(0, 10),
      success_text_visible_before: before,
      success_text_visible_after: after,
      wait_ms: waitedMs,
      url_after_submit: page.url(),
    };

    if (after > before) {
      return pass(`Filled ${filled.length} field(s), ${how}, and "${success_text}" appeared ${waitedMs < 1000 ? "at once" : `after ${(waitedMs / 1000).toFixed(1)} s`}.`, observed);
    }
    const failedRequest = requests.find((r) => r.status !== undefined && r.status >= 400);
    if (before > 0) {
      return fail(`"${success_text}" was already on the page before submitting, and submitting did not show it again, so it proves nothing.`, observed);
    }
    return fail(
      `After submitting, "${success_text}" did not appear within ${SUCCESS_WAIT_MS / 1000} s` +
        (failedRequest ? ` (the submission got HTTP ${failedRequest.status} from ${failedRequest.url}).` : "."),
      observed,
    );
  });
}
