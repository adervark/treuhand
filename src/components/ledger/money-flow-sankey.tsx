"use client";

/**
 * Where all the money went: the contract page's five places summed over every
 * contract, drawn as a Sankey (docs/design.md, "The money flow"). Band widths
 * are amounts. Each flow is one ledger kind, so choosing a flow filters the
 * ledger grid to exactly those movements. AG Charts' Sankey series is an
 * Enterprise feature, so this is drawn in SVG; the list beside it is the
 * keyboard and screen-reader control and carries every figure in words.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LedgerKind } from "@/lib/types";
import type { LedgerRow } from "../api";
import { sumLedger } from "../contract/money";
import { formatCents } from "../format";
import { cx } from "../ui";
import { useMinWidth } from "../use-min-width";

export const FLOW_KINDS: { kind: LedgerKind; label: string; tone: FlowTone; route: string }[] = [
  { kind: "AUTHORIZED", label: "Into PayPal holds", tone: "held", route: "Payers → hold" },
  { kind: "CAPTURED", label: "Captured", tone: "held", route: "Hold → Treuhand" },
  { kind: "PAID_OUT", label: "Paid to workers", tone: "paid", route: "Treuhand → workers" },
  { kind: "VOIDED", label: "Holds released", tone: "returned", route: "Hold → payers" },
  { kind: "REFUNDED", label: "Refunded", tone: "returned", route: "Treuhand → payers" },
];

type FlowTone = "held" | "paid" | "returned";
const SWATCH: Record<FlowTone, string> = { held: "bg-held-fill", paid: "bg-paid-fill", returned: "bg-returned-fill" };
const FILL: Record<FlowTone | "neutral", string> = { held: "var(--held-fill)", paid: "var(--paid-fill)", returned: "var(--returned-fill)", neutral: "var(--ink-3)" };

interface Totals {
  currency: string;
  flows: Record<LedgerKind, number>;
  counts: Record<LedgerKind, number>;
  /** Still reserved in PayPal holds. */
  inHolds: number;
  /** Captured by Clause, not yet paid out or refunded. */
  inCapture: number;
}

/** Sums each path over every contract in the main currency; what is still held is what entered a place and has not left it. */
function flowTotals(entries: LedgerRow[]): Totals {
  const byCurrency = new Map<string, number>();
  for (const e of entries) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + 1);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  const rows = entries.filter((e) => e.currency === currency);
  const flows: Record<LedgerKind, number> = { AUTHORIZED: 0, CAPTURED: 0, PAID_OUT: 0, VOIDED: 0, REFUNDED: 0 };
  const counts: Record<LedgerKind, number> = { AUTHORIZED: 0, CAPTURED: 0, PAID_OUT: 0, VOIDED: 0, REFUNDED: 0 };
  const byContract = new Map<string, LedgerRow[]>();
  for (const e of rows) {
    counts[e.kind]++;
    byContract.set(e.contract_id, [...(byContract.get(e.contract_id) ?? []), e]);
  }
  let inHolds = 0;
  let inCapture = 0;
  for (const list of byContract.values()) {
    const t = sumLedger(list);
    // A capture or release with no recorded hold still came through one.
    const into = Math.max(t.AUTHORIZED, t.CAPTURED + t.VOIDED);
    flows.AUTHORIZED += into;
    flows.CAPTURED += t.CAPTURED;
    flows.VOIDED += t.VOIDED;
    flows.PAID_OUT += t.PAID_OUT;
    flows.REFUNDED += t.REFUNDED;
    inHolds += Math.max(0, into - t.CAPTURED - t.VOIDED);
    inCapture += Math.max(0, t.CAPTURED - t.PAID_OUT - t.REFUNDED);
  }
  return { currency, flows, counts, inHolds, inCapture };
}

/** Drawing height; from 4xl (2400 px), where the flow has a column of its own, it is drawn taller. */
const H = 250;
const H_WIDE = 340;
const TOP = 58;
const BOTTOM = 6;
const BAR = 10;
const RIGHT_LABELS = 136;

interface Band {
  kind: LedgerKind;
  tone: FlowTone;
  d: string;
}

function ribbon(xa: number, a0: number, a1: number, xb: number, b0: number, b1: number): string {
  const m = (xa + xb) / 2;
  return `M ${xa} ${a0} C ${m} ${a0} ${m} ${b0} ${xb} ${b0} L ${xb} ${b1} C ${m} ${b1} ${m} ${a1} ${xa} ${a1} Z`;
}

function layout(t: Totals, width: number, H: number) {
  const f = t.flows;
  const into = f.AUTHORIZED;
  const k = into > 0 ? (H - TOP - BOTTOM - 16) / into : 0;
  const h = (c: number) => (c > 0 ? Math.max(2, c * k) : 0);
  const x3 = width - RIGHT_LABELS - BAR;
  const x0 = 0;
  const x1 = Math.round(x3 * 0.24);
  const x2 = Math.round(x3 * 0.6);
  const y = TOP;

  const payers = { x: x0, y, h: h(into) };
  const hold = { x: x1, y, h: h(into) };
  const capture = { x: x2, y, h: h(f.CAPTURED) };
  const workers = { x: x3, y, h: h(f.PAID_OUT) };
  const back = { x: x3, h: h(f.VOIDED + f.REFUNDED), y: 0 };
  back.y = H - BOTTOM - back.h;

  // Out of the hold, top to bottom: captured, still held, released. Out of the capture: paid, awaiting, refunded.
  const capTop = hold.y;
  const capBot = capTop + h(f.CAPTURED);
  const relBot = hold.y + hold.h;
  const relTop = relBot - h(f.VOIDED);
  const paidBot = capture.y + h(f.PAID_OUT);
  const refBot = capture.y + capture.h;
  const refTop = refBot - h(f.REFUNDED);
  const backRefBot = back.y + h(f.REFUNDED);

  const bands: Band[] = [];
  if (into > 0) bands.push({ kind: "AUTHORIZED", tone: "held", d: ribbon(x0 + BAR, payers.y, payers.y + payers.h, x1, hold.y, hold.y + hold.h) });
  if (f.CAPTURED > 0) bands.push({ kind: "CAPTURED", tone: "held", d: ribbon(x1 + BAR, capTop, capBot, x2, capture.y, capture.y + capture.h) });
  if (f.PAID_OUT > 0) bands.push({ kind: "PAID_OUT", tone: "paid", d: ribbon(x2 + BAR, capture.y, paidBot, x3, workers.y, workers.y + workers.h) });
  if (f.REFUNDED > 0) bands.push({ kind: "REFUNDED", tone: "returned", d: ribbon(x2 + BAR, refTop, refBot, x3, back.y, backRefBot) });
  if (f.VOIDED > 0) bands.push({ kind: "VOIDED", tone: "returned", d: ribbon(x1 + BAR, relTop, relBot, x3, backRefBot, back.y + back.h) });

  // What is still held does not flow on: a short fading stub out of the place that holds it.
  const stubs: { d: string; y: number; cents: number; x: number; id: string }[] = [];
  const stub = (x: number, top: number, cents: number, id: string) => {
    const hh = h(cents);
    const len = Math.min(56, (x2 - x1) * 0.32);
    stubs.push({ d: `M ${x + BAR} ${top} H ${x + BAR + len} V ${top + hh} H ${x + BAR} Z`, y: top + hh / 2, cents, x: x + BAR + len + 6, id });
  };
  if (t.inHolds > 0) stub(x1, capBot, t.inHolds, "stub-hold");
  if (t.inCapture > 0) stub(x2, paidBot, t.inCapture, "stub-capture");

  return { payers, hold, capture, workers, back, bands, stubs, x: [x0, x1, x2, x3] };
}

export function MoneyFlowSankey({
  entries,
  selected,
  onSelect,
}: {
  entries: LedgerRow[];
  /** The one ledger kind the grid is filtered to, if any. */
  selected: LedgerKind | null;
  onSelect: (kind: LedgerKind) => void;
}) {
  const totals = useMemo(() => flowTotals(entries), [entries]);
  const [hover, setHover] = useState<LedgerKind | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fmt = (c: number) => formatCents(c, totals.currency);
  const tall = useMinWidth("150rem");
  const height = tall ? H_WIDE : H;
  const geo = width > 360 ? layout(totals, width, height) : null;
  const lit = hover ?? selected;
  const opacity = (kind: LedgerKind) => (lit === null ? 0.3 : lit === kind ? 0.6 : 0.09);
  const empty = totals.flows.AUTHORIZED === 0;

  return (
    <section aria-labelledby="flow-h" className="overflow-hidden border border-rule bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule bg-head px-3 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 id="flow-h" className="panel-title">
            Money flow <span className="font-normal tracking-normal text-ink-2 normal-case">· every contract · {totals.currency}</span>
          </h2>
        </div>
        <p className="text-[0.72rem] text-ink-2">Choose a flow to filter the ledger</p>
      </header>
      <div className="grid gap-x-5 gap-y-3 px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_18.5rem]">
        <div ref={host} className="relative hidden lg:block" style={{ height }}>
          {empty ? (
            <p className="grid h-full place-items-center tnum text-[0.72rem] text-ink-3">No money has moved yet.</p>
          ) : geo ? (
            <>
              <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
                <defs>
                  {geo.stubs.map((s) => (
                    <linearGradient key={s.id} id={s.id} x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="var(--held-fill)" stopOpacity="0.5" />
                      <stop offset="1" stopColor="var(--held-fill)" stopOpacity="0" />
                    </linearGradient>
                  ))}
                </defs>
                {geo.stubs.map((s) => (
                  <path key={s.id} d={s.d} fill={`url(#${s.id})`} />
                ))}
                {geo.bands.map((b) => (
                  <path
                    key={b.kind}
                    d={b.d}
                    fill={FILL[b.tone]}
                    fillOpacity={opacity(b.kind)}
                    stroke={lit === b.kind ? FILL[b.tone] : "none"}
                    strokeWidth={1}
                    className="cursor-pointer transition-[fill-opacity] duration-150"
                    onClick={() => onSelect(b.kind)}
                    onPointerEnter={() => setHover(b.kind)}
                    onPointerLeave={() => setHover(null)}
                  >
                    <title>{`${FLOW_KINDS.find((f) => f.kind === b.kind)?.label}: ${fmt(totals.flows[b.kind])}`}</title>
                  </path>
                ))}
                {[
                  { ...geo.payers, fill: FILL.neutral },
                  { ...geo.hold, fill: FILL.held },
                  { ...geo.capture, fill: FILL.held },
                  { ...geo.workers, fill: FILL.paid },
                  { ...geo.back, fill: FILL.returned },
                ].map((n, i) => (n.h > 0 ? <rect key={i} x={n.x} y={n.y} width={BAR} height={n.h} rx={1.5} fill={n.fill} /> : null))}
              </svg>
              <ColumnHead x={geo.x[0]} title="Payers" value={fmt(totals.flows.AUTHORIZED)} note="put into holds" />
              <ColumnHead x={geo.x[1]} title="PayPal holds" value={fmt(totals.flows.AUTHORIZED)} note={totals.inHolds > 0 ? `${fmt(totals.inHolds)} still held` : "all moved on"} tone="text-held" />
              <ColumnHead x={geo.x[2]} title="Captured by Treuhand" value={fmt(totals.flows.CAPTURED)} note={totals.inCapture > 0 ? `${fmt(totals.inCapture)} paying out` : "all moved on"} tone="text-held" />
              <TerminalLabel x={geo.x[3] + BAR + 8} y={geo.workers.y} h={Math.max(geo.workers.h, 30)} title="Paid to workers" value={fmt(totals.flows.PAID_OUT)} tone="text-paid" />
              <TerminalLabel
                x={geo.x[3] + BAR + 8}
                y={geo.back.y + geo.back.h - Math.max(geo.back.h, 56)}
                h={Math.max(geo.back.h, 56)}
                title="Back to payers"
                value={fmt(totals.flows.VOIDED + totals.flows.REFUNDED)}
                tone="text-returned"
                note={
                  <>
                    {fmt(totals.flows.VOIDED)} released
                    <br />
                    {fmt(totals.flows.REFUNDED)} refunded
                  </>
                }
              />
              {geo.stubs.map((s) => (
                <span key={s.id} className="pointer-events-none absolute -translate-y-1/2 text-[0.7rem] whitespace-nowrap text-held" style={{ left: s.x, top: s.y }}>
                  still held
                </span>
              ))}
            </>
          ) : null}
        </div>

        <ul className="flex flex-col gap-1" aria-label="Flows: choose one to filter the ledger">
          {FLOW_KINDS.map((f) => {
            const cents = totals.flows[f.kind];
            const on = selected === f.kind;
            const share = totals.flows.AUTHORIZED > 0 ? cents / totals.flows.AUTHORIZED : 0;
            return (
              <li key={f.kind}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={cents === 0 && !on}
                  onClick={() => onSelect(f.kind)}
                  onPointerEnter={() => setHover(f.kind)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(f.kind)}
                  onBlur={() => setHover(null)}
                  className={cx(
                    "group grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0 px-2 py-1 text-left transition-colors duration-100",
                    on ? "bg-accent-soft shadow-[inset_3px_0_0_var(--accent-fill)]" : "hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent",
                  )}
                >
                  <span className={cx("row-span-2 size-2.5 self-start mt-[5px] rounded-[1px]", SWATCH[f.tone])} aria-hidden />
                  <span className="truncate text-[0.8rem] leading-5 font-semibold text-ink">{f.label}</span>
                  <span className={cx("tnum text-[0.84rem] leading-5 font-semibold whitespace-nowrap", cents === 0 ? "text-ink-3" : "text-ink")}>{fmt(cents)}</span>
                  <span className="col-span-2 col-start-2 tnum text-[0.7rem] leading-4 whitespace-nowrap text-ink-3">
                    {f.route} · {totals.counts[f.kind]} movement{totals.counts[f.kind] === 1 ? "" : "s"}
                  </span>
                  <span className="col-span-2 col-start-2 mt-0.5 block h-[3px] rounded-[1px] bg-inset lg:hidden" aria-hidden>
                    <span className={cx("block h-full rounded-[1px]", SWATCH[f.tone])} style={{ width: `${Math.max(share * 100, cents > 0 ? 2 : 0)}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
          <li className="mt-1 flex items-center justify-between gap-2 border-t border-rule px-2 pt-2 text-[0.75rem] text-ink-3">
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-[1px] bg-gradient-to-r from-held-fill/60 to-transparent" aria-hidden />
              Still held now
            </span>
            <span className="tnum text-[0.84rem] font-semibold text-ink">{fmt(totals.inHolds + totals.inCapture)}</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

/** A column's name, amount and note stacked, so the heads fit the column spacing down to 1024 px. */
function ColumnHead({ x, title, value, note, tone = "text-ink" }: { x: number; title: string; value: string; note: string; tone?: string }) {
  return (
    <div className="pointer-events-none absolute top-0 flex flex-col" style={{ left: x }}>
      <span className={cx("text-[0.7rem] leading-4 font-semibold whitespace-nowrap", tone)}>{title}</span>
      <span className="tnum text-[0.875rem] leading-5 font-semibold whitespace-nowrap text-ink">{value}</span>
      <span className="tnum text-[0.7rem] leading-4 whitespace-nowrap text-ink-3">{note}</span>
    </div>
  );
}

function TerminalLabel({ x, y, h, title, value, tone, note }: { x: number; y: number; h: number; title: string; value: string; tone: string; note?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute flex flex-col justify-center" style={{ left: x, top: y, height: h }}>
      <span className={cx("text-[0.7rem] leading-4 font-semibold whitespace-nowrap", tone)}>{title}</span>
      <span className="tnum text-[0.95rem] leading-5 font-semibold whitespace-nowrap text-ink">{value}</span>
      {note ? <span className="tnum text-[0.7rem] leading-4 whitespace-nowrap text-ink-3">{note}</span> : null}
    </div>
  );
}
