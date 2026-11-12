/**
 * Posting a finished run's verdict on a code bounty's pull request, opt-in
 * (CLAUSE_GITHUB_PR_COMMENTS plus GITHUB_TOKEN). Like the signed receipt the
 * comment is a record, never a gate: it is posted after the outcome is
 * recorded, the claim released and a pass settled, it never throws, and a
 * post that fails is written to the audit trail (GITHUB_COMMENT_FAILED) and
 * otherwise ignored.
 *
 * Only the contract's own pull request is commented on: a code bounty whose
 * GitHub conditions name exactly one repository, a submission that is a pull
 * request in it, and a run whose verifier fetched that pull request from
 * GitHub with that base repository (so an issue number in a /pull/ URL is
 * never commented on). One pull request per contract: once the verdict is on
 * one, a submission of another is recorded as not posted. The id of the
 * comment posted earlier comes from this contract's GITHUB_COMMENT_POSTED
 * events and later runs edit it (a new one is created if it was deleted).
 *
 * The body is built from fixed phrases. The one piece of text it quotes, each
 * verdict's reasoning, embeds what a submitter controls (PR titles, CI check
 * names), so `inertText` quotes it in a code span it cannot break out of.
 * Party names, emails, amounts and PayPal ids are never in it.
 */
import { githubPrComments, githubToken, publicAppUrl } from "@/lib/env";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { listEvents, recordEvent } from "@/lib/db/events";
import { listReceiptsForSubmission } from "@/lib/db/receipts";
import { getSubmission } from "@/lib/db/submissions";
import { verdictOutcome, type VerificationOutcome } from "@/lib/verifier";
import { GITHUB_API, GITHUB_TIMEOUT_MS, githubHeaders, parsePullRequestUrl, sameRepo, type PullRef } from "@/lib/verifier/github";
import type { CheckKind, Condition, ContractState, Verdict } from "@/lib/types";
import { errorMessage } from "./service-errors";

/** What a finished run hands over: its outcome, verdicts and receipt, as VERIFICATION_COMPLETED records them. */
export interface FinishedRun {
  contractId: string;
  submissionId: string;
  outcome: VerificationOutcome;
  verdicts: Verdict[];
  receipt: { receipt_sha256: string } | { receipt_error: string };
}

const REASONING_MAX = 300;
const RETRY_DELAY_MS = 1_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/**
 * Makes untrusted text safe to quote in a comment by putting it in an inline
 * code span, where GitHub creates no mentions, references, links, images or
 * HTML. The span cannot be closed or broken out of: backticks are replaced
 * and line breaks removed, so the text is one line with no backtick in it.
 * As a second layer, `<` and `>` are replaced and a zero-width space follows
 * every `@`, `#` and `://`; other things GitHub links outside code (`GH-123`,
 * `www.` addresses, commit SHAs, `owner/repo@sha`) pass through unchanged and
 * rely on the span alone. Lone surrogates become U+FFFD, control, zero-width
 * and bidi characters are dropped, and the text is clipped to `max` characters.
 */
export function inertText(raw: string, max = REASONING_MAX): string {
  const flat = raw
    .toWellFormed()
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  const clipped = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
  const safe = clipped
    .replace(/`/g, "'")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/[@#]/g, "$&\u200b")
    .replace(/:\/\//g, ":/\u200b/");
  return safe.length > 0 ? `\`${safe}\`` : "(none)";
}

/** What each check asks, in a fixed phrase (no repository or issue number, so the comment references nothing). */
const CHECK_PHRASE: Partial<Record<CheckKind, string>> = {
  github_pr_merged: "Merged into the default branch after the contract was signed",
  github_checks_passed: "Every check on the latest commit passes",
  github_pr_references_issue: "References the contract's issue",
};

const VERDICT_WORD = { pass: "passed", fail: "did not pass", inconclusive: "could not be decided" } as const;

const HEADLINE: Record<VerificationOutcome, string> = {
  passed: "passed",
  failed: "did not pass",
  inconclusive: "undecided",
};

/** A contract id from our own database (a UUID); anything else is reduced to its safe characters. */
const markerId = (contractId: string) => contractId.replace(/[^\w-]/g, "").replace(/-+/g, "-");

export function commentMarker(contractId: string): string {
  return `<!-- treuhand:verdict contract=${markerId(contractId)} -->`;
}

/**
 * The comment for a finished run. `state` is the contract's state once the
 * run (and, for a pass, settlement) is done: only `PAID` is reported as the
 * worker having been paid. `contractUrl` is linked only when given.
 */
export function buildCommentBody(input: {
  contractId: string;
  outcome: VerificationOutcome;
  conditions: Pick<Condition, "id" | "check_kind">[];
  verdicts: Pick<Verdict, "condition_id" | "passed" | "reasoning" | "evidence">[];
  state: ContractState;
  receiptSha256: string | null;
  keyFingerprint: string | null;
  contractUrl: string | null;
}): string {
  const byCondition = new Map(input.verdicts.map((v) => [v.condition_id, v]));
  const notPassed = input.conditions.filter((c) => {
    const v = byCondition.get(c.id);
    return !v || verdictOutcome(v) !== "pass";
  }).length;
  const summary =
    input.outcome === "passed"
      ? "Every condition of the contract passed."
      : input.outcome === "failed"
        ? `${notPassed} of ${input.conditions.length} conditions did not pass.`
        : "A check could not complete, so nothing was decided. Either party can run verification again.";

  const lines = [
    commentMarker(input.contractId),
    `### Treuhand verification: ${HEADLINE[input.outcome]}`,
    "",
    `${summary} Each result below was decided by code reading GitHub's API.`,
    "",
  ];
  for (const condition of input.conditions) {
    const verdict = byCondition.get(condition.id);
    const phrase = CHECK_PHRASE[condition.check_kind] ?? "A condition of the contract";
    if (!verdict) {
      lines.push(`- ${phrase}: **not run**`);
      continue;
    }
    lines.push(`- ${phrase}: **${VERDICT_WORD[verdictOutcome(verdict)]}**`);
    // Only the GitHub checks' reasoning is quoted: it is about the pull request, never the parties or the money.
    if (CHECK_PHRASE[condition.check_kind]) lines.push(`  Verifier's note: ${inertText(verdict.reasoning)}`);
  }
  lines.push("");
  if (input.outcome === "passed") {
    lines.push(input.state === "PAID" ? "Payment: payout sent to the worker." : "Payment: not confirmed yet.");
  }
  if (input.receiptSha256 && SHA256_HEX.test(input.receiptSha256)) {
    const key = input.keyFingerprint && SHA256_HEX.test(input.keyFingerprint) ? `, signed by the key with fingerprint \`${input.keyFingerprint}\`` : "";
    lines.push(`Signed receipt: SHA-256 \`${input.receiptSha256}\`${key}.`);
  } else {
    lines.push("No signed receipt was issued for this run.");
  }
  if (input.contractUrl) lines.push(`[Open the contract in Treuhand](${input.contractUrl})`);
  lines.push("", "<sub>Posted by Treuhand when verification finished. Later runs of this contract edit this comment.</sub>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

type WriteResult = { ok: true; id: number } | { ok: false; status: number; reason: string };

/** Why GitHub did not take the comment, in a short phrase written here (never GitHub's text). */
function refusal(status: number, rateLimited: boolean): string {
  if (status === 401) return "GitHub rejected GITHUB_TOKEN (HTTP 401).";
  if (status === 429 || (status === 403 && rateLimited)) return `GitHub's rate limit is used up (HTTP ${status}).`;
  if (status === 403) return "GitHub refused the comment (HTTP 403): the token needs the public_repo scope, or the conversation is locked.";
  if (status === 404) return "GitHub answered HTTP 404: the pull request is gone or the token cannot see the repository.";
  if (status === 422) return "GitHub refused the comment as invalid (HTTP 422).";
  return `GitHub answered HTTP ${status}.`;
}

/** POSTs or PATCHes a comment. At most one retry, on a 5xx or a network error; never throws. */
async function writeComment(method: "POST" | "PATCH", path: string, body: string, token: string): Promise<WriteResult> {
  const headers = { ...githubHeaders(token), "content-type": "application/json" };
  let last: WriteResult = { ok: false, status: 0, reason: "GitHub could not be reached." };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers,
        body: JSON.stringify({ body }),
        // Only ever the exact path built here: a redirect is a failure, never followed.
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      last = { ok: false, status: 0, reason: timedOut ? "GitHub did not answer within 15 seconds." : "GitHub could not be reached." };
      continue;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const id = data?.id;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return { ok: true, id };
      return { ok: false, status: res.status, reason: "GitHub's answer did not include a comment id." };
    }
    last = { ok: false, status: res.status, reason: refusal(res.status, res.headers.get("x-ratelimit-remaining") === "0") };
    await res.body?.cancel().catch(() => {});
    if (res.status < 500) return last;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------


const pullRequestUrl = (ref: PullRef) => `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

/**
 * Whether the verifier itself fetched pull request `number` from GitHub with
 * `repo` as its base: a GitHub check attaches the PR's excerpt to its evidence
 * only after GitHub returned it. Stored evidence is read defensively.
 */
function verifierSawPullRequest(verdicts: Verdict[], number: number, repo: string): boolean {
  return verdicts.some((v) => {
    const pr: unknown = (v.evidence as Record<string, unknown>).pull_request;
    if (typeof pr !== "object" || pr === null) return false;
    const { number: seen, base_repo: base } = pr as Record<string, unknown>;
    return seen === number && typeof base === "string" && sameRepo(base, repo);
  });
}

/**
 * The pull request this run may comment on, or null: a code bounty, one
 * repository, a submission that is a PR in it, and the verifier saw that PR.
 */
function targetOf(run: FinishedRun): { ref: PullRef; conditions: Condition[]; state: ContractState } | null {
  const contract = getContract(run.contractId);
  if (!contract || contract.type !== "code_bounty") return null;
  const conditions = listConditions(run.contractId);
  const repos = new Set(
    conditions
      .filter((c) => CHECK_PHRASE[c.check_kind] !== undefined)
      .map((c) => String((c.check_params as { repo?: unknown }).repo ?? "").toLowerCase()),
  );
  if (repos.size !== 1) return null;
  const [repo] = repos;
  const ref = parsePullRequestUrl(getSubmission(run.submissionId)?.url ?? "");
  if (!repo || !ref || !sameRepo(`${ref.owner}/${ref.repo}`, repo)) return null;
  if (!verifierSawPullRequest(run.verdicts, ref.number, repo)) return null;
  return { ref, conditions, state: contract.state };
}

const samePullRequest = (detail: Record<string, unknown>, prUrl: string) =>
  typeof detail.pull_request === "string" && detail.pull_request.toLowerCase() === prUrl.toLowerCase();

/** The comment this contract posted on this pull request before, from its own audit trail. */
function earlierCommentId(contractId: string, prUrl: string): number | null {
  const posted = listEvents(contractId).findLast((e) => e.kind === "GITHUB_COMMENT_POSTED" && samePullRequest(e.detail, prUrl));
  const id = posted?.detail.comment_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Whether this contract's verdict is already on a different pull request (one pull request per contract). */
function postedElsewhere(contractId: string, prUrl: string): boolean {
  return listEvents(contractId).some((e) => e.kind === "GITHUB_COMMENT_POSTED" && !samePullRequest(e.detail, prUrl));
}

function recordCommentFailure(run: FinishedRun, prUrl: string | null, reason: string): void {
  const token = githubToken();
  try {
    recordEvent({
      contract_id: run.contractId,
      kind: "GITHUB_COMMENT_FAILED",
      detail: {
        actor: "system",
        submission_id: run.submissionId,
        ...(prUrl ? { pull_request: prUrl } : {}),
        reason: (token ? reason.split(token).join("[token]") : reason).slice(0, 300),
      },
    });
  } catch (err) {
    console.error(`the pull request comment for submission ${run.submissionId} failed and could not be recorded`, err);
  }
}

async function post(run: FinishedRun): Promise<void> {
  let prUrl: string | null = null;
  try {
    // The setting first: with it unset or off, nothing is read and nothing is ever recorded.
    let invalidSetting: unknown = null;
    try {
      if (!githubPrComments()) return;
    } catch (err) {
      invalidSetting = err;
    }
    const target = targetOf(run);
    if (!target) return;
    if (invalidSetting) throw invalidSetting;
    prUrl = pullRequestUrl(target.ref);
    if (postedElsewhere(run.contractId, prUrl)) {
      recordCommentFailure(run, prUrl, "This contract's verdict is already posted on another pull request, so nothing was posted on this one.");
      return;
    }
    const token = githubToken();
    if (!token) {
      recordCommentFailure(run, prUrl, "CLAUSE_GITHUB_PR_COMMENTS is on but GITHUB_TOKEN is not set, so nothing was posted.");
      return;
    }
    const receiptSha256 = "receipt_sha256" in run.receipt ? run.receipt.receipt_sha256 : null;
    const receipt = receiptSha256 ? listReceiptsForSubmission(run.submissionId).find((r) => r.receipt_sha256 === receiptSha256) : undefined;
    const base = publicAppUrl();
    const body = buildCommentBody({
      contractId: run.contractId,
      outcome: run.outcome,
      conditions: target.conditions,
      verdicts: run.verdicts,
      state: target.state,
      receiptSha256,
      keyFingerprint: receipt?.signature.key_fingerprint ?? null,
      contractUrl: base ? `${base}/contracts/${encodeURIComponent(run.contractId)}` : null,
    });

    const { owner, repo, number } = target.ref;
    const earlier = earlierCommentId(run.contractId, prUrl);
    let action: "created" | "updated" = "updated";
    let result: WriteResult | null = earlier ? await writeComment("PATCH", `/repos/${owner}/${repo}/issues/comments/${earlier}`, body, token) : null;
    if (!result || (!result.ok && (result.status === 404 || result.status === 410))) {
      action = "created";
      result = await writeComment("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, body, token);
    }
    if (!result.ok) {
      recordCommentFailure(run, prUrl, result.reason);
      return;
    }
    recordEvent({
      contract_id: run.contractId,
      kind: "GITHUB_COMMENT_POSTED",
      detail: {
        actor: "system",
        submission_id: run.submissionId,
        pull_request: prUrl,
        comment_id: result.id,
        comment_url: `${prUrl}#issuecomment-${result.id}`,
        action,
      },
    });
  } catch (err) {
    recordCommentFailure(run, prUrl, errorMessage(err));
  }
}

/** Posts per contract run one after another, so a quick re-run cannot race an earlier post into a second comment. */
const queues = new Map<string, Promise<void>>();

/**
 * Posts (or edits) the run's verdict on the contract's pull request when the
 * operator opted in. Never throws; resolves when the post is done or recorded
 * as failed.
 */
export function commentOnPullRequest(run: FinishedRun): Promise<void> {
  const next = (queues.get(run.contractId) ?? Promise.resolve()).then(() => post(run));
  queues.set(run.contractId, next);
  void next.then(() => {
    if (queues.get(run.contractId) === next) queues.delete(run.contractId);
  });
  return next;
}
