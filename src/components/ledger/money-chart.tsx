"use client";

/**
 * Money over time, from the same ledger rows the grid shows: how much PayPal
 * holds at each moment, and the running totals paid to workers and returned to
 * payers. AG Charts (community) draws to a canvas, so the design tokens are
 * resolved to concrete colours and re-read when the theme changes.
 */
import {
  AreaSeriesModule,
  CartesianChartModule,
  LineSeriesModule,
  NumberAxisModule,
  TimeAxisModule,
  type AgCartesianChartOptions,
} from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useCallback, useMemo, useState } from "react";
import type { LedgerRow } from "../api";
import { heldFrom, sumLedger } from "../contract/money";
import { formatCents } from "../format";
import { useResolvedTheme } from "../theme";

const MODULES = [CartesianChartModule, AreaSeriesModule, LineSeriesModule, NumberAxisModule, TimeAxisModule];

interface Point {
  at: Date;
  held: number;
  paid: number;
  returned: number;
}

const TOKENS = ["--surface", "--ink", "--ink-2", "--ink-3", "--rule", "--rule-strong", "--held-fill", "--paid-fill", "--returned", "--head"] as const;
type Palette = Record<(typeof TOKENS)[number], string> & { mono: string; sans: string };

/** Reads the current theme's tokens as concrete colours from an element inside the themed tree. */
function readPalette(el: HTMLElement): Palette {
  const read = {} as Palette;
  for (const t of TOKENS) {
    el.style.color = `var(${t})`;
    read[t] = getComputedStyle(el).color;
  }
  // Figures use the reading face (tabular digits are a feature of the face, not a separate family).
  el.style.fontFamily = "var(--font-sans)";
  read.mono = getComputedStyle(el).fontFamily;
  el.style.fontFamily = "var(--font-sans)";
  read.sans = getComputedStyle(el).fontFamily;
  return read;
}

/** One point per ledger movement in the main currency, starting from zero just before the first. */
function series(entries: LedgerRow[]): { points: Point[]; currency: string } {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.currency, (counts.get(e.currency) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  const rows = entries.filter((e) => e.currency === currency).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const byContract = new Map<string, LedgerRow[]>();
  const heldBy = new Map<string, number>();
  let paid = 0;
  let returned = 0;
  const points: Point[] = [];
  if (rows.length > 0) points.push({ at: new Date(Date.parse(rows[0].created_at) - 60_000), held: 0, paid: 0, returned: 0 });
  for (const e of rows) {
    const list = byContract.get(e.contract_id) ?? [];
    list.push(e);
    byContract.set(e.contract_id, list);
    heldBy.set(e.contract_id, heldFrom(sumLedger(list)));
    if (e.kind === "PAID_OUT") paid += e.amount_cents;
    if (e.kind === "VOIDED" || e.kind === "REFUNDED") returned += e.amount_cents;
    let held = 0;
    for (const v of heldBy.values()) held += v;
    points.push({ at: new Date(e.created_at), held: held / 100, paid: paid / 100, returned: returned / 100 });
  }
  return { points, currency };
}

export function MoneyChart({ entries }: { entries: LedgerRow[] }) {
  // The probe is keyed by the theme, so it remounts and is read again whenever the theme changes.
  const theme = useResolvedTheme();
  const [palette, setPalette] = useState<Palette | null>(null);
  const probe = useCallback((el: HTMLSpanElement | null) => {
    if (el) setPalette(readPalette(el));
  }, []);
  const { points, currency } = useMemo(() => series(entries), [entries]);
  const last = points.at(-1);

  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!palette || points.length === 0) return null;
    const money = (v: number) => formatCents(Math.round(v * 100), currency).replace(/\.00$/, "");
    return {
      data: points,
      animation: { enabled: false },
      legend: { enabled: false },
      padding: { top: 8, right: 12, bottom: 4, left: 4 },
      theme: {
        baseTheme: "ag-default",
        params: {
          backgroundColor: palette["--surface"],
          foregroundColor: palette["--ink"],
          textColor: palette["--ink-2"],
          subtleTextColor: palette["--ink-3"],
          borderColor: palette["--rule"],
          fontFamily: palette.mono,
          fontSize: 11,
          tooltipBackgroundColor: palette["--surface"],
          tooltipTextColor: palette["--ink"],
          axisLineColor: palette["--rule-strong"],
        },
      },
      axes: {
        x: {
          type: "time",
          position: "bottom",
          line: { stroke: palette["--rule-strong"] },
          gridLine: { enabled: false },
          label: { color: palette["--ink-3"] },
        },
        y: {
          type: "number",
          position: "right",
          line: { enabled: false },
          gridLine: { style: [{ stroke: palette["--rule"], lineDash: [2, 3] }] },
          label: { color: palette["--ink-3"], formatter: ({ value }: { value: number }) => money(value) },
        },
      },
      series: [
        {
          type: "area",
          xKey: "at",
          yKey: "held",
          yName: "Held by PayPal",
          interpolation: { type: "step", position: "end" },
          fill: palette["--held-fill"],
          fillOpacity: 0.16,
          stroke: palette["--held-fill"],
          strokeWidth: 2,
          marker: { enabled: false },
        },
        {
          type: "line",
          xKey: "at",
          yKey: "paid",
          yName: "Paid to workers",
          interpolation: { type: "step", position: "end" },
          stroke: palette["--paid-fill"],
          strokeWidth: 2,
          marker: { enabled: false },
        },
        {
          type: "line",
          xKey: "at",
          yKey: "returned",
          yName: "Returned to payers",
          interpolation: { type: "step", position: "end" },
          stroke: palette["--returned"],
          strokeWidth: 1.5,
          lineDash: [4, 3],
          marker: { enabled: false },
        },
      ],
    };
  }, [palette, points, currency]);

  return (
    <figure className="relative flex flex-1 flex-col overflow-hidden border border-rule bg-surface" aria-labelledby="money-chart-h">
      <span key={theme ?? "unresolved"} ref={probe} className="pointer-events-none absolute size-0 overflow-hidden" aria-hidden />
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule bg-head px-3 py-1.5">
        <h2 id="money-chart-h" className="panel-title">
          Money over time <span className="font-normal tracking-normal text-ink-2 normal-case">· {currency}</span>
        </h2>
        <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.72rem] text-ink-2">
          <li className="flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-[1px] bg-held-fill/30 shadow-[inset_0_2px_0_var(--held-fill)]" aria-hidden /> Held
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 bg-paid-fill" aria-hidden /> Paid out
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-3 border-t-[1.5px] border-dashed border-returned" aria-hidden /> Returned
          </li>
        </ul>
      </header>
      {/* At least 11.5rem tall; taller when the layout gives the chart more room (the ultrawide ledger). */}
      <div className="relative min-h-[11.5rem] flex-1">
        <div className="absolute inset-0 px-1 pb-1">
          {options ? (
            <AgCharts options={options} modules={MODULES} style={{ height: "100%" }} />
          ) : (
            <div className="grid h-full place-items-center tnum text-[0.72rem] text-ink-3">{points.length === 0 ? "No money has moved yet." : ""}</div>
          )}
        </div>
      </div>
      <figcaption className="sr-only">
        {last
          ? `Step chart of money over time in ${currency}. Now: ${formatCents(Math.round(last.held * 100), currency)} held by PayPal, ${formatCents(Math.round(last.paid * 100), currency)} paid to workers in total, ${formatCents(Math.round(last.returned * 100), currency)} returned to payers in total.`
          : "No money has moved yet."}
      </figcaption>
    </figure>
  );
}
