"use client";

/**
 * The receipt: what the verifier signed about this contract. The terms
 * fingerprint fixed when both parties signed; for the latest verification run,
 * its outcome, when it was issued, by which verifier and model, the receipt's
 * hash and the key that signed it (compared with the verifier's published
 * key); and the command that checks all of it independently. Data comes from
 * `GET /api/contracts/[id]` (`terms_sha256`, `receipt`) and
 * `GET /api/verifier/public-key` (docs/api.md, "Verification receipts").
 *
 * A receipt is a record, never a gate: nothing here moves money.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ContractBundle } from "../api";
import { api } from "../api";
import type { SignedReceipt, VerifierPublicKey } from "@/lib/contract/service";
import { IconCheck, IconExternal, IconQuestion, IconX } from "../icons";
import { LocalTime, RelativeTime, useHydrated } from "../time";
import { Card, CardHeader, cx, Tag } from "../ui";

/** `9f2c41ab…e01d`: a SHA-256 hex digest short enough to read, long enough to compare. */
export function shortHash(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}

/** verdict id -> the evidence hash the latest receipt signed for it. */
export function evidenceHashes(receipt: SignedReceipt | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const verdicts = receipt?.receipt?.verdicts;
  if (!Array.isArray(verdicts)) return map;
  for (const v of verdicts) {
    if (v && typeof v.verdict_id === "string" && typeof v.evidence_sha256 === "string") map.set(v.verdict_id, v.evidence_sha256);
  }
  return map;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A short hash that copies the whole value; says so for a moment after. */
export function CopyHash({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <span className={cx("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      <button
        type="button"
        onClick={async () => setState((await copyText(value)) ? "copied" : "failed")}
        title={`${value}\nClick to copy`}
        aria-label={`Copy ${label}: ${value}`}
        className="rounded-xs font-code text-[0.72rem] text-ink-2 underline decoration-rule-strong decoration-dotted underline-offset-[3px] hover:text-ink hover:decoration-ink-3"
      >
        {shortHash(value)}
      </button>
      <span role="status" className="text-[0.66rem] text-ink-3">
        {state === "copied" ? "copied" : state === "failed" ? "copy failed: select it from the JSON" : ""}
      </span>
    </span>
  );
}

const OUTCOME: Record<string, { word: string; tone: "paid" | "fail" | "inconclusive"; glyph: ReactNode }> = {
  passed: { word: "Passed", tone: "paid", glyph: <IconCheck size={11} strokeWidth={3.2} /> },
  failed: { word: "Failed", tone: "fail", glyph: <IconX size={10} strokeWidth={3.2} /> },
  inconclusive: { word: "Inconclusive", tone: "inconclusive", glyph: <IconQuestion size={11} strokeWidth={2.8} /> },
};

/** The verifier's published key, fetched once per page. Null until it answers or if it cannot. */
function usePublicKey(): VerifierPublicKey | null {
  const [key, setKey] = useState<VerifierPublicKey | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api<VerifierPublicKey>("/api/verifier/public-key", { signal: ctrl.signal })
      .then(setKey)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  return key;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="pt-px text-[0.75rem] text-ink-3">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.78rem] text-ink-2">{children}</dd>
    </div>
  );
}

export function ReceiptPanel({ bundle, className }: { bundle: ContractBundle; className?: string }) {
  const { contract } = bundle;
  const signed = bundle.receipt ?? null;
  const body = signed?.receipt;
  const key = usePublicKey();
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin : "<origin>";
  const [cmdCopied, setCmdCopied] = useState(false);
  useEffect(() => {
    if (!cmdCopied) return;
    const t = setTimeout(() => setCmdCopied(false), 1600);
    return () => clearTimeout(t);
  }, [cmdCopied]);

  const receiptsPath = `/api/contracts/${contract.id}/receipts`;
  const command = `pnpm exec tsx scripts/verify-receipt.ts ${origin}${receiptsPath} --app ${origin}`;
  const outcome = body ? OUTCOME[body.outcome] : undefined;
  const attempt = body ? bundle.submissions.length - bundle.submissions.findIndex((s) => s.id === body.submission_id) : 0;
  const verdictCount = Array.isArray(body?.verdicts) ? body.verdicts.length : 0;
  const fingerprint = signed?.signature?.key_fingerprint;
  const matches = key && fingerprint ? key.fingerprint === fingerprint : null;

  return (
    <Card id="receipt" className={cx("flex min-w-0 flex-col overflow-hidden", className)}>
      <CardHeader eyebrow="Receipt" aside={<span className="text-[0.72rem] text-ink-2">signed by the verifier · Ed25519</span>} />
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 pt-2.5 pb-3">
        <Row label="Terms">
          {bundle.terms_sha256 ? (
            <>
              <CopyHash value={bundle.terms_sha256} label="terms fingerprint" />
              <span className="text-[0.72rem] text-ink-3">fingerprint fixed when both signed</span>
            </>
          ) : (
            <span className="text-ink-3">Fingerprinted when both parties sign.</span>
          )}
        </Row>
        {body ? (
          <>
            <Row label="Run">
              {outcome ? (
                <Tag tone={outcome.tone} className="gap-1 self-center px-1.5">
                  {outcome.glyph}
                  {outcome.word}
                </Tag>
              ) : (
                <span className="text-ink">{String(body.outcome)}</span>
              )}
              <span className="tnum text-[0.75rem]">
                {attempt > 0 && bundle.submissions.length > 1 ? `attempt ${attempt} · ` : ""}
                {verdictCount} {verdictCount === 1 ? "verdict" : "verdicts"}
              </span>
            </Row>
            {typeof body.issued_at === "string" ? (
              <Row label="Issued">
                <LocalTime iso={body.issued_at} className="tnum text-ink" />
                <RelativeTime iso={body.issued_at} className="tnum text-[0.72rem] text-ink-3" />
              </Row>
            ) : null}
            {body.verifier ? (
              <Row label="Verifier">
                <span className="text-ink">
                  {body.verifier.name} {body.verifier.version}
                </span>
                {body.verifier.model ? <span className="font-code text-[0.7rem] break-all text-ink-2">{body.verifier.model}</span> : null}
              </Row>
            ) : null}
            {signed?.receipt_sha256 ? (
              <Row label="Receipt">
                <CopyHash value={signed.receipt_sha256} label="receipt hash" />
              </Row>
            ) : null}
            {fingerprint ? (
              <Row label="Signed by">
                <CopyHash value={fingerprint} label="signing key fingerprint" />
                {matches === true ? (
                  <span className="inline-flex items-center gap-1 text-[0.72rem] text-ink">
                    <IconCheck size={12} strokeWidth={2.8} className="shrink-0" /> this verifier&apos;s key
                  </span>
                ) : matches === false ? (
                  <span className="text-[0.72rem] font-semibold text-disputed">not this verifier&apos;s current key</span>
                ) : null}
              </Row>
            ) : null}
          </>
        ) : (
          <Row label="Run">
            <span className="text-ink-3">
              {bundle.submissions.length > 0 ? "The verifier signs a receipt when the run finishes." : "The verifier signs a receipt for every run it finishes."}
            </span>
          </Row>
        )}
      </dl>

      {body ? (
        <div className="flex flex-col gap-1.5 border-t border-rule px-3 pt-2.5 pb-3">
          <div className="flex items-center justify-between gap-2">
            <p className="label">Check it yourself</p>
            <button
              type="button"
              onClick={async () => setCmdCopied(await copyText(command))}
              className="rounded-xs text-[0.72rem] font-semibold text-accent hover:underline"
              aria-label="Copy the command that checks this receipt"
            >
              {cmdCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="block bg-inset px-2 py-1.5 text-[0.68rem] leading-[1.05rem] break-all text-ink-2 ring-1 ring-rule ring-inset">{command}</code>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem]">
            <a href={receiptsPath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Every receipt <span className="text-ink-3">JSON</span> <IconExternal size={11} />
            </a>
            <a href="/api/verifier/public-key" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Verifier public key <span className="text-ink-3">JSON</span> <IconExternal size={11} />
            </a>
          </p>
        </div>
      ) : null}
    </Card>
  );
}
