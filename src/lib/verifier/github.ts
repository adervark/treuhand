/**
 * Code-bounty checks, decided from GitHub's REST API (never the model).
 *
 * The submission URL must be a pull request in the repository the contract
 * names, and the API must agree that the PR's base repository is that repo,
 * so a merged PR from some other repository cannot be submitted.
 *
 * GITHUB_TOKEN is optional (it raises rate limits). Rate limits, auth
 * problems, timeouts and 5xx are inconclusive; a PR or repo that does not
 * exist is a conclusive fail.
 */
import { githubToken } from "@/lib/env";
import type { CheckContext, CheckResult } from "./index";
import { clip, describeError, fail, inconclusive, pass } from "./result";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 3;

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

/** Parses `https://github.com/<owner>/<repo>/pull/<n>[/...]`; null for anything else. */
export function parsePullRequestUrl(raw: string): PullRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  if (url.username || url.password || (url.port && url.port !== "443")) return null;
  const [owner, repo, kind, number] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "pull" || !/^\d+$/.test(number ?? "")) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { owner, repo, number: n };
}

/** GitHub could not answer (rate limit, auth, outage, network): the check is inconclusive. */
class GitHubUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

interface ApiCall {
  request: string;
  status: number;
  ms: number;
}

class GitHubClient {
  readonly calls: ApiCall[] = [];

  /** GET a REST path. Returns null on 404/410; throws GitHubUnavailableError when GitHub cannot answer. */
  async get<T>(path: string): Promise<T | null> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "clause-verifier",
    };
    const token = githubToken();
    if (token) headers.authorization = `Bearer ${token}`;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        this.calls.push({ request: `GET ${path}`, status: 0, ms: Date.now() - started });
        lastError = error;
        continue;
      }
      this.calls.push({ request: `GET ${path}`, status: res.status, ms: Date.now() - started });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const body = await res.text().catch(() => "");
        const limited = remaining === "0" || res.status === 429 || /rate limit/i.test(body);
        throw new GitHubUnavailableError(
          limited
            ? `GitHub's rate limit is used up${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ""}` +
                `${token ? "" : " (set GITHUB_TOKEN to raise it)"}.`
            : `GitHub refused the request (HTTP ${res.status}).`,
          res.status,
        );
      }
      if (res.status === 401) {
        throw new GitHubUnavailableError("GitHub rejected GITHUB_TOKEN (HTTP 401).", 401);
      }
      if (res.status >= 500) {
        lastError = new GitHubUnavailableError(`GitHub answered HTTP ${res.status}.`, res.status);
        continue;
      }
      throw new GitHubUnavailableError(`GitHub answered HTTP ${res.status} for ${path}.`, res.status);
    }
    if (lastError instanceof GitHubUnavailableError) throw lastError;
    throw new GitHubUnavailableError(`GitHub could not be reached: ${describeError(lastError).message}`);
  }
}

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body: string | null;
  merged: boolean;
  merged_at: string | null;
  merged_by: { login: string } | null;
  user: { login: string } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string; default_branch?: string } };
}

function pullExcerpt(pr: PullRequest) {
  return {
    number: pr.number,
    html_url: pr.html_url,
    title: clip(pr.title, 200),
    author: pr.user?.login ?? null,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merged_by: pr.merged_by?.login ?? null,
    base_repo: pr.base.repo.full_name,
    base_ref: pr.base.ref,
    default_branch: pr.base.repo.default_branch ?? null,
    head_repo: pr.head.repo?.full_name ?? null,
    head_sha: pr.head.sha,
  };
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Located = { ok: true; pr: PullRequest; ref: PullRef } | { ok: false; result: CheckResult };

/** Parses the submission, checks it names the contract's repo, and fetches the PR. */
async function locatePullRequest(ctx: CheckContext<"github_pr_merged" | "github_checks_passed" | "github_pr_references_issue">, gh: GitHubClient): Promise<Located> {
  const repo = ctx.params.repo;
  const evidence = { submitted_url: ctx.submission.url, contract_repo: repo };
  const ref = parsePullRequestUrl(ctx.submission.url);
  if (!ref) {
    return {
      ok: false,
      result: fail(`The submission is not a GitHub pull request URL (expected https://github.com/${repo}/pull/<number>).`, evidence),
    };
  }
  if (!sameRepo(`${ref.owner}/${ref.repo}`, repo)) {
    return {
      ok: false,
      result: fail(`The pull request is in ${ref.owner}/${ref.repo}, but the contract is for ${repo}.`, evidence),
    };
  }
  const pr = await gh.get<PullRequest>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  if (!pr) {
    return {
      ok: false,
      result: fail(`GitHub has no pull request #${ref.number} in ${repo} (or the repository is private).`, {
        ...evidence,
        responses: [...gh.calls],
      }),
    };
  }
  if (!sameRepo(pr.base.repo.full_name, repo)) {
    return {
      ok: false,
      result: fail(`GitHub says pull request #${ref.number} belongs to ${pr.base.repo.full_name}, not ${repo}.`, {
        ...evidence,
        responses: [...gh.calls],
        pull_request: pullExcerpt(pr),
      }),
    };
  }
  return { ok: true, pr, ref };
}

async function runGithubCheck(
  ctx: CheckContext<"github_pr_merged" | "github_checks_passed" | "github_pr_references_issue">,
  decide: (pr: PullRequest, ref: PullRef, gh: GitHubClient, evidence: Record<string, unknown>) => Promise<CheckResult>,
): Promise<CheckResult> {
  const gh = new GitHubClient();
  const started = Date.now();
  const base = { submitted_url: ctx.submission.url, contract_repo: ctx.params.repo };
  try {
    const located = await locatePullRequest(ctx, gh);
    if (!located.ok) return located.result;
    const result = await decide(located.pr, located.ref, gh, { ...base, pull_request: pullExcerpt(located.pr) });
    return { ...result, evidence: { ...result.evidence, responses: gh.calls, api_ms: Date.now() - started } };
  } catch (error) {
    return inconclusive(
      error instanceof GitHubUnavailableError ? error.message : `The GitHub check could not complete: ${describeError(error).message}`,
      { ...base, responses: gh.calls, api_ms: Date.now() - started },
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// github_pr_merged
// ---------------------------------------------------------------------------

/** When the contract was signed: the later of the two sign-offs, or null if either is missing. */
function signedAt(contract: CheckContext["contract"]): string | null {
  const { payer_signed_at: payer, worker_signed_at: worker } = contract;
  if (!payer || !worker) return null;
  return Date.parse(payer) >= Date.parse(worker) ? payer : worker;
}

/**
 * Passes only a PR merged into the repository's default branch after the
 * contract was signed, so work merged before the deal, or into some other
 * branch, cannot be submitted for payment.
 */
export function checkGithubPrMerged(ctx: CheckContext<"github_pr_merged">): Promise<CheckResult> {
  return runGithubCheck(ctx, async (pr, ref, _gh, pulled) => {
    const signed = signedAt(ctx.contract);
    const evidence = { ...pulled, contract_signed_at: signed };
    if (!pr.merged || !pr.merged_at) {
      return fail(`Pull request #${ref.number} is ${pr.state} and not merged.`, evidence);
    }
    if (!signed) {
      return inconclusive("The contract has no record of when both parties signed, so the merge time cannot be checked against it.", evidence);
    }
    // GitHub reports merged_at to the second, so compare against the second the contract was signed in.
    if (Date.parse(pr.merged_at) < Math.floor(Date.parse(signed) / 1000) * 1000) {
      return fail(
        `Pull request #${ref.number} was merged at ${pr.merged_at}, before the contract was signed at ${signed}. ` +
          `Only work merged after signing counts.`,
        evidence,
      );
    }
    const defaultBranch = pr.base.repo.default_branch;
    if (!defaultBranch) {
      return inconclusive(`GitHub did not say which branch is the default branch of ${pr.base.repo.full_name}.`, evidence);
    }
    if (pr.base.ref !== defaultBranch) {
      return fail(
        `Pull request #${ref.number} was merged into ${pr.base.ref}, not into ${pr.base.repo.full_name}'s default branch ${defaultBranch}.`,
        evidence,
      );
    }
    return pass(
      `Pull request #${ref.number} in ${pr.base.repo.full_name} was merged into ${pr.base.ref}, the default branch, ` +
        `at ${pr.merged_at}, after the contract was signed at ${signed}.`,
      evidence,
    );
  });
}

// ---------------------------------------------------------------------------
// github_checks_passed
// ---------------------------------------------------------------------------

interface CheckRunsPage {
  total_count: number;
  check_runs: { name: string; status: string; conclusion: string | null; app?: { slug?: string } | null; html_url?: string }[];
}

interface CheckSuitesPage {
  total_count: number;
  check_suites: { status: string; conclusion: string | null; app?: { slug?: string } | null; latest_check_runs_count?: number }[];
}

interface CombinedStatus {
  state: string;
  total_count: number;
  statuses: { context: string; state: string; target_url?: string | null }[];
}

const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
/** Completed without running: e.g. a workflow on a fork's PR waiting for a maintainer's approval. Not a failure yet. */
const WAITING_CONCLUSIONS = new Set(["action_required"]);

export function checkGithubChecksPassed(ctx: CheckContext<"github_checks_passed">): Promise<CheckResult> {
  return runGithubCheck(ctx, async (pr, ref, gh, evidence) => {
    const base = `/repos/${ref.owner}/${ref.repo}/commits/${pr.head.sha}`;
    const runs: CheckRunsPage["check_runs"] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await gh.get<CheckRunsPage>(`${base}/check-runs?per_page=100&page=${page}`);
      if (!data) break;
      total = data.total_count;
      runs.push(...data.check_runs);
      if (runs.length >= total || data.check_runs.length === 0) break;
    }
    const combined = await gh.get<CombinedStatus>(`${base}/status`);
    const statuses = combined?.statuses ?? [];
    // A workflow waiting for a maintainer's approval (e.g. on a first-time contributor's fork) has a check
    // suite but no check runs yet, so it is invisible in the check runs above.
    const suites = (await gh.get<CheckSuitesPage>(`${base}/check-suites?per_page=100`))?.check_suites ?? [];
    const waitingSuites = suites.filter((suite) => WAITING_CONCLUSIONS.has(suite.conclusion ?? ""));

    const summary = {
      head_sha: pr.head.sha,
      check_runs: runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, app: r.app?.slug ?? null })),
      check_runs_total: total,
      statuses: statuses.map((s) => ({ context: s.context, state: s.state })),
      check_suites_waiting: waitingSuites.map((suite) => ({ app: suite.app?.slug ?? null, conclusion: suite.conclusion })),
    };
    const observed = { ...evidence, checks: summary };

    if (runs.length < total) {
      return inconclusive(`Only ${runs.length} of ${total} check runs could be read; re-run to check the rest.`, observed);
    }
    const waiting = (r: (typeof runs)[number]) => r.status !== "completed" || WAITING_CONCLUSIONS.has(r.conclusion ?? "");
    const failedRuns = runs.filter((r) => !waiting(r) && !OK_CONCLUSIONS.has(r.conclusion ?? ""));
    const failedStatuses = statuses.filter((s) => s.state === "failure" || s.state === "error");
    if (failedRuns.length + failedStatuses.length > 0) {
      const names = [...failedRuns.map((r) => `${r.name} (${r.conclusion})`), ...failedStatuses.map((s) => `${s.context} (${s.state})`)];
      return fail(`Checks did not pass on the PR's head commit ${pr.head.sha.slice(0, 7)}: ${names.slice(0, 5).join(", ")}.`, observed);
    }
    const pending = [
      ...runs.filter(waiting).map((r) => (r.conclusion ? `${r.name} (${r.conclusion})` : r.name)),
      ...statuses.filter((s) => s.state === "pending").map((s) => s.context),
      ...waitingSuites.map((suite) => `${suite.app?.slug ?? "a"} check suite (${suite.conclusion})`),
    ];
    if (pending.length > 0) {
      return inconclusive(`Checks have not finished on ${pr.head.sha.slice(0, 7)} (${pending.slice(0, 5).join(", ")}); re-run verification when they have.`, observed);
    }
    const succeeded = runs.filter((r) => r.conclusion === "success").length + statuses.filter((s) => s.state === "success").length;
    if (runs.length + statuses.length === 0) {
      return fail(`No checks ran on the PR's head commit ${pr.head.sha.slice(0, 7)}, so there is nothing that passed.`, observed);
    }
    if (succeeded === 0) {
      return fail(`No check succeeded on ${pr.head.sha.slice(0, 7)}: every check was skipped or neutral.`, observed);
    }
    return pass(`All ${runs.length + statuses.length} check(s) on the PR's head commit ${pr.head.sha.slice(0, 7)} passed.`, observed);
  });
}

// ---------------------------------------------------------------------------
// github_pr_references_issue
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLOSING = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/**
 * Finds a reference to `issue` in the same repository in PR text:
 * `#12`, `owner/repo#12`, or `https://github.com/owner/repo/issues/12`.
 * `#123` does not match issue 12, and `other/repo#12` does not count.
 */
export function findIssueReference(text: string, repo: string, issue: number): { snippet: string; closing: boolean } | null {
  const r = escapeRe(repo);
  const ref =
    `(?:(?<![\\w/&#.-])#${issue}(?!\\d)` +
    `|(?<![\\w/.-])${r}#${issue}(?!\\d)` +
    `|https?://(?:www\\.)?github\\.com/${r}/issues/${issue}(?![\\d])(?:[/?#][^\\s)]*)?)`;
  const match = new RegExp(ref, "i").exec(text);
  if (!match) return null;
  const closing = new RegExp(`\\b${CLOSING}:?\\s+${ref}`, "i").test(text);
  const start = Math.max(0, match.index - 60);
  return { snippet: clip(text.slice(start, match.index + match[0].length + 60), 200), closing };
}

interface TimelineEvent {
  event: string;
  source?: { issue?: { number: number; pull_request?: unknown; repository?: { full_name: string } } };
}

export function checkGithubPrReferencesIssue(ctx: CheckContext<"github_pr_references_issue">): Promise<CheckResult> {
  return runGithubCheck(ctx, async (pr, ref, gh, evidence) => {
    const { issue, repo } = ctx.params;
    const inTitle = findIssueReference(pr.title, repo, issue);
    const inBody = findIssueReference(pr.body ?? "", repo, issue);
    const found = inTitle ?? inBody;
    if (found) {
      return pass(
        `Pull request #${ref.number} references issue #${issue} in its ${inTitle ? "title" : "description"}` +
          `${found.closing ? " with a closing keyword" : ""}: "${found.snippet}".`,
        { ...evidence, reference: { where: inTitle ? "title" : "body", ...found } },
      );
    }
    // Not in the text: GitHub's issue timeline records cross-references from the PR (e.g. in commits).
    for (let page = 1; page <= MAX_PAGES; page++) {
      const events = await gh.get<TimelineEvent[]>(`/repos/${ref.owner}/${ref.repo}/issues/${issue}/timeline?per_page=100&page=${page}`);
      if (events === null) {
        return fail(`Issue #${issue} does not exist in ${repo}, and the PR's text does not reference it.`, evidence);
      }
      const hit = events.find(
        (e) =>
          e.event === "cross-referenced" &&
          e.source?.issue?.number === ref.number &&
          e.source.issue.pull_request !== undefined &&
          sameRepo(e.source.issue.repository?.full_name ?? "", repo),
      );
      if (hit) {
        return pass(`GitHub's timeline for issue #${issue} shows a cross-reference from pull request #${ref.number}.`, {
          ...evidence,
          reference: { where: "issue timeline", event: "cross-referenced" },
        });
      }
      if (events.length < 100) break;
    }
    return fail(`Pull request #${ref.number} does not reference issue #${issue} in its title, description or GitHub's issue timeline.`, evidence);
  });
}
