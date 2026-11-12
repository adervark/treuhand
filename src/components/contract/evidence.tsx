"use client";

/**
 * What the verifier saw for one condition, shown as it was recorded:
 * screenshots, raw responses, and any other facts it stored.
 */
import { useRef, useState } from "react";
import type { VerdictEvidence } from "@/lib/types";
import { humanize } from "../format";
import { IconExternal, IconImage, IconShield, IconX } from "../icons";
import { cx } from "../ui";

/** Keys the checklist already shows elsewhere (the review panel draws `panel`), or that only mark the outcome. */
// `trace` is the signed copy of the check's steps; the work log (work-log.tsx) is its presentation.
const HIDDEN_KEYS = new Set(["screenshots", "responses", "inconclusive", "outcome", "manipulation", "panel", "trace"]);

/**
 * A screenshot reference the browser can load. The verifier stores paths
 * relative to the project root (`data/evidence/<submissionId>/<file>`), which
 * the API serves at `/api/evidence/<submissionId>/<file>`; app paths, URLs and
 * data URIs are used as they are.
 */
export function screenshotSrc(ref: string): string | null {
  const stored = /^(?:\.\/)?data\/evidence\/([^/]+)\/([^/]+)$/.exec(ref);
  if (stored) return `/api/evidence/${encodeURIComponent(stored[1])}/${encodeURIComponent(stored[2])}`;
  if (ref.startsWith("/") || /^https?:\/\//.test(ref) || ref.startsWith("data:image/")) return ref;
  return null;
}

export function evidenceScreenshots(evidence: VerdictEvidence): string[] {
  return Array.isArray(evidence.screenshots) ? evidence.screenshots.filter((s): s is string => typeof s === "string") : [];
}

export interface ManipulationRecord {
  quotes: string[];
  signals: { signal: string; where: string; snippet: string }[];
  modelReported: boolean;
}

/**
 * The verifier's record of text on the page that tried to steer the verdict
 * (`evidence.manipulation`, written by the AI judgement check). Null when none.
 */
export function manipulationOf(evidence: VerdictEvidence): ManipulationRecord | null {
  const m = (evidence as Record<string, unknown>).manipulation;
  if (!m || typeof m !== "object") return null;
  const rec = m as Record<string, unknown>;
  if (rec.detected !== true) return null;
  const quotes = Array.isArray(rec.model_quotes) ? rec.model_quotes.filter((q): q is string => typeof q === "string" && q.length > 0) : [];
  const signals = Array.isArray(rec.scanner_signals)
    ? rec.scanner_signals
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s) => ({ signal: String(s.signal ?? ""), where: String(s.where ?? ""), snippet: String(s.snippet ?? "") }))
    : [];
  return { quotes, signals, modelReported: rec.model_reported === true };
}

/**
 * The alarm band: shown on the verdict itself, never folded away. The page
 * tried to talk the verifier into a result; this is the loudest thing Clause draws.
 */
export function ManipulationNotice({ record, outcome }: { record: ManipulationRecord; outcome?: string }) {
  const quoted = new Set<string>();
  const lines: { text: string; where: string | null }[] = [];
  for (const s of record.signals) {
    if (!s.snippet || quoted.has(s.snippet)) continue;
    quoted.add(s.snippet);
    lines.push({ text: s.snippet, where: s.where || null });
  }
  for (const q of record.quotes) {
    if (quoted.has(q) || [...quoted].some((s) => s.includes(q) || q.includes(s))) continue;
    quoted.add(q);
    lines.push({ text: q, where: null });
  }
  const shown = lines.slice(0, 3);
  return (
    <div className="overflow-hidden border border-alarm-fill bg-alarm-soft" role="note" aria-label="Manipulation attempt detected">
      <p className="hazard flex items-center gap-2 px-3 py-1.5 text-[0.78rem] font-semibold text-alarm-on">
        <span className="flex items-center gap-2">
          <IconShield size={15} strokeWidth={2.2} />
          Manipulation attempt detected
        </span>
        <span className="ml-auto font-medium max-sm:hidden">Recorded · ignored</span>
      </p>
      <div className="flex flex-col gap-2.5 px-3 py-3">
        <p className="text-[0.8125rem] leading-snug text-ink">
          The delivered page contains text aimed at the verifier. {record.modelReported ? "The AI flagged it" : "Treuhand's scanner flagged it"}, and
          the page was judged as if the text were not there.
          {outcome === "pass" ? <span className="font-semibold"> The test still passed: what a visitor sees meets it.</span> : null}
        </p>
        {shown.map((l, i) => (
          <blockquote key={i} className="border-l-[3px] border-alarm-fill bg-surface/60 py-1.5 pr-2 pl-3">
            <p className="font-code text-[0.78rem] leading-relaxed break-words text-alarm">&ldquo;{clip(l.text, 220)}&rdquo;</p>
            {l.where ? <p className="mt-0.5 tnum text-[0.68rem] text-ink-3">found in {l.where}</p> : null}
          </blockquote>
        ))}
        {lines.length > shown.length ? <p className="text-[0.7rem] text-ink-3">and {lines.length - shown.length} more in the evidence record</p> : null}
      </div>
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The full evidence record. `skipShots` leaves out screenshots already shown beside the verdict. */
export function Evidence({ evidence, label, skipShots = 0 }: { evidence: VerdictEvidence; label: string; skipShots?: number }) {
  const allShots = evidenceScreenshots(evidence);
  const shots = allShots.slice(skipShots);
  const responses = Array.isArray(evidence.responses) ? evidence.responses : [];
  const all = Object.entries(evidence).filter(
    ([k, v]) => !HIDDEN_KEYS.has(k) && v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  // What was found comes first; how the run went (timings, retries, sizes) folds away.
  const facts = all.filter(([k]) => !TECHNICAL_KEYS.has(k));
  const technical = all.filter(([k]) => TECHNICAL_KEYS.has(k));

  if (allShots.length === 0 && responses.length === 0 && all.length === 0) {
    return <p className="text-[0.8rem] text-ink-3">The verifier stored no evidence for this check.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {shots.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {shots.map((ref, i) => (
            <Screenshot key={`${ref}-${i}`} refPath={ref} alt={`${label}: screenshot ${i + 1 + skipShots} of ${allShots.length}`} />
          ))}
        </div>
      ) : null}

      {facts.length > 0 ? <Facts entries={facts} /> : null}

      {technical.length > 0 ? (
        <details className="group">
          <summary className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-ink-3 hover:text-ink">
            <span className="chev inline-block transition-transform" aria-hidden>
              ›
            </span>
            Run details ({technical.length})
          </summary>
          <div className="mt-1.5">
            <Facts entries={technical} />
          </div>
        </details>
      ) : null}

      {responses.map((r, i) => (
        <details key={i} className="group rounded-sm bg-inset ring-1 ring-rule ring-inset">
          <summary className="flex items-center justify-between gap-2 px-3 py-1.5 text-[0.75rem] font-semibold text-ink-2">
            <span>
              Raw response {responses.length > 1 ? `${i + 1} of ${responses.length}` : ""}
              <span className="ml-2 tnum font-normal text-ink-3">{responseHint(r)}</span>
            </span>
            <span className="chev text-ink-3 transition-transform" aria-hidden>
              ›
            </span>
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-rule px-3 py-2 tnum text-[0.7rem] leading-relaxed whitespace-pre-wrap text-ink-2">
            {stringify(r)}
          </pre>
        </details>
      ))}
    </div>
  );
}

/** How the run went rather than what it found. */
const TECHNICAL_KEYS = new Set([
  "check_kind",
  "timings",
  "timings_detail",
  "duration_ms",
  "elapsed_ms",
  "load_ms",
  "load_attempts",
  "attempts",
  "url",
  "model",
  "model_attempts",
  "model_verdict",
  "visible_text_chars",
  "page_text_chars",
  "screenshot_tiles_sent",
  "page_height_px",
  "hidden_text_count",
  "hidden_text_withheld",
  "criterion",
]);

function Facts({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.78rem]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{humanize(k)}</dt>
          <dd className="min-w-0 break-words text-ink-2">
            <FactValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FactValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) {
      return (
        <a href={value} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 tnum text-[0.74rem] break-all text-machine underline-offset-2 hover:underline">
          {value}
          <IconExternal size={12} />
        </a>
      );
    }
    return <span className="whitespace-pre-wrap">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") return <span className="tnum text-[0.74rem] text-ink">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) {
      const long = value.some((v) => String(v).length > 40);
      if (!long) return <span>{value.map(String).join(", ")}</span>;
      return (
        <ul className="flex flex-col gap-0.5">
          {value.slice(0, 12).map((v, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-ink-3" aria-hidden>
                ·
              </span>
              <span>{String(v)}</span>
            </li>
          ))}
          {value.length > 12 ? <li className="text-ink-3">and {value.length - 12} more</li> : null}
        </ul>
      );
    }
    return (
      <ul className="flex flex-col gap-0.5">
        {value.slice(0, 6).map((v, i) => (
          <li key={i}>{isFlatObject(v) ? <Pairs obj={v} /> : <code className="tnum text-[0.72rem] break-all">{truncate(JSON.stringify(v), 300)}</code>}</li>
        ))}
        {value.length > 6 ? <li className="text-ink-3">and {value.length - 6} more</li> : null}
      </ul>
    );
  }
  if (isErrorLike(value)) {
    return (
      <span>
        <span className="tnum text-[0.74rem] text-ink">{value.name}</span>: {value.message}
      </span>
    );
  }
  if (isFlatObject(value)) return <Pairs obj={value} />;
  return <code className="tnum text-[0.72rem] break-all">{truncate(JSON.stringify(value), 400)}</code>;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isFlatObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || isPrimitive(x));
}

function isErrorLike(v: unknown): v is { name: string; message: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.message === "string" && typeof o.name === "string";
}

/** `{ load_ms: 1200, model_ms: 900 }` as "Load ms 1200 · Model ms 900". */
function Pairs({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== "");
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.map(([k, v]) => (
        <span key={k}>
          <span className="text-ink-3">{humanize(k)}</span> <span className="tnum text-[0.74rem]">{truncate(String(v), 160)}</span>
        </span>
      ))}
    </span>
  );
}

function responseHint(r: unknown): string {
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    const status = o.status ?? o.statusCode ?? o.state;
    const url = o.url ?? o.html_url;
    return [status, url].filter((x) => typeof x === "string" || typeof x === "number").join(" · ");
  }
  return "";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return truncate(v, 6000);
  try {
    return truncate(JSON.stringify(v, null, 2), 6000);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

/** A screenshot the verifier took, opening full size in a dialog. `compact` is the run log's thumbnail. */
export function Screenshot({ refPath, alt, compact = false }: { refPath: string; alt: string; compact?: boolean }) {
  const src = screenshotSrc(refPath);
  const dialog = useRef<HTMLDialogElement>(null);
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return (
      <div
        className={cx(
          "flex flex-col items-center justify-center gap-1 rounded-sm bg-inset px-3 py-4 text-center ring-1 ring-rule ring-inset",
          compact ? "h-24 w-36" : "w-44",
        )}
      >
        <IconImage className="text-ink-3" />
        <p className="text-[0.68rem] text-ink-3">{broken ? "Screenshot could not be loaded" : "Screenshot stored on the server"}</p>
        {compact ? null : (
          <code className="max-w-full truncate tnum text-[0.65rem] text-ink-3" title={refPath}>
            {refPath}
          </code>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="group relative block overflow-hidden rounded-sm bg-inset ring-1 ring-rule-strong transition-shadow duration-100 hover:ring-ink-3"
        aria-label={`Open ${alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- evidence is served by the API at request time */}
        <img
          src={src}
          alt={alt}
          onError={() => setBroken(true)}
          className={cx(
            "block w-auto object-cover object-top",
            compact ? "h-24 max-w-[9.5rem] min-w-16" : "h-36 max-w-[16rem] sm:h-44 sm:max-w-[20rem]",
          )}
        />
        <span className="absolute inset-x-0 bottom-0 bg-black/75 px-1.5 py-0.5 text-left text-[0.65rem] font-semibold text-white group-hover:bg-black/85">
          {compact ? "Evidence" : "View full size"}
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-label={alt}
        className="m-auto max-h-[92vh] max-w-[min(96vw,1200px)] overflow-hidden rounded-lg bg-surface p-0 text-ink shadow-2xl ring-1 ring-rule-strong"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
          <p className="truncate text-sm font-semibold text-ink">{alt}</p>
          <div className="flex items-center gap-1">
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-sm text-ink-2 hover:bg-inset"
            >
              <IconExternal size={15} /> Open
            </a>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="grid size-8 place-items-center rounded-sm text-ink-2 hover:bg-inset"
              aria-label="Close screenshot"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
        <div className="max-h-[calc(92vh-3rem)] overflow-auto bg-inset">
          {/* eslint-disable-next-line @next/next/no-img-element -- evidence is served by the API at request time */}
          <img src={src} alt={alt} className="block h-auto w-full" />
        </div>
      </dialog>
    </>
  );
}
