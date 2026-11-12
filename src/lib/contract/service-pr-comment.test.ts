/**
 * Posting the verdict on a code bounty's pull request: the escaper and the
 * body, then whole runs through the contract service with GitHub's API
 * replaced by a stubbed `fetch` and PayPal and the verifier mocked as in
 * service.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as verifier from "@/lib/verifier";
import { getContract } from "@/lib/db/contracts";
import { listEvents } from "@/lib/db/events";
import { listLedgerEntries } from "@/lib/db/ledger";
import type { ConditionInput, Contract, Verdict } from "@/lib/types";
import { withTempDb } from "@/test/helpers";
import { createFromProposal, rerunVerification, submitWork } from "./service";
import { buildCommentBody, commentMarker, inertText } from "./service-pr-comment";
import { listConditions } from "@/lib/db/conditions";
import { getSubmission } from "@/lib/db/submissions";
import { createVerdict } from "@/lib/db/verdicts";
import { parsePullRequestUrl } from "@/lib/verifier/github";
import { CONDITIONS, daysFromNow, fund, installPayPalFakes, newContract, seedIdentities, type FakeOutcome } from "./service-testkit";

vi.mock("@/lib/paypal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paypal")>();
  return {
    ...actual,
    createAuthorizedOrder: vi.fn(),
    authorizeOrder: vi.fn(),
    captureAuthorization: vi.fn(),
    voidAuthorization: vi.fn(),
    payout: vi.fn(),
    getPayoutBatch: vi.fn(),
    refundCapture: vi.fn(),
  };
});
vi.mock("@/lib/verifier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verifier")>()),
  verifySubmission: vi.fn(),
}));
vi.mock("@/lib/ai/mediator", () => ({ proposeSplit: vi.fn() }));
vi.mock("@/lib/ai/drafter", () => ({ draftContract: vi.fn() }));

withTempDb();

const TOKEN = "ghp_TESTTOKEN0123456789abcdef";
const PR_URL = "https://github.com/acme/app/pull/7";
const CREATE = "POST /repos/acme/app/issues/7/comments";
const edit = (id: number) => `PATCH /repos/acme/app/issues/comments/${id}`;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
let routes: Map<string, Reply[]>;
let requests: { route: string; headers: Record<string, string>; body: string; redirect?: RequestRedirect }[];

function route(key: string, ...replies: Reply[]) {
  routes.set(key, replies);
}

beforeEach(() => {
  vi.resetAllMocks();
  seedIdentities();
  installPayPalFakes();
  vi.stubEnv("CLAUSE_GITHUB_PR_COMMENTS", "1");
  vi.stubEnv("GITHUB_TOKEN", TOKEN);
  vi.stubEnv("RENDER_EXTERNAL_URL", "");
  routes = new Map();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      requests.push({ route: key, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? ""), redirect: init?.redirect });
      const queue = routes.get(key);
      if (!queue || queue.length === 0) return new Response('{"message":"Not Found"}', { status: 404 });
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const commentEvents = (contractId: string) => listEvents(contractId).filter((e) => e.kind.startsWith("GITHUB_COMMENT_"));
const postedBody = (i: number) => (JSON.parse(requests[i].body) as { body: string }).body;

async function fundedBounty(conditions: ConditionInput[] = CONDITIONS.code_bounty): Promise<Contract> {
  const contract = conditions === CONDITIONS.code_bounty
    ? newContract("code_bounty")
    : createFromProposal("payer", {
        title: "code bounty",
        type: "code_bounty",
        amount_cents: 20000,
        currency: "USD",
        deadline_at: daysFromNow(3),
        conditions,
        notes: [],
      });
  return fund(contract.id);
}

/**
 * A fake verifier like the testkit's, whose GitHub verdicts carry the pull
 * request excerpt the real checks attach once GitHub returned the PR (here:
 * the submitted PR, based in its own repository).
 */
function fakeVerifier(outcome: FakeOutcome): void {
  vi.mocked(verifier.verifySubmission).mockImplementation(async (submissionId) => {
    const submission = getSubmission(submissionId)!;
    const ref = parsePullRequestUrl(submission.url);
    const pullRequest = ref ? { pull_request: { number: ref.number, base_repo: `${ref.owner}/${ref.repo}` } } : {};
    const conditions = listConditions(submission.contract_id);
    const verdicts = conditions.map((condition, i) => {
      const result = outcome === "passed" || i > 0 ? "pass" : outcome === "failed" ? "fail" : "inconclusive";
      return createVerdict({
        submission_id: submissionId,
        condition_id: condition.id,
        passed: result === "pass",
        confidence: result === "inconclusive" ? 0 : 1,
        reasoning: `${outcome} check ${i}`,
        evidence: { outcome: result, ...pullRequest },
      });
    });
    return {
      contractId: submission.contract_id,
      submissionId,
      verdicts,
      allPassed: outcome === "passed",
      outcome,
      inconclusive: outcome === "inconclusive" ? [{ condition_id: conditions[0].id, reason: "GitHub did not answer." }] : [],
    };
  });
}

/** Submits `url` as the worker and runs the verification job to the end. */
async function verifyPr(contractId: string, outcome: FakeOutcome, url = PR_URL): Promise<Contract> {
  fakeVerifier(outcome);
  await submitWork(contractId, "worker", url).run();
  return getContract(contractId)!;
}

/** Submits `url` as the worker and runs the job with whatever verifier is installed. */
async function submitToRealVerifier(contractId: string, url: string): Promise<Contract> {
  await submitWork(contractId, "worker", url).run();
  return getContract(contractId)!;
}

/** The real verifier, with GitHub's GET answers from `routes`. */
async function useRealVerifier(): Promise<void> {
  const actual = await vi.importActual<typeof import("@/lib/verifier")>("@/lib/verifier");
  vi.mocked(verifier.verifySubmission).mockImplementation(actual.verifySubmission);
}

function pullRequest(baseRepo: string) {
  return {
    number: 7,
    html_url: PR_URL,
    state: "open",
    title: "Add the exporter",
    body: null,
    merged: false,
    merged_at: null,
    merged_by: null,
    user: { login: "worker" },
    head: { sha: "abc1234def5678", ref: "feature", repo: { full_name: "worker/app" } },
    base: { ref: "main", repo: { full_name: baseRepo, default_branch: "main" } },
  };
}

const writes = () => requests.filter((r) => !r.route.startsWith("GET "));

// ---------------------------------------------------------------------------
// The escaper and the body
// ---------------------------------------------------------------------------

describe("inertText", () => {
  const inside = (s: string) => {
    expect(s.startsWith("`") && s.endsWith("`")).toBe(true);
    return s.slice(1, -1);
  };

  it("cannot mention anyone", () => {
    const out = inside(inertText("thanks @octocat and @acme/team"));
    expect(out).not.toMatch(/@[\w-]/);
    expect(out).toContain("@\u200boctocat");
  });

  it("cannot reference an issue or pull request", () => {
    const out = inside(inertText("Fixes #12, acme/app#13 and other/repo#14"));
    expect(out).not.toMatch(/#\d/);
  });

  it("cannot create a link, autolink or image", () => {
    const out = inside(inertText("[click](https://evil.example/x) ![img](http://evil.example/a.png) https://evil.example"));
    expect(out).not.toContain("://");
    // Brackets stay as text: the whole thing sits inside a code span, where markdown is not parsed.
    expect(inertText("[click](https://evil.example)").split("`")).toHaveLength(3);
  });

  it("cannot emit HTML", () => {
    const out = inside(inertText('<img src=x onerror="alert(1)"><!-- hidden --><details open>'));
    expect(out).not.toMatch(/[<>]/);
  });

  it("cannot close its code span with backticks", () => {
    const out = inertText("a`b``c```d");
    expect(out.match(/`/g)).toHaveLength(2);
    expect(inside(out)).toBe("a'b''c'''d");
  });

  it("stays on one line, so it cannot start a block or end the list item", () => {
    const out = inertText("first\n\n# Heading\r\n- item\u2028> quote\u2029\tend");
    expect(out).not.toMatch(/[\r\n\t\u2028\u2029]/);
    expect(inside(out)).toBe("first # Heading - item › quote end".replace("#", "#\u200b"));
  });

  it("drops zero-width and bidi characters and normalises look-alikes", () => {
    expect(inside(inertText("a\u202eb\u200bc\ufeffd"))).toBe("a b c d");
    // A fullwidth @ is normalised to @ first, then neutralised.
    expect(inside(inertText("\uff20octocat"))).toBe("@\u200boctocat");
  });

  it("is clipped", () => {
    const out = inside(inertText("x".repeat(1000), 50));
    expect(Array.from(out)).toHaveLength(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves no lone surrogate (a UTF-16 cut in the middle of an emoji)", () => {
    for (const lone of ["clipped \ud83d", "\ude00 start", "mid\ud83dle"]) {
      const out = inertText(lone);
      expect(out.isWellFormed()).toBe(true);
      expect(out).toContain("�");
    }
    expect(inside(inertText("ok 😀"))).toBe("ok 😀");
  });

  it("says (none) for empty text instead of an empty code span", () => {
    expect(inertText(" \n\u200b ")).toBe("(none)");
  });
});

describe("buildCommentBody", () => {
  const conditions = [
    { id: "c1", check_kind: "github_pr_merged" as const },
    { id: "c2", check_kind: "github_checks_passed" as const },
    { id: "c3", check_kind: "github_pr_references_issue" as const },
  ];
  const verdict = (condition_id: string, outcome: "pass" | "fail" | "inconclusive", reasoning: string): Pick<Verdict, "condition_id" | "passed" | "reasoning" | "evidence"> => ({
    condition_id,
    passed: outcome === "pass",
    reasoning,
    evidence: { outcome },
  });
  const receipt = "a".repeat(64);
  const key = "b".repeat(64);

  it("leads with the marker and lists every check with its fixed description", () => {
    const body = buildCommentBody({
      contractId: "0b6f1c1e-1111-4222-8333-944455556666",
      outcome: "passed",
      conditions,
      verdicts: conditions.map((c) => verdict(c.id, "pass", "ok")),
      state: "PAID",
      receiptSha256: receipt,
      keyFingerprint: key,
      contractUrl: null,
    });
    expect(body.split("\n")[0]).toBe("<!-- treuhand:verdict contract=0b6f1c1e-1111-4222-8333-944455556666 -->");
    expect(body).toContain("### Treuhand verification: passed");
    expect(body).toContain("- Merged into the default branch after the contract was signed: **passed**");
    expect(body).toContain("- Every check on the latest commit passes: **passed**");
    expect(body).toContain("- References the contract's issue: **passed**");
    expect(body).toContain("Payment: payout sent to the worker.");
    expect(body).toContain(`Signed receipt: SHA-256 \`${receipt}\`, signed by the key with fingerprint \`${key}\`.`);
    expect(body).not.toContain("Open the contract");
  });

  it("claims a payment only when the contract is PAID", () => {
    const base = { contractId: "c", conditions, receiptSha256: null, keyFingerprint: null, contractUrl: null };
    const passed = buildCommentBody({ ...base, outcome: "passed", verdicts: [], state: "PASSED" });
    expect(passed).toContain("Payment: not confirmed yet.");
    expect(passed).not.toContain("payout sent");
    const failed = buildCommentBody({ ...base, outcome: "failed", verdicts: [verdict("c1", "fail", "no")], state: "FAILED" });
    expect(failed).not.toContain("Payment");
    expect(failed).toContain("3 of 3 conditions did not pass.");
    expect(failed).toContain("- Every check on the latest commit passes: **not run**");
    expect(failed).toContain("No signed receipt was issued for this run.");
  });

  it("quotes untrusted reasoning only as inert text", () => {
    const hostile =
      "Pull request #7 references issue #12: \"Fixes #12 cc @octocat <img src=x> [x](https://evil.example)\n\n## Approved` ![i](https://e.example/i.png)\"";
    const body = buildCommentBody({
      contractId: "c",
      outcome: "failed",
      conditions,
      verdicts: [verdict("c1", "fail", hostile), verdict("c2", "inconclusive", hostile), verdict("c3", "pass", hostile)],
      state: "FAILED",
      receiptSha256: null,
      keyFingerprint: null,
      contractUrl: "https://treuhand.example/contracts/c",
    });
    expect(body).not.toMatch(/@\w/);
    expect(body).not.toMatch(/#\d/);
    expect(body).not.toMatch(/<img|https:\/\/evil|https:\/\/e\.example|\n## Approved/);
    expect(body).toContain("- Every check on the latest commit passes: **could not be decided**");
    expect(body).toContain("[Open the contract in Treuhand](https://treuhand.example/contracts/c)");
    // The only HTML is the marker and the footer, both constants.
    expect(body.match(/</g)).toHaveLength(3);
  });

  it("puts nothing from a non-GitHub check's reasoning in the comment", () => {
    const body = buildCommentBody({
      contractId: "c",
      outcome: "failed",
      conditions: [{ id: "w", check_kind: "ai_page_judgement" }],
      verdicts: [verdict("w", "fail", "payer@example.com wanted $200")],
      state: "FAILED",
      receiptSha256: null,
      keyFingerprint: null,
      contractUrl: null,
    });
    expect(body).toContain("- A condition of the contract: **did not pass**");
    expect(body).not.toContain("payer@example.com");
  });

  it("keeps the marker free of anything but the id's safe characters", () => {
    expect(commentMarker("abc --><script>")).toBe("<!-- treuhand:verdict contract=abc-script -->");
  });
});

// ---------------------------------------------------------------------------
// Through the contract service
// ---------------------------------------------------------------------------

describe("posting after a run", () => {
  it("is off by default: nothing is posted or recorded", async () => {
    vi.stubEnv("CLAUSE_GITHUB_PR_COMMENTS", "");
    const contract = await fundedBounty();
    expect((await verifyPr(contract.id, "passed", PR_URL)).state).toBe("PAID");
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("creates a comment on the first run and edits it in place on the next", async () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://treuhand.example");
    route(CREATE, { status: 201, body: { id: 101, html_url: "https://github.com/acme/app/pull/7#issuecomment-101" } });
    route(edit(101), { status: 200, body: { id: 101 } });
    const contract = await fundedBounty();

    expect((await verifyPr(contract.id, "failed", PR_URL)).state).toBe("FAILED");
    expect(requests.map((r) => r.route)).toEqual([CREATE]);
    expect(postedBody(0)).toContain("### Treuhand verification: did not pass");
    expect(postedBody(0)).toContain(`[Open the contract in Treuhand](https://treuhand.example/contracts/${contract.id})`);

    expect((await verifyPr(contract.id, "passed", PR_URL)).state).toBe("PAID");
    expect(requests.map((r) => r.route)).toEqual([CREATE, edit(101)]);
    const body = postedBody(1);
    expect(body.split("\n")[0]).toBe(commentMarker(contract.id));
    expect(body).toContain("### Treuhand verification: passed");
    expect(body).toContain("Payment: payout sent to the worker.");
    expect(body).toMatch(/Signed receipt: SHA-256 `[0-9a-f]{64}`, signed by the key with fingerprint `[0-9a-f]{64}`\./);
    for (const secret of ["payer@example.com", "worker@example.com", "Payer", "Worker", "$", "200.00", "ORDER-", "AUTH-", "CAP-", "BATCH-"]) {
      expect(body).not.toContain(secret);
    }

    expect(commentEvents(contract.id).map((e) => [e.kind, e.detail.action, e.detail.comment_id])).toEqual([
      ["GITHUB_COMMENT_POSTED", "created", 101],
      ["GITHUB_COMMENT_POSTED", "updated", 101],
    ]);
    expect(commentEvents(contract.id)[1].detail).toMatchObject({
      actor: "system",
      pull_request: PR_URL,
      comment_url: `${PR_URL}#issuecomment-101`,
    });
    // Sent with the same headers as the verifier's GitHub client.
    expect(requests[0].headers).toMatchObject({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "clause-verifier",
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("creates a new comment when the stored one is gone (404 on edit)", async () => {
    route(CREATE, { status: 201, body: { id: 101 } }, { status: 201, body: { id: 202 } });
    route(edit(101), { status: 404, body: { message: "Not Found" } });
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    await verifyPr(contract.id, "failed", PR_URL);
    expect(requests.map((r) => r.route)).toEqual([CREATE, edit(101), CREATE]);
    expect(commentEvents(contract.id).map((e) => [e.detail.action, e.detail.comment_id])).toEqual([
      ["created", 101],
      ["created", 202],
    ]);
    // The run after that edits the new one.
    route(edit(202), { status: 200, body: { id: 202 } });
    await verifyPr(contract.id, "failed", PR_URL);
    expect(requests.at(-1)!.route).toBe(edit(202));
  });

  it("posts on an inconclusive run and edits it after a re-run", async () => {
    route(CREATE, { status: 201, body: { id: 5 } });
    route(edit(5), { status: 200, body: { id: 5 } });
    vi.stubEnv("CLAUSE_CONTEST_WINDOW_SECONDS", "3600");
    const contract = await fundedBounty();
    await verifyPr(contract.id, "inconclusive", PR_URL);
    expect(postedBody(0)).toContain("### Treuhand verification: undecided");
    fakeVerifier("passed");
    await rerunVerification(contract.id, "payer").run();
    expect(getContract(contract.id)!.state).toBe("PASSED");
    expect(requests.map((r) => r.route)).toEqual([CREATE, edit(5)]);
    // Passed but held for the contest window: no payment is claimed.
    expect(postedBody(1)).toContain("Payment: not confirmed yet.");
  });

  it("posts nothing for a submission outside the contract's repository, or not a pull request", async () => {
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", "https://github.com/other/app/pull/7");
    await verifyPr(contract.id, "failed", "https://github.com/acme/app/issues/7");
    await verifyPr(contract.id, "failed", "https://example.com/acme/app/pull/7");
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("posts nothing when the conditions name more than one repository", async () => {
    const contract = await fundedBounty([
      { text: "Merged", check_kind: "github_pr_merged", check_params: { repo: "acme/app" } },
      { text: "CI", check_kind: "github_checks_passed", check_params: { repo: "acme/other" } },
    ]);
    await verifyPr(contract.id, "failed", PR_URL);
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("posts nothing for a website contract", async () => {
    const contract = newContract("website_milestone");
    await fund(contract.id);
    await verifyPr(contract.id, "passed", PR_URL);
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("posts nothing after a crashed run", async () => {
    const contract = await fundedBounty();
    vi.mocked(verifier.verifySubmission).mockRejectedValue(new Error("browser died"));
    await submitWork(contract.id, "worker", PR_URL).run();
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("records once per run why nothing was posted when GITHUB_TOKEN is missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    expect(fetch).not.toHaveBeenCalled();
    const events = commentEvents(contract.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("GITHUB_COMMENT_FAILED");
    expect(events[0].detail.reason).toMatch(/GITHUB_TOKEN is not set/);
  });
});

describe("a GitHub failure", () => {
  it("leaves the outcome and settlement untouched and is recorded (one retry on 5xx)", async () => {
    route(CREATE, { status: 502 });
    const contract = await fundedBounty();
    expect((await verifyPr(contract.id, "passed", PR_URL)).state).toBe("PAID");
    expect(requests.map((r) => r.route)).toEqual([CREATE, CREATE]);
    expect(listLedgerEntries({ contract_id: contract.id }).map((e) => e.kind)).toEqual(["AUTHORIZED", "CAPTURED", "PAID_OUT"]);
    const kinds = listEvents(contract.id).map((e) => e.kind);
    expect(kinds.indexOf("GITHUB_COMMENT_FAILED")).toBeGreaterThan(kinds.indexOf("PAYOUT_SENT"));
    expect(listEvents(contract.id).find((e) => e.kind === "VERIFICATION_COMPLETED")!.detail.outcome).toBe("passed");
    expect(commentEvents(contract.id).map((e) => [e.kind, e.detail.reason])).toEqual([["GITHUB_COMMENT_FAILED", "GitHub answered HTTP 502."]]);
  });

  it.each([
    [401, "GitHub rejected GITHUB_TOKEN (HTTP 401)."],
    [403, "GitHub refused the comment (HTTP 403): the token needs the public_repo scope, or the conversation is locked."],
    [404, "GitHub answered HTTP 404: the pull request is gone or the token cannot see the repository."],
    [422, "GitHub refused the comment as invalid (HTTP 422)."],
    [429, "GitHub's rate limit is used up (HTTP 429)."],
  ])("HTTP %i is recorded without a retry", async (status, reason) => {
    route(CREATE, { status, body: { message: `token ${TOKEN} is bad` } });
    const contract = await fundedBounty();
    expect((await verifyPr(contract.id, "failed", PR_URL)).state).toBe("FAILED");
    expect(requests).toHaveLength(1);
    expect(commentEvents(contract.id).map((e) => e.detail.reason)).toEqual([reason]);
  });

  it("a network error is retried once, then recorded", async () => {
    route(CREATE, new TypeError(`fetch failed for ${TOKEN}`));
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    expect(requests).toHaveLength(2);
    expect(commentEvents(contract.id).map((e) => e.detail.reason)).toEqual(["GitHub could not be reached."]);
  });

  it("an answer without a comment id is a failure, not a stored comment", async () => {
    route(CREATE, { status: 201, body: { id: "101" } });
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    expect(commentEvents(contract.id).map((e) => [e.kind, e.detail.reason])).toEqual([
      ["GITHUB_COMMENT_FAILED", "GitHub's answer did not include a comment id."],
    ]);
  });

  it("an unknown CLAUSE_GITHUB_PR_COMMENTS value is recorded, and the run stands", async () => {
    vi.stubEnv("CLAUSE_GITHUB_PR_COMMENTS", "ghp_pasted_in_the_wrong_place");
    const contract = await fundedBounty();
    expect((await verifyPr(contract.id, "passed", PR_URL)).state).toBe("PAID");
    expect(fetch).not.toHaveBeenCalled();
    expect(commentEvents(contract.id).map((e) => e.detail.reason)).toEqual([expect.stringContaining("CLAUSE_GITHUB_PR_COMMENTS is not recognised")]);
    // The value itself is not repeated in the audit trail.
    expect(JSON.stringify(listEvents(contract.id))).not.toContain("ghp_pasted");
  });

  it("a redirect is never followed", async () => {
    route(CREATE, { status: 201, body: { id: 1 } });
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    expect(requests.map((r) => r.redirect)).toEqual(["error"]);
  });
});

describe("only a pull request the verifier saw", () => {
  it("posts nothing when GitHub has no pull request with that number (an issue, say)", async () => {
    await useRealVerifier();
    const contract = await fundedBounty();
    expect((await submitToRealVerifier(contract.id, PR_URL)).state).toBe("FAILED");
    expect(requests.map((r) => r.route)).toContain("GET /repos/acme/app/pulls/7");
    expect(writes()).toEqual([]);
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("posts nothing when GitHub says the pull request's base is another repository", async () => {
    await useRealVerifier();
    route("GET /repos/acme/app/pulls/7", { status: 200, body: pullRequest("other/app") });
    const contract = await fundedBounty();
    expect((await submitToRealVerifier(contract.id, PR_URL)).state).toBe("FAILED");
    expect(writes()).toEqual([]);
    expect(commentEvents(contract.id)).toEqual([]);
  });

  it("posts when the verifier fetched the pull request in the contract's repository", async () => {
    await useRealVerifier();
    route("GET /repos/acme/app/pulls/7", { status: 200, body: pullRequest("acme/app") });
    route(CREATE, { status: 201, body: { id: 9 } });
    const contract = await fundedBounty();
    expect((await submitToRealVerifier(contract.id, PR_URL)).state).toBe("FAILED");
    expect(writes().map((r) => r.route)).toEqual([CREATE]);
    expect(commentEvents(contract.id).map((e) => e.kind)).toEqual(["GITHUB_COMMENT_POSTED"]);
  });
});

describe("one pull request per contract", () => {
  it("records, and does not post, a run on another pull request once the verdict is on one", async () => {
    route(CREATE, { status: 201, body: { id: 3 } });
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    await verifyPr(contract.id, "failed", "https://github.com/acme/app/pull/8");
    expect(requests.map((r) => r.route)).toEqual([CREATE]);
    expect(commentEvents(contract.id).map((e) => [e.kind, e.detail.pull_request, e.detail.reason ?? null])).toEqual([
      ["GITHUB_COMMENT_POSTED", PR_URL, null],
      [
        "GITHUB_COMMENT_FAILED",
        "https://github.com/acme/app/pull/8",
        "This contract's verdict is already posted on another pull request, so nothing was posted on this one.",
      ],
    ]);
  });
});

describe("the token", () => {
  it("never appears in the audit trail", async () => {
    route(CREATE, { status: 201, body: { id: 1 } });
    route(edit(1), { status: 500, body: { message: TOKEN } });
    const contract = await fundedBounty();
    await verifyPr(contract.id, "failed", PR_URL);
    await verifyPr(contract.id, "failed", PR_URL);
    expect(commentEvents(contract.id).map((e) => e.kind)).toEqual(["GITHUB_COMMENT_POSTED", "GITHUB_COMMENT_FAILED"]);
    expect(JSON.stringify(listEvents(contract.id))).not.toContain(TOKEN);
    expect(JSON.stringify(listEvents(contract.id))).not.toContain("TESTTOKEN");
  });
});
