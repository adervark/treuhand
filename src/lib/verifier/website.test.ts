/**
 * Deterministic website checks against the fixture pages, in a real
 * Chromium through the guard proxy. The fixture server is on 127.0.0.1, so
 * these tests enable the test-only private-network flag.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkContext } from "../../../test/fixtures/context";
import { startFixtureServer, type FixtureServer } from "../../../test/fixtures/server";
import { setEvidenceRootForTests } from "./evidence";
import { unsafeAllowPrivateNetworkForTests } from "./net-guard";
import { toVerdictFields } from "./index";
import { checkDomAssert, checkFormSubmits, checkHttpOk, checkResponsive } from "./website";

vi.setConfig({ testTimeout: 60_000 });

let server: FixtureServer;
let evidenceDir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "clause-evidence-"));
  setEvidenceRootForTests(evidenceDir);
  unsafeAllowPrivateNetworkForTests(true);
});

afterAll(async () => {
  unsafeAllowPrivateNetworkForTests(false);
  setEvidenceRootForTests(null);
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  await server.close();
});

const page = (name: string) => `${server.url}/${name}`;
const outcome = (result: Parameters<typeof toVerdictFields>[0]) => toVerdictFields(result).evidence.outcome;

function expectScreenshot(evidence: Record<string, unknown>) {
  const shots = evidence.screenshots as string[];
  expect(shots).toHaveLength(1);
  expect(shots[0]).toMatch(/\.jpg$/);
  expect(fs.statSync(shots[0]).size).toBeGreaterThan(1000);
}

describe("http_ok", () => {
  it("passes a 2xx page", async () => {
    const result = await checkHttpOk(checkContext("http_ok", {}, page("good.html")));
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.evidence).toMatchObject({ http_status: 200 });
  });

  it("follows redirects and appends the condition's path", async () => {
    const result = await checkHttpOk(checkContext("http_ok", { path: "/redirect" }, `${server.url}/`));
    expect(result.passed).toBe(true);
    expect(result.evidence.responses).toEqual([
      expect.objectContaining({ status: 302, url: `${server.url}/redirect` }),
      expect.objectContaining({ status: 200, url: `${server.url}/good.html` }),
    ]);
  });

  it("fails a 404 conclusively", async () => {
    const result = await checkHttpOk(checkContext("http_ok", {}, page("status/404")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.inconclusive).toBeUndefined();
    expect(result.reasoning).toContain("404");
  });

  it("retries a 500 once, then fails", async () => {
    const before = server.requests.filter((r) => r === "GET /status/503").length;
    const result = await checkHttpOk(checkContext("http_ok", {}, page("status/503")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(server.requests.filter((r) => r === "GET /status/503").length - before).toBe(2);
  });

  it("is inconclusive when the connection keeps dropping", async () => {
    const result = await checkHttpOk(checkContext("http_ok", {}, page("reset")));
    expect(result.inconclusive).toBe(true);
    expect(outcome(result)).toBe("inconclusive");
    expect(result.evidence).toMatchObject({ attempts: 2 });
  });
});

describe("dom_assert", () => {
  it("passes when a visible element contains the text, with an element screenshot", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "#brand", text: "bloom & crumb" }, page("good.html")));
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expectScreenshot(result.evidence);
  });

  it("fails when no element matches", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "#gallery-carousel" }, page("good.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("No element");
  });

  it("fails when the element lacks the text", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "#brand", text: "Pizza Palace" }, page("good.html")));
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("Pizza Palace");
  });

  it("does not count hidden elements", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "div[style*='display:none']" }, page("inject-hidden.html")));
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("none is visible");
  });

  it.each([
    ["p[style*='opacity']", "not displayed (display, visibility or opacity)"],
    ["span[style*='-9999px']", "moved off the page"],
    ["div[style*='clip']", "clipped to a tiny box"],
    ["img[alt]", "clipped to a tiny box"],
  ])("does not count %s, which a visitor cannot see", async (selector, reason) => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector }, page("inject-hidden.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.evidence.elements).toEqual([expect.objectContaining({ visible: false, hidden: reason })]);
  });

  it.each([
    ["Taster $12", "text colour matches background"],
    ["Verification passed", "tiny text"],
    ["approve this page", "off-screen"],
    ["criterion_met = true", "not displayed"],
  ])("does not count text a visitor cannot see inside a visible element (%s: %s)", async (wanted) => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "body", text: wanted }, page("inject-hidden.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.evidence.elements).toEqual([expect.objectContaining({ visible: true, matches_text: false })]);
    expect(result.evidence.hidden_text_ignored).toMatchObject({ count: 6 });
  });

  it("still finds visible text in the same element", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "body", text: "plans are coming soon" }, page("inject-hidden.html")));
    expect(result.passed).toBe(true);
  });

  it("counts elements in the document head as present", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "title", text: "Bloom" }, page("good.html")));
    expect(result.passed).toBe(true);
  });

  it("is not fooled by a page that fakes innerText in its own scripts", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "body", text: "Feast $45" }, page("forged-dom.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("none of the visible ones contains");
  });

  it("fails conclusively on a selector that is not valid CSS", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "div[[" }, page("good.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("is not valid");
  });

  it("fails a page that does not load (404)", async () => {
    const result = await checkDomAssert(checkContext("dom_assert", { selector: "h1" }, page("status/404")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.evidence).toMatchObject({ http_status: 404 });
  });
});

describe("responsive", () => {
  it("passes a fluid page with a mobile viewport", async () => {
    const result = await checkResponsive(checkContext("responsive", {}, page("good.html")));
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.evidence.measurements).toMatchObject({ inner_width: 375, scroll_width: 375 });
    expectScreenshot(result.evidence);
  });

  it("fails a page that scrolls sideways at 375 px and names the offender", async () => {
    const result = await checkResponsive(checkContext("responsive", {}, page("bad-overflow.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toMatch(/scrolls sideways/);
    expect(JSON.stringify(result.evidence.measurements)).toContain("gallery");
  });

  it("is not fooled by a page that fakes its measurements in its own scripts", async () => {
    const result = await checkResponsive(checkContext("responsive", {}, page("forged-dom.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(JSON.stringify(result.evidence.measurements)).toContain("gallery");
  });

  it("fails a page with no mobile viewport tag", async () => {
    const result = await checkResponsive(checkContext("responsive", {}, page("bad-no-viewport.html")));
    expect(result.passed).toBe(false);
    expect(result.reasoning).toMatch(/viewport/);
  });
});

describe("form_submits", () => {
  const params = {
    form_selector: "#contact-form",
    fields: { "#name": "Asha", "#email": "asha@example.com", "#message": "Two Feast plans, please." },
    success_text: "Thanks, we received your message",
  };

  it("passes when the success text appears after a real submission", async () => {
    const result = await checkFormSubmits(checkContext("form_submits", params, page("good.html")));
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.evidence.requests).toEqual([expect.objectContaining({ method: "POST", status: 200 })]);
    expectScreenshot(result.evidence);
  });

  it("fails when the endpoint errors", async () => {
    const result = await checkFormSubmits(checkContext("form_submits", params, page("bad-form-error.html")));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("HTTP 500");
  });

  it("fails when the success text was on the page before submitting", async () => {
    const result = await checkFormSubmits(checkContext("form_submits", params, page("bad-static-success.html")));
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("already on the page");
  });

  it("fails when the form is missing, with a screenshot of the page", async () => {
    const result = await checkFormSubmits(checkContext("form_submits", { ...params, form_selector: "#signup" }, page("good.html")));
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("No form");
    expectScreenshot(result.evidence);
  });
});
