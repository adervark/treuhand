/**
 * How a condition will be checked, in a sentence a payer can read, plus a
 * compact technical line (the exact selector, repo, width) for the people who
 * want to see precisely what the machine will do.
 */
import { CHECK_KINDS_BY_CONTRACT_TYPE, type CheckKind, type ConditionCheck, type ContractType } from "@/lib/types";

type Params = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function onPage(p: Params): string {
  return str(p.path) ? ` at ${p.path}` : "";
}

export function describeCheck(check: Pick<ConditionCheck, "check_kind" | "check_params"> | { check_kind: CheckKind; check_params: Params }): string {
  const p = check.check_params as Params;
  switch (check.check_kind) {
    case "github_pr_merged":
      return `GitHub is asked whether the pull request in ${str(p.repo) ?? "the repository"} has been merged.`;
    case "github_checks_passed":
      return `GitHub is asked whether every check run on the pull request's latest commit passed.`;
    case "github_pr_references_issue":
      return `GitHub is asked whether the pull request references issue #${p.issue ?? "?"} in ${str(p.repo) ?? "the repository"}.`;
    case "http_ok":
      return `Treuhand requests the submitted URL${onPage(p)} and expects a successful (2xx) response.`;
    case "dom_assert":
      return str(p.text)
        ? `A browser opens the page${onPage(p)} and looks for ${p.selector} containing "${p.text}".`
        : `A browser opens the page${onPage(p)} and looks for ${str(p.selector) ?? "the element"}.`;
    case "responsive":
      return `A browser renders the page${onPage(p)} ${typeof p.width === "number" ? p.width : 375}px wide and checks that nothing scrolls sideways.`;
    case "form_submits": {
      const n = p.fields && typeof p.fields === "object" ? Object.keys(p.fields).length : 0;
      return `A browser fills ${n} field${n === 1 ? "" : "s"} in ${str(p.form_selector) ?? "the form"}${onPage(p)}, submits it, and waits for "${str(p.success_text) ?? "…"}".`;
    }
    case "ai_page_judgement":
      return `The AI looks at a screenshot and the text of the page${onPage(p)} and answers: "${str(p.criterion) ?? "…"}"`;
  }
}

/** One-line technical summary of the params, e.g. `dom_assert · form` */
export function checkSignature(check: { check_kind: CheckKind; check_params: unknown }): string {
  const p = (check.check_params ?? {}) as Params;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "criterion") continue;
    if (typeof v === "object") parts.push(`${k}: ${Object.keys(v as object).length}`);
    else parts.push(`${k}=${String(v)}`);
  }
  return [check.check_kind, ...parts].join(" · ");
}

export function allowedKinds(type: ContractType): readonly CheckKind[] {
  return CHECK_KINDS_BY_CONTRACT_TYPE[type];
}

/** Sensible starting params when someone switches a condition to a new check kind. */
export function defaultParams(kind: CheckKind, previous: Params = {}): Params {
  const path = str(previous.path);
  const repo = str(previous.repo) ?? "";
  switch (kind) {
    case "github_pr_merged":
    case "github_checks_passed":
      return { repo };
    case "github_pr_references_issue":
      return { repo, issue: typeof previous.issue === "number" ? previous.issue : 1 };
    case "http_ok":
      return path ? { path } : {};
    case "dom_assert":
      return { ...(path ? { path } : {}), selector: str(previous.selector) ?? "" };
    case "responsive":
      return { ...(path ? { path } : {}), width: 375 };
    case "form_submits":
      return {
        ...(path ? { path } : {}),
        form_selector: str(previous.form_selector) ?? "form",
        fields: {},
        success_text: "",
      };
    case "ai_page_judgement":
      return { ...(path ? { path } : {}), criterion: "" };
  }
}
