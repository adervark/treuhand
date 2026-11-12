import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIOutputError, draftContract, type DraftRequest } from "./drafter";
import { DRAFTER_SYSTEM_PROMPT } from "./prompts";

const create = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({
  getAIClient: () => ({ client: { chat: { completions: { create } } }, model: "test-model" }),
}));

function completion(content: string, finish_reason = "stop") {
  return { choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }] };
}
const replyWith = (value: unknown) => completion(JSON.stringify(value));

type Messages = { role: string; content: string }[];
const messagesOfCall = (n: number): Messages => create.mock.calls[n][0].messages;

const request: DraftRequest = {
  prompt: "Pay $50 to whoever fixes issue #212 in acme/widgets once CI passes, by 2026-11-20.",
  payerEmail: "payer@example.com",
  workerEmail: "worker@example.com",
};

const bountyReply = {
  title: "Fix issue #212 in acme/widgets",
  type: "code_bounty",
  amount: 50,
  currency: "usd",
  deadline: "2026-11-20",
  conditions: [
    {
      as_stated: "fixes issue #212 in acme/widgets",
      verdict: "checkable",
      checks: [
        {
          text: "The pull request references issue #212.",
          check_kind: "github_pr_references_issue",
          check_params: { repo: "acme/widgets", issue: 212 },
        },
        { text: "The pull request is merged.", check_kind: "github_pr_merged", check_params: { repo: "acme/widgets" } },
      ],
      note: "'Fixes issue #212' is checked as a merged pull request that references it.",
      reason: null,
      suggested_rewrite: null,
    },
    {
      as_stated: "CI passes",
      verdict: "checkable",
      checks: [{ text: "Every CI check passes.", check_kind: "github_checks_passed", check_params: { repo: "acme/widgets" } }],
      note: null,
      reason: null,
      suggested_rewrite: null,
    },
  ],
};

beforeEach(() => {
  create.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("draftContract", () => {
  it("returns a draft with conditions mapped to check kinds and terms converted", async () => {
    create.mockResolvedValueOnce(replyWith(bountyReply));

    const result = await draftContract(request);

    expect(result).toEqual({
      kind: "draft",
      contract: {
        title: "Fix issue #212 in acme/widgets",
        type: "code_bounty",
        amount_cents: 5000,
        currency: "USD",
        deadline_at: "2026-11-20T23:59:59.000Z",
        conditions: [
          {
            text: "The pull request references issue #212.",
            check_kind: "github_pr_references_issue",
            check_params: { repo: "acme/widgets", issue: 212 },
          },
          { text: "The pull request is merged.", check_kind: "github_pr_merged", check_params: { repo: "acme/widgets" } },
          { text: "Every CI check passes.", check_kind: "github_checks_passed", check_params: { repo: "acme/widgets" } },
        ],
        notes: ["'Fixes issue #212' is checked as a merged pull request that references it."],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("asks for JSON output with the drafter prompt, the deal as data, and today's date, and never sends the emails", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-11T09:00:00Z"), toFake: ["Date"] });
    create.mockResolvedValueOnce(replyWith(bountyReply));

    await draftContract({ ...request, type: "code_bounty" });

    const params = create.mock.calls[0][0];
    expect(params.model).toBe("test-model");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.thinking).toEqual({ type: "enabled" });
    const [system, user] = messagesOfCall(0);
    expect(system).toEqual({ role: "system", content: DRAFTER_SYSTEM_PROMPT });
    expect(user.content).toContain(JSON.stringify(request.prompt));
    expect(user.content).toContain("2026-11-11 (Wednesday)");
    expect(user.content).toContain('fixed by the payer as "code_bounty"');
    expect(JSON.stringify(params)).not.toMatch(/payer@example\.com|worker@example\.com/);
  });

  it("lists a test once when two stated conditions map to the same check", async () => {
    create.mockResolvedValueOnce(
      replyWith({
        ...bountyReply,
        conditions: [
          bountyReply.conditions[0],
          {
            as_stated: "once the PR is merged",
            verdict: "checkable",
            checks: [{ text: "The PR is merged.", check_kind: "github_pr_merged", check_params: { repo: "acme/widgets" } }],
            note: null,
          },
          {
            as_stated: "it references the issue",
            verdict: "checkable",
            checks: [
              { text: "A", check_kind: "github_pr_references_issue", check_params: { repo: "acme/widgets", issue: 212 } },
              { text: "B", check_kind: "github_pr_references_issue", check_params: { issue: 212, repo: "acme/widgets" } },
              { text: "C", check_kind: "github_pr_references_issue", check_params: { repo: "acme/widgets", issue: 7 } },
            ],
            note: null,
          },
        ],
      }),
    );

    const result = await draftContract(request);

    expect(result.kind === "draft" && result.contract.conditions.map((c) => c.text)).toEqual([
      "The pull request references issue #212.",
      "The pull request is merged.",
      "C",
    ]);
  });

  it("keeps terms the deal does not state as null instead of guessing them", async () => {
    create.mockResolvedValueOnce(replyWith({ ...bountyReply, amount: null, currency: null, deadline: null }));

    const result = await draftContract(request);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.contract.amount_cents).toBeNull();
    expect(result.contract.currency).toBeNull();
    expect(result.contract.deadline_at).toBeNull();
  });

  it("normalises a deadline with a time zone to UTC", async () => {
    create.mockResolvedValueOnce(replyWith({ ...bountyReply, deadline: "2026-11-20T17:00:00+05:30" }));

    const result = await draftContract(request);

    expect(result.kind === "draft" && result.contract.deadline_at).toBe("2026-11-20T11:30:00.000Z");
  });

  it("refuses when any condition is not checkable, listing only those and dropping nothing silently", async () => {
    create.mockResolvedValueOnce(
      replyWith({
        title: "Bakery landing page",
        type: "website_milestone",
        amount: 300,
        currency: "USD",
        deadline: null,
        conditions: [
          {
            as_stated: "loads at a public URL",
            verdict: "checkable",
            checks: [{ text: "The page responds with 2xx.", check_kind: "http_ok", check_params: {} }],
            note: null,
            reason: null,
            suggested_rewrite: null,
          },
          {
            as_stated: "looks professional",
            verdict: "not_checkable",
            checks: [],
            note: null,
            reason: "Whether a page looks professional is a matter of taste.",
            suggested_rewrite: "The home page shows the heading 'Fresh bread daily' and works at 375px wide.",
          },
        ],
      }),
    );

    const result = await draftContract({ ...request, prompt: "A landing page that loads and looks professional, $300." });

    expect(result).toEqual({
      kind: "refusal",
      vague_conditions: [
        {
          condition: "looks professional",
          reason: "Whether a page looks professional is a matter of taste.",
          suggested_rewrite: "The home page shows the heading 'Fresh bread daily' and works at 375px wide.",
        },
      ],
    });
  });

  it("passes on a null rewrite: no check comes close, so the payer should drop the condition", async () => {
    create.mockResolvedValueOnce(
      replyWith({
        title: "Yoga studio website",
        type: "website_milestone",
        amount: 200,
        currency: "USD",
        deadline: null,
        conditions: [
          {
            as_stated: "the code must be clean",
            verdict: "not_checkable",
            checks: [],
            note: null,
            reason: "No available check reads a website's source code, so this cannot be checked; drop it.",
            suggested_rewrite: null,
          },
        ],
      }),
    );

    const result = await draftContract({ ...request, prompt: "A website for my yoga studio, $200. The code must be clean." });

    expect(result).toEqual({
      kind: "refusal",
      vague_conditions: [
        {
          condition: "the code must be clean",
          reason: "No available check reads a website's source code, so this cannot be checked; drop it.",
          suggested_rewrite: null,
        },
      ],
    });
  });

  it("retries with the validation error fed back when the reply is invalid, then accepts a valid one", async () => {
    const wrongKind = structuredClone(bountyReply);
    wrongKind.conditions[1].checks[0] = { text: "The site loads.", check_kind: "http_ok", check_params: {} } as never;
    create.mockResolvedValueOnce(replyWith(wrongKind)).mockResolvedValueOnce(replyWith(bountyReply));

    const result = await draftContract(request);

    expect(result.kind).toBe("draft");
    expect(create).toHaveBeenCalledTimes(2);
    const retry = messagesOfCall(1);
    expect(retry).toHaveLength(4);
    expect(retry[2]).toEqual({ role: "assistant", content: JSON.stringify(wrongKind) });
    expect(retry[3].role).toBe("user");
    expect(retry[3].content).toContain('"http_ok" is not a code_bounty check');
    expect(retry[3].content).toContain("conditions[1].checks[0].check_kind");
  });

  it("rejects check params that do not fit the check kind", async () => {
    const badParams = structuredClone(bountyReply);
    badParams.conditions[0].checks[0].check_params = { repo: "not a repo", issue: 212 };
    create.mockResolvedValueOnce(replyWith(badParams)).mockResolvedValueOnce(replyWith(bountyReply));

    await draftContract(request);

    expect(messagesOfCall(1)[3].content).toContain('expected "owner/name"');
  });

  it("rejects a reply whose type differs from the type the payer fixed", async () => {
    create.mockResolvedValueOnce(replyWith(bountyReply)).mockResolvedValueOnce(
      replyWith({
        ...bountyReply,
        type: "website_milestone",
        conditions: [
          {
            as_stated: "the page loads",
            verdict: "checkable",
            checks: [{ text: "The page responds with 2xx.", check_kind: "http_ok", check_params: { path: null } }],
            note: null,
          },
        ],
      }),
    );

    const result = await draftContract({ ...request, type: "website_milestone" });

    expect(messagesOfCall(1)[3].content).toContain('it must be "website_milestone"');
    // A null param means "not set" and is dropped rather than failing validation.
    expect(result.kind === "draft" && result.contract.conditions).toEqual([
      { text: "The page responds with 2xx.", check_kind: "http_ok", check_params: {} },
    ]);
  });

  it("treats a blank or truncated reply as invalid", async () => {
    create
      .mockResolvedValueOnce(completion("   "))
      .mockResolvedValueOnce(completion('{"title": "Fix', "length"))
      .mockResolvedValueOnce(replyWith(bountyReply));

    const result = await draftContract(request);

    expect(result.kind).toBe("draft");
    expect(messagesOfCall(1)[2]).toEqual({ role: "assistant", content: "(blank reply)" });
    expect(messagesOfCall(1)[3].content).toContain("blank");
    expect(messagesOfCall(2)[5].content).toContain("cut off");
  });

  it("throws AIOutputError after the retries are used up", async () => {
    create.mockResolvedValue(completion("not json at all"));

    const error = await draftContract(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIOutputError);
    expect(error).toMatchObject({ name: "AIOutputError", task: "drafter", attempts: 3 });
    expect((error as AIOutputError).problems).toHaveLength(3);
    expect((error as AIOutputError).message).toContain("not valid JSON");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("propagates API errors without retrying them as bad output", async () => {
    create.mockRejectedValueOnce(new Error("401 Authentication Fails"));

    await expect(draftContract(request)).rejects.toThrow("401 Authentication Fails");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty deal without calling the model", async () => {
    await expect(draftContract({ ...request, prompt: "   " })).rejects.toThrow(/empty/);
    expect(create).not.toHaveBeenCalled();
  });
});
