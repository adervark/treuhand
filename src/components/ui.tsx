/**
 * Small presentational primitives (docs/design.md, Components). No hooks
 * here, so server and client components can both use them.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ContractState } from "@/lib/types";
import { STATE_META, type Tone } from "./format";
import { IconAlert } from "./icons";

type Canon = "neutral" | "held" | "paid" | "returned" | "fail" | "inconclusive" | "disputed" | "machine" | "payer" | "worker";
const ALIAS: Record<Tone, Canon> = {
  neutral: "neutral",
  held: "held",
  paid: "paid",
  returned: "returned",
  fail: "fail",
  inconclusive: "inconclusive",
  disputed: "disputed",
  machine: "machine",
  payer: "payer",
  worker: "worker",
  info: "machine",
  money: "paid",
  pass: "paid",
  warn: "disputed",
};

function byTone(map: Record<Canon, string>): Record<Tone, string> {
  return Object.fromEntries(Object.entries(ALIAS).map(([t, c]) => [t, map[c]])) as Record<Tone, string>;
}

/** Text in the tone's colour. */
export const TONE_TEXT = byTone({
  neutral: "text-ink-2",
  held: "text-held",
  paid: "text-paid",
  returned: "text-returned",
  fail: "text-fail",
  inconclusive: "text-inconclusive",
  disputed: "text-disputed",
  machine: "text-machine",
  payer: "text-payer",
  worker: "text-worker",
});

/** A solid mark (dot, tick, station) in the tone's colour. */
export const TONE_DOT = byTone({
  neutral: "bg-ink-3",
  held: "bg-held-fill",
  paid: "bg-paid-fill",
  returned: "bg-returned-fill",
  fail: "bg-fail-fill",
  inconclusive: "bg-inconclusive-fill",
  disputed: "bg-disputed-fill",
  machine: "bg-machine-fill",
  payer: "bg-payer-fill",
  worker: "bg-worker-fill",
});

/** A tinted chip: soft ground, toned text, hairline ring. */
export const TONE_CHIP = byTone({
  neutral: "bg-inset text-ink-2 ring-rule-strong",
  held: "bg-held-soft text-held ring-held/35",
  paid: "bg-paid-soft text-paid ring-paid/35",
  returned: "bg-returned-soft text-returned ring-returned/35",
  fail: "bg-fail-soft text-fail ring-fail/40",
  inconclusive: "bg-inconclusive-soft text-inconclusive ring-inconclusive/40",
  disputed: "bg-disputed-soft text-disputed ring-disputed/40",
  machine: "bg-machine-soft text-machine ring-machine/35",
  payer: "bg-payer-soft text-payer ring-payer/35",
  worker: "bg-worker-soft text-worker ring-worker/35",
});

/** A solid tag: filled ground, contrasting text. */
export const TONE_FILL = byTone({
  neutral: "bg-ink-3 text-surface",
  held: "bg-held-fill text-held-on",
  paid: "bg-paid-fill text-paid-on",
  returned: "bg-returned-fill text-returned-on",
  fail: "bg-fail-fill text-fail-on",
  inconclusive: "bg-inconclusive-fill text-inconclusive-on",
  disputed: "bg-disputed-fill text-disputed-on",
  machine: "bg-machine-fill text-machine-on",
  payer: "bg-payer-fill text-payer-on",
  worker: "bg-worker-fill text-worker-on",
});

/** A soft row or band tint. */
export const TONE_SOFT = byTone({
  neutral: "bg-surface-2",
  held: "bg-held-soft",
  paid: "bg-paid-soft",
  returned: "bg-returned-soft",
  fail: "bg-fail-soft",
  inconclusive: "bg-inconclusive-soft",
  disputed: "bg-disputed-soft",
  machine: "bg-machine-soft",
  payer: "bg-payer-soft",
  worker: "bg-worker-soft",
});

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** A small status chip: a dot plus a word, so the tone is never the only cue. */
export function Chip({
  tone = "neutral",
  dot = false,
  pulse = false,
  size = "sm",
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-xs font-semibold whitespace-nowrap ring-1 ring-inset",
        size === "sm" ? "h-5 px-1.5 text-[0.7rem]" : "h-7 px-2.5 text-[0.8rem]",
        TONE_CHIP[tone],
        className,
      )}
    >
      {dot ? <span className={cx("size-1.5 shrink-0 rounded-[1px]", TONE_DOT[tone], pulse && "pulse-dot")} aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StateChip({ state, size = "sm" }: { state: ContractState; size?: "sm" | "md" }) {
  const meta = STATE_META[state];
  return (
    <Chip tone={meta.tone} dot pulse={state === "VERIFYING" || state === "SUBMITTED"} size={size}>
      {meta.label}
    </Chip>
  );
}

/** Rectangular uppercase tag with tabular figures: verdicts, kinds. */
export function Tag({
  tone = "neutral",
  variant = "fill",
  className,
  children,
}: {
  tone?: Tone;
  variant?: "fill" | "outline";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-[1.125rem] items-center justify-center rounded-xs px-1.5 tnum text-[0.66rem] leading-none font-semibold whitespace-nowrap uppercase",
        variant === "fill" ? TONE_FILL[tone] : cx("ring-1 ring-inset ring-current", TONE_TEXT[tone]),
        className,
      )}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "money" | "secondary" | "ghost" | "danger" | "payer" | "worker";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent-fill text-accent-on hover:brightness-110 enabled:active:brightness-90 disabled:opacity-45",
  money: "bg-paid-fill text-paid-on hover:brightness-110 enabled:active:brightness-90 disabled:opacity-45",
  secondary: "bg-surface-2 text-ink ring-1 ring-inset ring-field hover:bg-head enabled:active:bg-inset disabled:text-ink-3",
  ghost: "text-ink-2 hover:bg-inset hover:text-ink enabled:active:bg-surface-2 disabled:text-ink-3",
  danger: "bg-surface text-fail ring-1 ring-inset ring-fail/60 hover:bg-fail-soft enabled:active:brightness-90 disabled:text-ink-3",
  payer: "bg-payer-fill text-payer-on hover:brightness-110 enabled:active:brightness-90 disabled:opacity-45",
  worker: "bg-worker-fill text-worker-on hover:brightness-110 enabled:active:brightness-90 disabled:opacity-45",
};

export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
}) {
  // A busy button keeps its colour (it is working, not unavailable) but ignores clicks, including form submits.
  const { onClick, ...others } = rest;
  return (
    <button
      type="button"
      {...others}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-sm font-semibold transition-[background-color,color,filter] duration-100 disabled:cursor-not-allowed aria-busy:cursor-progress",
        size === "sm" && "h-[1.875rem] px-2.5 text-[0.8125rem]",
        size === "md" && "h-9 px-3.5 text-[0.8125rem]",
        size === "lg" && "h-10 px-5 text-[0.875rem]",
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A panel: the instrument's unit. Flat, square, one rule. */
export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cx("border border-rule bg-surface", className)}>
      {children}
    </section>
  );
}

/** Panel head: a grey bar with the panel's title in capitals, an optional title line, and an aside. */
export function CardHeader({
  eyebrow,
  title,
  aside,
  className,
}: {
  /** Kept for older callers; panels are no longer numbered. */
  index?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex items-center justify-between gap-3 border-b border-rule bg-head px-3 py-1.5", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
        {eyebrow ? <p className="panel-title">{eyebrow}</p> : null}
        {title ? <h2 className="text-[0.8125rem] leading-5 font-semibold text-ink">{title}</h2> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

/** An honest error or notice. `message` should be the API's own words. */
export function Banner({
  tone = "fail",
  title,
  children,
  action,
  className,
}: {
  tone?: "fail" | "warn" | "info" | "pass";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const styles = {
    fail: "border border-rule bg-surface text-fail shadow-[inset_3px_0_0_var(--fail)]",
    warn: "border border-rule bg-surface text-disputed shadow-[inset_3px_0_0_var(--disputed)]",
    info: "border border-rule bg-surface text-machine shadow-[inset_3px_0_0_var(--machine)]",
    pass: "border border-rule bg-surface text-paid shadow-[inset_3px_0_0_var(--paid)]",
  }[tone];
  return (
    <div role={tone === "fail" ? "alert" : "status"} className={cx("flex gap-3 px-4 py-2.5", styles, className)}>
      <IconAlert className="mt-0.5 shrink-0" size={17} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-0.5 break-words text-ink-2">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-fail" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-3" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "w-full rounded-sm border border-field bg-inset px-2.5 py-1.5 text-[0.8125rem] text-ink placeholder:text-ink-3 " +
  "transition-colors duration-100 hover:border-ink-3 focus:border-accent focus:outline-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus " +
  "aria-[invalid=true]:border-fail disabled:opacity-60";

export const monoInputClass = inputClass + " font-code text-[0.78rem]";
