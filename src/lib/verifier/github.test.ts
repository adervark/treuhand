/**
 * Code-bounty checks with GitHub's REST API replaced by a stubbed `fetch`.
 * Each route returns a canned response (or throws, for a network error), and
 * every request is recorded so tests can assert what was asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkContext } from "../../../test/fixtures/context";
import { toVerdictFields } from "./index";
import {
  checkGithubChecksPassed,
  checkGithubPrMerged,
  checkGithubPrReferencesIssue,
  findIssueReference,
  parsePullRequestUrl,
} from "./github";

const REPO = "acme/widgets";
const PR_URL = `https://github.com/${REPO}/pull/7`;
const PR_PATH = `/repos/${REPO}/pulls/7`;
const SHA = "abc1234def5678";
const runsPath = (page: number) => `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100&page=${page}`;
const RUNS_PATH = runsPath(1);
const STATUS_PATH = `/repos/${REPO}/commits/${SHA}/status`;
const SUITES_PATH = `/repos/${REPO}/commits/${SHA}/check-suites?per_page=100`;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

let routes: Map<string, Reply[]>;
let requests: { path: string; headers: Record<string, string> }[];

function route(path: string, ...replies: Reply[]) {
  routes.set(path, replies);
}

beforeEach(() => {
  routes = new Map();
  requests = [];
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      const path = url.pathname + url.search;
      requests.push({ path, headers: { ...(init?.headers as Record<string, string>) } });
      const queue = routes.get(path);
      if (!queue || queue.length === 0) return new Response('{"message":"Not Found"}', { status: 404 });
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: PR_URL,
    state: "closed",
    title: "Add the widget exporter",
    body: "Adds CSV export.\n\nFixes #12",
    merged: true,
    merged_at: "2026-11-10T10:00:00Z",
    merged_by: { login: "maintainer" },
    user: { login: "worker" },
    head: { sha: SHA, ref: "export", repo: { full_name: "worker/widgets" } },
    base: { ref: "main", repo: { full_name: REPO, default_branch: "main" } },
    ...overrides,
  };
}

const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, app: { slug: "github-actions" } });
const runs = (...checkRuns: ReturnType<typeof run>[]) => ({ body: { total_count: checkRuns.length, check_runs: checkRuns } });
const statuses = (...list: { context: string; state: string }[]) => ({
  body: { state: list.length ? list[0].state : "pending", total_count: list.length, statuses: list },
});

/** Both parties signed before the fixture PR's merged_at (2026-11-10T10:00:00Z). */
const SIGNED_AT = "2026-11-09T12:00:00.000Z";
function mergedContext(url = PR_URL, signed: { payer: string | null; worker: string | null } = { payer: SIGNED_AT, worker: SIGNED_AT }) {
  const ctx = checkContext("github_pr_merged", { repo: REPO }, url);
  ctx.contract = { ...ctx.contract, payer_signed_at: signed.payer, worker_signed_at: signed.worker };
  return ctx;
}
const merged = (url = PR_URL, signed?: Parameters<typeof mergedContext>[1]) => checkGithubPrMerged(mergedContext(url, signed));
const checksPassed = () => checkGithubChecksPassed(checkContext("github_checks_passed", { repo: REPO }, PR_URL));
const references = (issue = 12, url = PR_URL) =>
  checkGithubPrReferencesIssue(checkContext("github_pr_references_issue", { repo: REPO, issue }, url));
const outcome = (result: Parameters<typeof toVerdictFields>[0]) => toVerdictFields(result).evidence.outcome;

describe("parsePullRequestUrl", () => {
  it.each([
    [PR_URL, { owner: "acme", repo: "widgets", number: 7 }],
    [`${PR_URL}/files`, { owner: "acme", repo: "widgets", number: 7 }],
    ["https://www.github.com/acme/widgets.js/pull/42#discussion", { owner: "acme", repo: "widgets.js", number: 42 }],
  ])("parses %s", (url, expected) => {
    expect(parsePullRequestUrl(url)).toEqual(expected);
  });

  it.each([
    "https://github.com/acme/widgets/issues/7",
    "https://github.com/acme/widgets/pull/0",
    "https://github.com/acme/widgets/pull/abc",
    "https://gitlab.com/acme/widgets/pull/7",
    "https://github.com.evil.dev/acme/widgets/pull/7",
    "https://user:pw@github.com/acme/widgets/pull/7",
    "https://github.com:8443/acme/widgets/pull/7",
    "ftp://github.com/acme/widgets/pull/7",
    "not a url",
  ])("refuses %s", (url) => {
    expect(parsePullRequestUrl(url)).toBeNull();
  });
});

describe("finding the pull request", () => {
  it("rejects a PR from another repository without calling GitHub", async () => {
    const result = await checkGithubPrMerged(checkContext("github_pr_merged", { repo: REPO }, "https://github.com/someone/fork/pull/7"));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("someone/fork");
    expect(result.reasoning).toContain(REPO);
    expect(requests).toEqual([]);
  });

  it("rejects a PR whose base repository, per the API, is not the contract's", async () => {
    route(PR_PATH, { body: pullRequest({ base: { ref: "main", repo: { full_name: "other/widgets" } } }) });
    const result = await merged();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("belongs to other/widgets");
  });

  it("fails a submission that is not a pull request URL", async () => {
    const result = await checkGithubPrMerged(checkContext("github_pr_merged", { repo: REPO }, "https://github.com/acme/widgets/issues/12"));
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("not a GitHub pull request URL");
    expect(requests).toEqual([]);
  });

  it("fails a PR that does not exist (404)", async () => {
    const result = await merged();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.inconclusive).toBeUndefined();
    expect(result.reasoning).toContain("no pull request #7");
  });

  it("matches the repository name case-insensitively", async () => {
    route(PR_PATH.replace("acme/widgets", "Acme/Widgets"), { body: pullRequest() });
    const result = await merged("https://github.com/Acme/Widgets/pull/7");
    expect(result.passed).toBe(true);
  });

  it("sends the API version header, and the token only when one is set", async () => {
    route(PR_PATH, { body: pullRequest() });
    await merged();
    expect(requests[0].headers).toMatchObject({ "x-github-api-version": "2022-11-28", accept: "application/vnd.github+json" });
    expect(requests[0].headers.authorization).toBeUndefined();

    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    await merged();
    expect(requests[1].headers.authorization).toBe("Bearer ghp_test");
  });
});

describe("github_pr_merged", () => {
  it("passes a merged PR, with an API excerpt as evidence", async () => {
    route(PR_PATH, { body: pullRequest() });
    const result = await merged();
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.reasoning).toBe(
      `Pull request #7 in ${REPO} was merged into main, the default branch, at 2026-11-10T10:00:00Z, ` +
        `after the contract was signed at ${SIGNED_AT}.`,
    );
    expect(result.evidence.contract_signed_at).toBe(SIGNED_AT);
    expect(result.evidence.pull_request).toMatchObject({ merged: true, base_repo: REPO, head_sha: SHA, author: "worker" });
    expect(result.evidence.responses).toEqual([expect.objectContaining({ request: `GET ${PR_PATH}`, status: 200 })]);
  });

  it("fails an open PR", async () => {
    route(PR_PATH, { body: pullRequest({ state: "open", merged: false, merged_at: null, merged_by: null }) });
    const result = await merged();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toBe("Pull request #7 is open and not merged.");
  });

  it("fails a PR closed without merging", async () => {
    route(PR_PATH, { body: pullRequest({ state: "closed", merged: false, merged_at: null, merged_by: null }) });
    const result = await merged();
    expect(result.passed).toBe(false);
    expect(outcome(result)).toBe("fail");
  });

  it("fails a PR merged before the contract was signed", async () => {
    route(PR_PATH, { body: pullRequest() });
    const result = await merged(PR_URL, { payer: "2026-11-11T08:00:00.000Z", worker: "2026-11-11T08:00:00.000Z" });
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(outcome(result)).toBe("fail");
    expect(result.reasoning).toBe(
      "Pull request #7 was merged at 2026-11-10T10:00:00Z, before the contract was signed at 2026-11-11T08:00:00.000Z. " +
        "Only work merged after signing counts.",
    );
  });

  it("takes the later sign-off as the signing time", async () => {
    route(PR_PATH, { body: pullRequest() });
    const result = await merged(PR_URL, { payer: "2026-11-09T08:00:00.000Z", worker: "2026-11-11T08:00:00.000Z" });
    expect(outcome(result)).toBe("fail");
    expect(result.reasoning).toContain("before the contract was signed at 2026-11-11T08:00:00.000Z");
  });

  it("passes a PR merged in the same second the contract was signed (GitHub reports whole seconds)", async () => {
    route(PR_PATH, { body: pullRequest() });
    const result = await merged(PR_URL, { payer: "2026-11-10T10:00:00.700Z", worker: "2026-11-10T09:00:00.000Z" });
    expect(outcome(result)).toBe("pass");
  });

  it("fails a PR merged after signing into a branch other than the default branch", async () => {
    route(PR_PATH, { body: pullRequest({ base: { ref: "release-1.x", repo: { full_name: REPO, default_branch: "main" } } }) });
    const result = await merged();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(outcome(result)).toBe("fail");
    expect(result.reasoning).toBe(`Pull request #7 was merged into release-1.x, not into ${REPO}'s default branch main.`);
  });

  it("is inconclusive when the contract has no sign-off time, or GitHub omits the default branch", async () => {
    route(PR_PATH, { body: pullRequest() });
    const unsigned = await merged(PR_URL, { payer: SIGNED_AT, worker: null });
    expect(outcome(unsigned)).toBe("inconclusive");
    expect(unsigned.reasoning).toContain("no record of when both parties signed");

    route(PR_PATH, { body: pullRequest({ base: { ref: "main", repo: { full_name: REPO } } }) });
    const noDefault = await merged();
    expect(outcome(noDefault)).toBe("inconclusive");
    expect(noDefault.reasoning).toContain("did not say which branch is the default branch");
  });
});

describe("GitHub could not answer: inconclusive, never pass or fail", () => {
  it("rate limit (403, remaining 0)", async () => {
    route(PR_PATH, {
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
    });
    const result = await merged();
    expect(result).toMatchObject({ passed: false, confidence: 0, inconclusive: true });
    expect(result.reasoning).toMatch(/rate limit is used up until 2030-01-01T00:00:00.000Z \(set GITHUB_TOKEN/);
    expect(outcome(result)).toBe("inconclusive");
    expect(result.evidence.error).toMatchObject({ name: "GitHubUnavailableError" });
  });

  it("secondary rate limit (429)", async () => {
    route(PR_PATH, { status: 429, body: { message: "slow down" } });
    const result = await merged();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("rate limit");
  });

  it("a rejected token (401)", async () => {
    route(PR_PATH, { status: 401, body: { message: "Bad credentials" } });
    const result = await merged();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("401");
  });

  it("a network error, after one retry", async () => {
    route(PR_PATH, new TypeError("fetch failed"));
    const result = await merged();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("could not be reached: fetch failed");
    expect(requests.filter((r) => r.path === PR_PATH)).toHaveLength(2);
  });

  it("a 5xx twice; a 5xx then a good answer is used", async () => {
    route(PR_PATH, { status: 502 }, { status: 502 });
    const down = await merged();
    expect(down.inconclusive).toBe(true);
    expect(down.reasoning).toContain("HTTP 502");

    route(PR_PATH, { status: 503 }, { body: pullRequest() });
    const recovered = await merged();
    expect(recovered.passed).toBe(true);
  });

  it("a rate limit part-way through a later call", async () => {
    route(PR_PATH, { body: pullRequest() });
    route(RUNS_PATH, { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } });
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
    expect(result.evidence.responses).toHaveLength(2);
  });
});

describe("github_checks_passed", () => {
  beforeEach(() => {
    route(PR_PATH, { body: pullRequest() });
  });

  it("passes when every check run and status succeeded, reading the PR's head commit", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success"), run("lint", "completed", "skipped")));
    route(STATUS_PATH, statuses({ context: "ci/circleci", state: "success" }));
    const result = await checksPassed();
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.reasoning).toContain("All 3 check(s)");
    expect(result.evidence.checks).toMatchObject({
      head_sha: SHA,
      check_runs: [expect.objectContaining({ name: "build", conclusion: "success" }), expect.objectContaining({ name: "lint" })],
    });
  });

  it("fails when a check run failed, naming it", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success"), run("test", "completed", "failure")));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("test (failure)");
  });

  it("fails when a commit status failed", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success")));
    route(STATUS_PATH, statuses({ context: "deploy/preview", state: "error" }));
    const result = await checksPassed();
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("deploy/preview (error)");
  });

  it("is inconclusive while a check run is still in progress", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success"), run("e2e", "in_progress", null)));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("have not finished");
    expect(result.reasoning).toContain("e2e");
  });

  it("is inconclusive, not failed, while a run waits for a maintainer's approval (action_required)", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "action_required")));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("build (action_required)");
  });

  it("is inconclusive while a check suite waits for approval and has no runs yet (first-time contributor CI)", async () => {
    route(RUNS_PATH, runs(run("license/cla", "completed", "success")));
    route(STATUS_PATH, statuses());
    route(SUITES_PATH, {
      body: {
        total_count: 3,
        check_suites: [
          { status: "completed", conclusion: "success", app: { slug: "microsoft-github-policy-service" } },
          { status: "queued", conclusion: null, app: { slug: "codecov" } },
          { status: "completed", conclusion: "action_required", app: { slug: "github-actions" } },
        ],
      },
    });
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("github-actions check suite (action_required)");
    expect(result.evidence.checks).toMatchObject({ check_suites_waiting: [{ app: "github-actions", conclusion: "action_required" }] });
  });

  it("ignores check suites that are merely queued with no runs (apps that never report)", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success")));
    route(STATUS_PATH, statuses());
    route(SUITES_PATH, { body: { total_count: 1, check_suites: [{ status: "queued", conclusion: null, app: { slug: "azure-boards" } }] } });
    const result = await checksPassed();
    expect(result.passed).toBe(true);
  });

  it("fails cancelled and timed-out runs", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "cancelled"), run("e2e", "completed", "timed_out")));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("build (cancelled), e2e (timed_out)");
  });

  it("is inconclusive while a commit status is pending", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "success")));
    route(STATUS_PATH, statuses({ context: "ci/jenkins", state: "pending" }));
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
  });

  it("a failure outweighs a pending check", async () => {
    route(RUNS_PATH, runs(run("build", "completed", "failure"), run("e2e", "queued", null)));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
  });

  it("fails when no checks ran at all", async () => {
    route(RUNS_PATH, runs());
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("No checks ran");
  });

  it("fails when every check was only skipped or neutral", async () => {
    route(RUNS_PATH, runs(run("deploy", "completed", "skipped"), run("label", "completed", "neutral")));
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain("No check succeeded");
  });

  it("reads further pages of check runs, and is inconclusive if some cannot be read", async () => {
    const many = Array.from({ length: 100 }, (_, i) => run(`job-${i}`, "completed", "success"));
    route(RUNS_PATH, { body: { total_count: 400, check_runs: many } });
    route(runsPath(2), { body: { total_count: 400, check_runs: many } });
    route(runsPath(3), { body: { total_count: 400, check_runs: many } });
    route(STATUS_PATH, statuses());
    const result = await checksPassed();
    expect(result.inconclusive).toBe(true);
    expect(result.reasoning).toContain("Only 300 of 400");
  });
});

describe("github_pr_references_issue", () => {
  const TIMELINE = `/repos/${REPO}/issues/12/timeline?per_page=100&page=1`;

  it("passes when the description closes the issue", async () => {
    route(PR_PATH, { body: pullRequest() });
    const result = await references();
    expect(result).toMatchObject({ passed: true, confidence: 1 });
    expect(result.reasoning).toContain("with a closing keyword");
    expect(result.evidence.reference).toMatchObject({ where: "body", closing: true });
  });

  it("passes on a full issue URL in the title", async () => {
    route(PR_PATH, { body: pullRequest({ title: `Export (https://github.com/${REPO}/issues/12)`, body: null }) });
    const result = await references();
    expect(result.passed).toBe(true);
    expect(result.evidence.reference).toMatchObject({ where: "title", closing: false });
  });

  it("does not count #123, another repo's #12, or an issue URL in another repo", async () => {
    route(PR_PATH, { body: pullRequest({ body: "See #123, other/repo#12 and https://github.com/other/repo/issues/12" }) });
    route(TIMELINE, { body: [] });
    const result = await references();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("does not reference issue #12");
  });

  it("passes on a cross-reference from this PR in the issue's timeline", async () => {
    route(PR_PATH, { body: pullRequest({ body: "No issue mentioned here." }) });
    route(TIMELINE, {
      body: [
        { event: "labeled" },
        { event: "cross-referenced", source: { issue: { number: 7, pull_request: {}, repository: { full_name: "other/repo" } } } },
        { event: "cross-referenced", source: { issue: { number: 7, pull_request: {}, repository: { full_name: REPO } } } },
      ],
    });
    const result = await references();
    expect(result.passed).toBe(true);
    expect(result.evidence.reference).toMatchObject({ where: "issue timeline" });
  });

  it("ignores timeline cross-references from other PRs or from issues", async () => {
    route(PR_PATH, { body: pullRequest({ body: "" }) });
    route(TIMELINE, {
      body: [
        { event: "cross-referenced", source: { issue: { number: 8, pull_request: {}, repository: { full_name: REPO } } } },
        { event: "cross-referenced", source: { issue: { number: 7, repository: { full_name: REPO } } } },
      ],
    });
    const result = await references();
    expect(result.passed).toBe(false);
  });

  it("fails when the issue does not exist", async () => {
    route(PR_PATH, { body: pullRequest({ body: "" }) });
    const result = await references();
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(result.reasoning).toContain("Issue #12 does not exist");
  });

  it("is inconclusive when the timeline cannot be read", async () => {
    route(PR_PATH, { body: pullRequest({ body: "" }) });
    route(TIMELINE, { status: 429 });
    const result = await references();
    expect(result.inconclusive).toBe(true);
  });

  it("rejects a PR in another repository", async () => {
    const result = await references(12, "https://github.com/other/widgets/pull/7");
    expect(result).toMatchObject({ passed: false, confidence: 1 });
    expect(requests).toEqual([]);
  });
});

describe("findIssueReference", () => {
  it.each([
    ["Fixes #12", true],
    ["closes: #12.", true],
    ["Resolved acme/widgets#12", true],
    ["Related to #12", false],
    ["(#12)", false],
  ])("finds the reference in %j (closing: %s)", (text, closing) => {
    expect(findIssueReference(text, REPO, 12)).toMatchObject({ closing });
  });

  it.each(["#120", "#1", "&#12;", "a#12", "other/widgets#12", "https://github.com/acme/widgets/issues/120", "https://github.com/acme/widgets/pull/12"])(
    "does not match %j",
    (text) => {
      expect(findIssueReference(text, REPO, 12)).toBeNull();
    },
  );
});
