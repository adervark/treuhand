"use client";

/**
 * The new-contract composer. The payer describes the deal in plain English;
 * the drafter proposes a contract (or refuses the conditions it cannot turn
 * into tests); the payer edits every field and saves. The AI proposes, the
 * people decide: every proposed field says where its value came from.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ContractType, Identity } from "@/lib/types";
import { api, errorMessage, type DraftResult, type ProposedContract, type VagueCondition } from "./api";
import { ConditionsEditor, toEditable, validateConditions, type ConditionErrors, type EditableCondition } from "./conditions-editor";
import { CONTRACT_CURRENCY, MAX_AMOUNT_CENTS } from "@/lib/format";
import {
  centsToDollars,
  CONTRACT_TYPE_META,
  dollarsToCents,
  draftedDeadlineToLocalInput,
  formatCents,
  localInputToIso,
} from "./format";
import { IconArrowRight, IconCheck, IconCode, IconGlobe, IconPen, IconSpark, IconX } from "./icons";
import { blanksIn, firstBlank, rewriteDeal } from "./rewrite-deal";
import { RoleMark } from "./role-mark";
import { Banner, Button, cx, inputClass } from "./ui";

const EXAMPLES: { label: string; type: ContractType; prompt: string }[] = [
  {
    label: "Bakery website",
    type: "website_milestone",
    prompt:
      'Pay Sam $400 for a landing page for my bakery, Crumb & Co., due in 3 days. It must load at a public URL, work at phone width (375px) without scrolling sideways, have "Crumb & Co." in its main heading, show the text "Open Tuesday to Sunday, 7am to 3pm", and have a newsletter sign-up form that shows "Thanks for subscribing" after an email address is submitted.',
  },
  {
    label: "Code bounty",
    type: "code_bounty",
    prompt:
      "Pay Sam $50 for a pull request that fixes acme/scheduler#212 (the date picker crashes in Safari). The pull request must be merged and every CI check on it must pass. Deadline: 5 days from now.",
  },
];

type TypeChoice = ContractType | "auto";

type Phase =
  | { kind: "idle" }
  | { kind: "drafting" }
  | { kind: "draft"; proposal: ProposedContract }
  | { kind: "refusal"; vague: VagueCondition[]; applied: boolean[] };

export function Composer({ intro, outro, identities }: { intro: ReactNode; outro?: ReactNode; identities: Identity[] }) {
  const promptId = useId();
  const [prompt, setPrompt] = useState("");
  const [typeChoice, setTypeChoice] = useState<TypeChoice>("auto");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  // The `[blanks]` that applied rewrites put in the deal. Only these block drafting: brackets the payer typed never do.
  const [blanks, setBlanks] = useState<string[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);

  /** Selects the first blank a rewrite left in the deal, so the payer types straight over it. */
  function selectBlank(text: string, inserted: string[] = blanks): boolean {
    const blank = firstBlank(text, inserted);
    if (!blank) return false;
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(blank.index, blank.index + blank.text.length);
    });
    return true;
  }

  async function draft(text = prompt) {
    if (!text.trim()) {
      setError("Describe the deal first.");
      return;
    }
    const blank = firstBlank(text, blanks);
    if (blank) {
      setError(`Replace ${blank.text} in the deal with your own words first.`);
      selectBlank(text);
      return;
    }
    setError(null);
    const previous = phase;
    setPhase({ kind: "drafting" });
    try {
      const result = await api<DraftResult>("/api/contracts/draft", {
        body: { prompt: text.trim(), ...(typeChoice === "auto" ? {} : { type: typeChoice }) },
      });
      setDraftCount((n) => n + 1);
      if (result.kind === "draft") setPhase({ kind: "draft", proposal: result.contract });
      else setPhase({ kind: "refusal", vague: result.vague_conditions, applied: result.vague_conditions.map(() => false) });
    } catch (err) {
      setError(errorMessage(err));
      setPhase(previous.kind === "drafting" ? { kind: "idle" } : previous);
    }
  }

  function applyRewrite(i: number): string {
    if (phase.kind !== "refusal") return prompt;
    const next = rewriteDeal(prompt, phase.vague[i]);
    const inserted = [...blanks, ...blanksIn(phase.vague[i].suggested_rewrite)];
    setPrompt(next);
    setBlanks(inserted);
    setError(null);
    setPhase({ ...phase, applied: phase.applied.map((a, j) => a || j === i) });
    selectBlank(next, inserted);
    return next;
  }

  function applyAllAndRedraft() {
    if (phase.kind !== "refusal") return;
    let text = prompt;
    const inserted = [...blanks];
    phase.vague.forEach((v, i) => {
      if (phase.applied[i]) return;
      text = rewriteDeal(text, v);
      inserted.push(...blanksIn(v.suggested_rewrite));
    });
    setPrompt(text);
    setBlanks(inserted);
    setPhase({ ...phase, applied: phase.applied.map(() => true) });
    // A rewrite with a blank to fill in waits for the payer; otherwise draft straight away.
    if (selectBlank(text, inserted)) setError(null);
    else void draft(text);
  }

  const started = phase.kind !== "idle";

  const dealForm = (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void draft();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={promptId} className="text-sm font-semibold text-ink">
            The deal, in plain English
          </label>
          <span className="tnum text-[0.68rem] text-ink-3">{prompt.length}/4000</span>
        </div>
        <textarea
          ref={textarea}
          id={promptId}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={4000}
          rows={started ? 7 : 5}
          placeholder="Pay Sam $400 for a landing page for my bakery by Friday. It must work on phones and have a working sign-up form."
          className={cx(inputClass, "field-sizing-content min-h-32 resize-none text-[0.9375rem] leading-relaxed", !started && "3xl:min-h-56 3xl:max-h-[22rem]")}
          aria-describedby={`${promptId}-hint`}
        />
        <p id={`${promptId}-hint`} className="text-xs text-ink-3">
          Say who gets paid, how much, by when, and what must be true of the work.
        </p>
      </div>

      {!started ? (
        <>
          <div className="flex flex-wrap items-center gap-2 3xl:hidden">
            <span className="label">Try</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => {
                  setPrompt(ex.prompt);
                  setTypeChoice(ex.type);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-inset px-2.5 text-[0.75rem] font-semibold text-ink-2 ring-1 ring-rule ring-inset transition-colors duration-100 hover:bg-surface hover:text-ink hover:ring-rule-strong"
              >
                {ex.type === "code_bounty" ? <IconCode size={13} /> : <IconGlobe size={13} />}
                {ex.label}
              </button>
            ))}
          </div>
          {/* From 3xl there is room to show each example deal in full; choosing one fills the box. */}
          <div className="hidden flex-col gap-1.5 3xl:flex">
            <span className="label">Try an example</span>
            <ul className="flex flex-col gap-2">
              {EXAMPLES.map((ex) => {
                const chosen = prompt === ex.prompt;
                return (
                  <li key={ex.label}>
                    <button
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => {
                        setPrompt(ex.prompt);
                        setTypeChoice(ex.type);
                      }}
                      className={cx(
                        "flex w-full flex-col gap-1 border bg-inset px-3 py-2 text-left transition-colors duration-100 hover:border-rule-strong hover:bg-surface-2",
                        chosen ? "border-accent shadow-[inset_3px_0_0_var(--accent-fill)]" : "border-rule",
                      )}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
                          {ex.type === "code_bounty" ? <IconCode size={14} /> : <IconGlobe size={14} />}
                          {ex.label}
                        </span>
                        <span className="text-[0.7rem] text-ink-3">{chosen ? "In the box" : CONTRACT_TYPE_META[ex.type].label}</span>
                      </span>
                      <span className="text-[0.78rem] leading-relaxed text-ink-2">{ex.prompt}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : null}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-semibold text-ink">Contract type</legend>
        <div className="grid grid-cols-3 divide-x divide-rule border border-rule bg-inset">
          {(
            [
              ["auto", "AI decides", IconSpark],
              ["website_milestone", "Website", IconGlobe],
              ["code_bounty", "Code bounty", IconCode],
            ] as const
          ).map(([value, label, Icon]) => (
            <label
              key={value}
              className={cx(
                "flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2 text-[0.8rem] font-semibold whitespace-nowrap transition-colors duration-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                typeChoice === value ? "bg-accent-fill text-accent-on" : "text-ink-3 hover:text-ink",
              )}
            >
              <input
                type="radio"
                name="contract-type"
                value={value}
                checked={typeChoice === value}
                onChange={() => setTypeChoice(value)}
                className="sr-only"
              />
              <Icon size={14} className="shrink-0 max-[420px]:hidden" />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-ink-3">
          {typeChoice === "auto"
            ? "The AI picks website milestone or code bounty from what you wrote."
            : typeChoice === "website_milestone"
              ? "Checked by opening the live site in a browser."
              : "Checked against the pull request on GitHub."}
        </p>
      </fieldset>

      {error ? <Banner title="The draft did not go through">{error}</Banner> : null}

      <Button type="submit" size="lg" busy={phase.kind === "drafting"} className="w-full">
        {phase.kind === "drafting" ? (
          "The AI is drafting the contract…"
        ) : (
          <>
            <IconSpark size={18} />
            {draftCount > 0 ? "Draft again" : "Draft the contract"}
          </>
        )}
      </Button>
    </form>
  );

  if (!started) {
    return (
      // From 3xl three columns, top-aligned under the header: what Proviso is (the introduction over the
      // example run), the composer in the middle with a text box of a set height and the examples written
      // out, and "How a contract travels" on the right as a rail as tall as the other two. `home-scale`
      // (globals.css) enlarges the whole workspace from 4xl, so it reaches down the window with larger type.
      <div className="home-scale grid items-start gap-8 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-x-10 3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)] 3xl:gap-x-6">
        <div className="flex min-w-0 flex-col lg:pt-2 3xl:pt-0">{intro}</div>
        <section aria-label="New contract" className="overflow-hidden rounded-lg border border-rule-strong bg-surface lg:sticky lg:top-[4.75rem] 3xl:static 3xl:self-stretch">
          <header className="flex items-center justify-between gap-3 border-b border-rule bg-head px-4 py-1.5">
            <p className="panel-title">New contract</p>
            <p className="flex items-center gap-1.5 text-[0.72rem] text-ink-2">
              <RoleMark role="payer" /> drafted by the payer
            </p>
          </header>
          <div className="p-4">{dealForm}</div>
        </section>
        {outro ? <div className="min-w-0 lg:col-span-2 3xl:col-span-1 3xl:self-stretch">{outro}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">New contract</p>
          <h1 className="mt-0.5 text-[1.375rem] leading-[1.75rem] font-semibold text-ink">The AI proposes. You decide.</h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPhase({ kind: "idle" });
            setError(null);
          }}
        >
          Start over
        </Button>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] 3xl:grid-cols-[30rem_minmax(0,1fr)]">
        <section aria-label="Your deal" className="rounded-lg border border-rule bg-surface p-5 lg:sticky lg:top-[4.75rem]">
          <p className="label mb-3 flex items-center gap-1.5">
            <RoleMark role="payer" /> What you wrote
          </p>
          {dealForm}
        </section>

        <div className="min-w-0">
          {phase.kind === "drafting" ? <DraftingSkeleton /> : null}
          {phase.kind === "draft" ? (
            <ProposalForm key={draftCount} proposal={phase.proposal} identities={identities} />
          ) : null}
          {phase.kind === "refusal" ? (
            <RefusalCard
              vague={phase.vague}
              applied={phase.applied}
              onApply={(i) => applyRewrite(i)}
              onApplyAll={applyAllAndRedraft}
              onRedraft={() => void draft()}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DraftingSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-surface" aria-busy="true" aria-label="Drafting">
      <div className="scanbar relative border-b border-rule bg-machine-soft px-5 py-3.5">
        <p className="label flex items-center gap-1.5 text-machine">
          <span className="pulse-dot size-2 rounded-[1px] bg-machine-fill" aria-hidden /> AI drafter · working
        </p>
        <p className="mt-1 tnum text-[0.75rem] text-ink-2">
          Turning each thing you asked for into a test a machine can run, and refusing the ones it cannot.
        </p>
      </div>
      <div className="flex animate-pulse flex-col gap-3 p-5">
        <div className="h-9 w-3/4 rounded-xs bg-inset" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-16 rounded-xs bg-inset" />
          <div className="h-16 rounded-xs bg-inset" />
        </div>
        <div className="h-24 rounded-xs bg-inset" />
        <div className="h-24 rounded-xs bg-inset" />
      </div>
    </div>
  );
}

function Provenance({ changed, missing = false }: { changed: boolean; missing?: boolean }) {
  if (missing && !changed) {
    return <span className="inline-flex items-center gap-1 tnum text-[0.64rem] font-semibold text-disputed">Not in the deal · you fill it in</span>;
  }
  return changed ? (
    <span className="inline-flex items-center gap-1 tnum text-[0.64rem] font-semibold text-payer">
      <IconPen size={11} /> Edited by you
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 tnum text-[0.64rem] font-semibold text-machine">
      Proposed by the AI
    </span>
  );
}

function ProposalForm({ proposal, identities }: { proposal: ProposedContract; identities: Identity[] }) {
  const router = useRouter();
  const ids = useId();
  const [title, setTitle] = useState(proposal.title);
  const [type, setType] = useState<ContractType>(proposal.type);
  // Contracts are in US dollars only (DEF-18): a figure the deal gave in another currency is not carried over as dollars.
  const foreignCurrency = proposal.currency !== null && proposal.currency.toUpperCase() !== CONTRACT_CURRENCY ? proposal.currency : null;
  const draftedAmount = proposal.amount_cents === null || foreignCurrency ? "" : centsToDollars(proposal.amount_cents);
  const [amount, setAmount] = useState(draftedAmount);
  const [deadline, setDeadline] = useState(draftedDeadlineToLocalInput(proposal.deadline_at));
  const original = useMemo(() => toEditable(proposal.conditions), [proposal.conditions]);
  const [conditions, setConditions] = useState<EditableCondition[]>(original);
  const [conditionErrors, setConditionErrors] = useState<ConditionErrors[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The Draft button this replaced had focus: hand it to the proposal's heading, not back to the page (DEF-21).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const payer = identities.find((i) => i.role === "payer");
  const worker = identities.find((i) => i.role === "worker");
  const originalAmount = draftedAmount;
  const originalDeadline = draftedDeadlineToLocalInput(proposal.deadline_at);
  const conditionsChanged = JSON.stringify(strip(conditions)) !== JSON.stringify(strip(original));

  async function save() {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = "Give the contract a title.";
    const cents = dollarsToCents(amount);
    if (!amount.trim()) errs.amount = "The deal didn't state an amount. Enter one.";
    else if (cents === null || cents <= 0) errs.amount = "Enter an amount such as 400 or 400.00.";
    else if (cents > MAX_AMOUNT_CENTS) errs.amount = `At most ${formatCents(MAX_AMOUNT_CENTS, CONTRACT_CURRENCY)} per contract.`;
    const deadlineIso = localInputToIso(deadline);
    if (!deadline) errs.deadline = "The deal didn't state a deadline. Pick one.";
    else if (!deadlineIso) errs.deadline = "Enter a valid date and time.";
    else if (Date.parse(deadlineIso) <= Date.now()) errs.deadline = "The deadline must be in the future.";
    const checked = validateConditions(type, conditions);
    setFieldErrors(errs);
    setConditionErrors(checked.ok ? [] : checked.errors);
    if (Object.keys(errs).length > 0 || !checked.ok) {
      setFormError(checked.ok ? "Fill in the highlighted fields." : checked.message);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const { contract } = await api<{ contract: { id: string } }>("/api/contracts", {
        body: {
          title: title.trim(),
          type,
          amount_cents: cents,
          currency: CONTRACT_CURRENCY,
          deadline_at: deadlineIso,
          conditions: checked.value,
          notes: proposal.notes,
        },
      });
      // The composer is long and the contract page loads in after a skeleton; start it at the top.
      window.scrollTo({ top: 0 });
      router.push(`/contracts/${contract.id}`);
    } catch (err) {
      setFormError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${ids}-h`} className="rise overflow-hidden rounded-lg border border-rule-strong bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-head px-4 py-2">
        <div>
          <p className="label flex items-center gap-1.5 text-machine">
            Proposed by the AI
          </p>
          <h2 ref={heading} tabIndex={-1} id={`${ids}-h`} className="text-[0.95rem] font-semibold text-ink">
            Check every field. Nothing is agreed until both of you sign.
          </h2>
        </div>
      </header>

      {proposal.notes.length > 0 ? (
        <div className="border-b border-rule bg-machine-soft px-5 py-3.5">
          <p className="label text-machine">Where the AI interpreted your words</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {proposal.notes.map((n, i) => (
              <li key={i} className="flex gap-2 tnum text-[0.75rem] leading-[1.2rem] text-ink">
                <span className="shrink-0 text-machine" aria-hidden>
                  ·
                </span>
                {n}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-2">Both parties see these notes on the contract before they sign.</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-5 px-5 py-5 3xl:grid 3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] 3xl:grid-rows-[repeat(4,auto)_1fr] 3xl:items-start 3xl:gap-x-6">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${ids}-title`} className="text-sm font-semibold text-ink">
              Title
            </label>
            <Provenance changed={title !== proposal.title} />
          </div>
          <input
            id={`${ids}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={fieldErrors.title ? true : undefined}
            className={cx(inputClass, "text-base font-medium")}
          />
          {fieldErrors.title ? <p className="text-xs font-medium text-fail">{fieldErrors.title}</p> : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${ids}-amount`} className="text-sm font-semibold text-ink">
                Amount
              </label>
              <Provenance changed={amount !== originalAmount} missing={proposal.amount_cents === null || foreignCurrency !== null} />
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 tnum text-sm text-ink-3" aria-hidden>
                  $
                </span>
                <input
                  id={`${ids}-amount`}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  aria-invalid={fieldErrors.amount ? true : undefined}
                  aria-describedby={`${ids}-amount-note`}
                  className={cx(
                    inputClass,
                    "pl-7 tnum text-base font-semibold",
                    (proposal.amount_cents === null || foreignCurrency) && !amount && "border-disputed bg-disputed-soft",
                  )}
                />
              </div>
              {/* Not a choice: contracts are in US dollars only (CONTRACT_CURRENCY). The wrapper sets the width, as inputClass carries w-full. */}
              <div className="w-24 shrink-0">
                <p className={cx(inputClass, "flex items-center text-ink-2")} title="Contracts are paid in US dollars only">
                  <span className="sr-only">Currency: </span>
                  {CONTRACT_CURRENCY}
                </p>
              </div>
            </div>
            <p id={`${ids}-amount-note`} className={cx("text-xs", fieldErrors.amount ? "font-medium text-fail" : foreignCurrency ? "font-medium text-disputed" : "text-ink-3")}>
              {fieldErrors.amount ??
                (foreignCurrency
                  ? `The deal is in ${foreignCurrency}; contracts are paid in US dollars only. Enter the amount in USD.`
                  : proposal.amount_cents === null
                    ? "The deal didn't state an amount, so the AI left it empty."
                    : proposal.currency === null
                      ? "The deal named no currency; contracts are in US dollars."
                      : `Held by PayPal when the payer funds the contract. At most ${formatCents(MAX_AMOUNT_CENTS, CONTRACT_CURRENCY)}.`)}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${ids}-deadline`} className="text-sm font-semibold text-ink">
                Deadline
              </label>
              <Provenance changed={deadline !== originalDeadline} missing={proposal.deadline_at === null} />
            </div>
            <input
              id={`${ids}-deadline`}
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
              aria-invalid={fieldErrors.deadline ? true : undefined}
              aria-describedby={`${ids}-deadline-note`}
              className={cx(
                inputClass,
                // Chromium does not match :focus-visible on a date field whose inner part has focus, so this one rings on :focus-within (DEF-21).
                "tnum text-[0.8125rem] focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-focus focus-within:outline-solid",
                proposal.deadline_at === null && !deadline && "border-disputed bg-disputed-soft",
              )}
            />
            <p id={`${ids}-deadline-note`} className={cx("text-xs", fieldErrors.deadline ? "font-medium text-fail" : "text-ink-3")}>
              {fieldErrors.deadline ??
                (proposal.deadline_at === null
                  ? "The deal didn't state a deadline, so the AI left it empty."
                  : "If no attempt passes by then, the hold is released to the payer.")}
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <PartyField role="payer" identity={payer} />
          <PartyField role="worker" identity={worker} />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-ink" id={`${ids}-type`}>
              Contract type
            </span>
            <Provenance changed={type !== proposal.type} />
          </div>
          <div role="radiogroup" aria-labelledby={`${ids}-type`} className="grid grid-cols-2 gap-2">
            {(["website_milestone", "code_bounty"] as const).map((t) => (
              <label
                key={t}
                className={cx(
                  "flex h-9 cursor-pointer items-center gap-2 rounded-sm px-3 text-sm font-semibold ring-1 ring-inset transition-colors duration-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                  type === t ? "bg-accent-fill text-accent-on ring-accent-fill" : "bg-surface text-ink-2 ring-field hover:bg-surface-2",
                )}
              >
                <input type="radio" name={`${ids}-type`} value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
                {t === "code_bounty" ? <IconCode size={15} /> : <IconGlobe size={15} />}
                {CONTRACT_TYPE_META[t].label}
              </label>
            ))}
          </div>
          {type !== proposal.type ? (
            <p className="text-xs text-disputed">Each type has its own checks. Conditions that do not fit the new type are marked below.</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 3xl:col-start-2 3xl:row-span-5 3xl:row-start-1 4xl:[&_ol]:grid 4xl:[&_ol]:grid-cols-2 4xl:[&_ol]:items-start">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">Tests</h3>
              <p className="text-xs text-ink-3">
                Each condition becomes a test, fixed once both sign. The money moves only when every test passes.
              </p>
            </div>
            <Provenance changed={conditionsChanged} />
          </div>
          <ConditionsEditor type={type} conditions={conditions} onChange={setConditions} errors={conditionErrors} disabled={saving} />
        </div>
      </div>

      <footer className="flex flex-col gap-3 border-t border-rule bg-surface-2 px-5 py-4">
        {formError ? <Banner title="Not saved yet">{formError}</Banner> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs text-ink-3">
            Saving creates a draft both parties can edit. No money moves until both sign and the payer funds it with PayPal.
          </p>
          <Button size="lg" variant="payer" onClick={() => void save()} busy={saving}>
            Create the contract <IconArrowRight size={17} />
          </Button>
        </div>
      </footer>
    </section>
  );
}

function strip(list: EditableCondition[]) {
  return list.map(({ text, check_kind, check_params }) => ({ text, check_kind, check_params }));
}

function PartyField({ role, identity }: { role: "payer" | "worker"; identity: Identity | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-ink">{role === "payer" ? "Payer" : "Worker (paid to this PayPal email)"}</span>
      <div
        className={cx(
          "flex min-h-10 items-center gap-2 border border-rule bg-surface-2 px-3 py-2 text-sm",
          role === "payer" ? "shadow-[inset_3px_0_0_var(--payer)]" : "shadow-[inset_3px_0_0_var(--worker)]",
        )}
      >
        <RoleMark role={role} />
        {identity ? (
          <span className="min-w-0 truncate">
            <span className="font-medium text-ink">{identity.display_name}</span>{" "}
            <span className="tnum text-[0.75rem] text-ink-2">{identity.email}</span>
          </span>
        ) : (
          <span className="text-ink-3">Not set up: run pnpm db:seed</span>
        )}
      </div>
      <p className="text-xs text-ink-3">Demo account. Proviso has no sign-up; both parties are seeded sandbox identities.</p>
    </div>
  );
}

function RefusalCard({
  vague,
  applied,
  onApply,
  onApplyAll,
  onRedraft,
}: {
  vague: VagueCondition[];
  applied: boolean[];
  onApply: (i: number) => void;
  onApplyAll: () => void;
  onRedraft: () => void;
}) {
  const remaining = applied.filter((a) => !a).length;
  // As with a proposal: focus moves to the refusal's heading when it replaces the Draft button (DEF-21).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-labelledby="refusal-h" className="rise overflow-hidden rounded-lg border border-fail/45 bg-surface">
      <header className="border-b border-fail/30 bg-fail-soft px-5 py-3.5 shadow-[inset_3px_0_0_var(--fail)]">
        <p className="label flex items-center gap-1.5 text-fail">
          <IconX size={13} strokeWidth={2.6} /> Refused by the AI
        </p>
        <h2 ref={heading} tabIndex={-1} id="refusal-h" className="mt-0.5 text-[1.05rem] font-semibold text-ink">
          {vague.length === 1 ? "One condition is too vague to test." : `${vague.length} conditions are too vague to test.`}
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Money only moves when a machine can check every condition. Use the suggested rewrite or say it your own way, then draft again.
        </p>
      </header>
      <ol className="divide-y divide-rule">
        {vague.map((v, i) => (
          <li key={i} className="flex flex-col gap-3 px-5 py-4">
            <div>
              <p className="label">You wrote</p>
              <p className={cx("mt-0.5 text-[0.95rem] font-medium", applied[i] ? "text-ink-3 line-through" : "text-ink")}>“{v.condition}”</p>
              <p className="mt-1 text-sm text-ink-2">
                <span className="font-medium text-fail">Why it can&apos;t be checked: </span>
                {v.reason}
              </p>
            </div>
            <div className="flex flex-col gap-2 border border-rule bg-surface-2 px-3.5 py-3 shadow-[inset_3px_0_0_var(--paid)] sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="label text-paid">{v.suggested_rewrite === null ? "No checkable version" : "Checkable rewrite"}</p>
                <p className="mt-0.5 tnum text-[0.8125rem] leading-snug text-ink">
                  {v.suggested_rewrite ?? "Drop it from the deal, or say it as something a machine can check."}
                </p>
              </div>
              {applied[i] ? (
                <span className="inline-flex shrink-0 items-center gap-1 tnum text-[0.7rem] font-semibold text-paid">
                  <IconCheck size={16} strokeWidth={2.4} /> {v.suggested_rewrite === null ? "Removed" : "In your deal"}
                </span>
              ) : (
                <Button variant="secondary" size="sm" className="shrink-0" onClick={() => onApply(i)}>
                  {v.suggested_rewrite === null ? "Remove from the deal" : "Use suggested rewrite"}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule bg-surface-2 px-5 py-4">
        <p className="text-xs text-ink-3">{remaining > 0 ? "Rewrites change the deal text on the left." : "Your deal now has only checkable conditions."}</p>
        {remaining > 0 ? (
          <Button onClick={onApplyAll}>
            <IconSpark size={16} /> {vague.every((v) => v.suggested_rewrite !== null) ? `Use ${vague.length === 1 ? "the rewrite" : "all rewrites"}` : `Apply ${vague.length === 1 ? "the suggestion" : "all suggestions"}`} and draft again
          </Button>
        ) : (
          <Button onClick={onRedraft}>
            <IconSpark size={16} /> Draft again
          </Button>
        )}
      </footer>
    </section>
  );
}
