"use client";

/**
 * The ledger: every money movement PayPal made for every contract, from
 * `GET /api/ledger`, in AG Grid (community). Amounts are split into accounting
 * columns (into the hold, captured, paid out, returned) so the pinned totals
 * row means something; totals follow the grid's filters.
 */
import { AllCommunityModule, themeQuartz, type ColDef, type ColGroupDef, type GridApi, type ICellRendererParams, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContractState, LedgerKind } from "@/lib/types";
import { api, errorMessage, type LedgerRow } from "../api";
import { formatCents, formatLocal, LEDGER_KIND_META, shortId } from "../format";
import { IconDownload, IconSearch } from "../icons";
import { heldFrom, sumLedger } from "../contract/money";
import { Banner, Button, Chip, cx, inputClass, StateChip } from "../ui";
import { MoneyChart } from "./money-chart";
import { MoneyFlowSankey } from "./money-flow-sankey";
import { useMinWidth } from "../use-min-width";
import { usePolling } from "../use-polling";

const MODULES = [AllCommunityModule];
const POLL_MS = 5_000;

/** The money columns a ledger kind lands in. */
type Bucket = "held" | "captured" | "paid" | "returned";
const BUCKET: Record<LedgerKind, Bucket> = {
  AUTHORIZED: "held",
  CAPTURED: "captured",
  PAID_OUT: "paid",
  VOIDED: "returned",
  REFUNDED: "returned",
};

interface GridRow {
  id: string;
  at: Date;
  contract_id: string;
  contract_title: string;
  contract_state: ContractState | null;
  kind: LedgerKind | null;
  flow: string;
  currency: string;
  held: number | null;
  captured: number | null;
  paid: number | null;
  returned: number | null;
  paypal_ref: string | null;
  /** Set on the pinned totals row. */
  total?: { count: number };
}

function toGridRow(e: LedgerRow): GridRow {
  const bucket = BUCKET[e.kind];
  return {
    id: e.id,
    at: new Date(e.created_at),
    contract_id: e.contract_id,
    contract_title: e.contract_title,
    contract_state: e.contract_state,
    kind: e.kind,
    flow: LEDGER_KIND_META[e.kind].flow,
    currency: e.currency,
    held: bucket === "held" ? e.amount_cents : null,
    captured: bucket === "captured" ? e.amount_cents : null,
    paid: bucket === "paid" ? e.amount_cents : null,
    returned: bucket === "returned" ? e.amount_cents : null,
    paypal_ref: e.paypal_ref,
  };
}

/** Every colour and font is a design token, so the grid follows the light and dark themes without a re-render. */
const theme = themeQuartz.withParams({
  fontFamily: "var(--font-sans), ui-sans-serif, sans-serif",
  headerFontFamily: "var(--font-sans), ui-sans-serif, sans-serif",
  headerFontWeight: 600,
  headerFontSize: 12,
  fontSize: 13,
  dataFontSize: 13,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  subtleTextColor: "var(--ink-3)",
  chromeBackgroundColor: "var(--head)",
  headerBackgroundColor: "var(--head)",
  headerTextColor: "var(--ink-2)",
  borderColor: "var(--rule)",
  accentColor: "var(--accent-fill)",
  rowHoverColor: "var(--surface-2)",
  oddRowBackgroundColor: "var(--surface)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  pinnedRowBackgroundColor: "var(--surface-2)",
  pinnedRowBorder: { width: 1, color: "var(--rule-strong)" },
  menuBackgroundColor: "var(--surface)",
  inputBackgroundColor: "var(--inset)",
  inputBorder: { color: "var(--field)" },
  browserColorScheme: "inherit",
  wrapperBorderRadius: 0,
  borderRadius: 2,
  spacing: 6,
  rowHeight: 28,
  headerHeight: 28,
  cellHorizontalPadding: 10,
});

/** From 4xl (2400 px) the interface's rem sizes grow by 1.125 (globals.css); the grid's pixel sizes follow. */
const themeUltrawide = theme.withParams({
  headerFontSize: 13.5,
  fontSize: 14.5,
  dataFontSize: 14.5,
  spacing: 7,
  rowHeight: 32,
  headerHeight: 32,
  cellHorizontalPadding: 11,
});

/** One filter chip per ledger kind, the same five paths the money-flow diagram draws. */
const KIND_FILTERS: { key: LedgerKind; label: string; tone: string }[] = [
  { key: "AUTHORIZED", label: "Into hold", tone: "bg-held-fill" },
  { key: "CAPTURED", label: "Captured", tone: "bg-held-fill" },
  { key: "PAID_OUT", label: "Paid to workers", tone: "bg-paid-fill" },
  { key: "VOIDED", label: "Released", tone: "bg-returned-fill" },
  { key: "REFUNDED", label: "Refunded", tone: "bg-returned-fill" },
];
const ALL_KINDS = () => new Set<LedgerKind>(KIND_FILTERS.map((k) => k.key));

export function LedgerView() {
  const [entries, setEntries] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [kinds, setKinds] = useState<Set<LedgerKind>>(ALL_KINDS);
  // From 3xl the grid fills the height it is given instead of growing with its rows.
  const wide = useMinWidth("110rem");
  const ultrawide = useMinWidth("150rem");
  const [pinned, setPinned] = useState<GridRow[]>([]);
  const [visible, setVisible] = useState(0);
  const gridApi = useRef<GridApi<GridRow> | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const kindsRef = useRef(kinds);
  useEffect(() => {
    kindsRef.current = kinds;
    gridApi.current?.onFilterChanged();
  }, [kinds]);
  // A flow chosen in the diagram shows only its movements; choosing it again shows everything.
  const soloKind = kinds.size === 1 ? [...kinds][0] : null;
  const chooseFlow = useCallback((kind: LedgerKind) => setKinds((prev) => (prev.size === 1 && prev.has(kind) ? ALL_KINDS() : new Set([kind]))), []);

  const load = useCallback(async () => {
    try {
      const data = await api<{ entries: LedgerRow[] }>("/api/ledger");
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  usePolling(load, POLL_MS);

  const rows = useMemo(() => (entries ?? []).map(toGridRow), [entries]);

  // Flash rows that arrived since the last poll, so a new payout is visible the moment it lands.
  useEffect(() => {
    if (!entries) return;
    const ids = new Set(entries.map((e) => e.id));
    const previous = seen.current;
    seen.current = ids;
    if (!previous || !gridApi.current) return;
    const fresh = entries.filter((e) => !previous.has(e.id)).map((e) => e.id);
    if (fresh.length === 0) return;
    const api = gridApi.current;
    requestAnimationFrame(() => {
      const nodes = fresh.map((id) => api.getRowNode(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
      if (nodes.length) api.flashCells({ rowNodes: nodes });
    });
  }, [entries]);

  const totals = useMemo(() => summarize(entries ?? []), [entries]);

  const recomputePinned = useCallback(() => {
    const api = gridApi.current;
    if (!api) return;
    const sum = { held: 0, captured: 0, paid: 0, returned: 0 };
    let count = 0;
    const currencies = new Set<string>();
    api.forEachNodeAfterFilter((node) => {
      const d = node.data;
      if (!d) return;
      count++;
      currencies.add(d.currency);
      sum.held += d.held ?? 0;
      sum.captured += d.captured ?? 0;
      sum.paid += d.paid ?? 0;
      sum.returned += d.returned ?? 0;
    });
    setVisible(count);
    setPinned([
      {
        id: "__total",
        at: new Date(0),
        contract_id: "",
        // The label lives in a field so the grid sees a changed value and repaints the pinned cell.
        contract_title: `Total · ${count} movement${count === 1 ? "" : "s"}`,
        contract_state: null,
        kind: null,
        flow: "",
        currency: currencies.size === 1 ? [...currencies][0] : "USD",
        ...sum,
        paypal_ref: null,
        total: { count },
      },
    ]);
  }, []);

  const columnDefs = useMemo<(ColDef<GridRow> | ColGroupDef<GridRow>)[]>(
    () => [
      {
        field: "at",
        headerName: "Time",
        cellDataType: "date",
        sort: "desc",
        minWidth: 148,
        width: 152,
        cellClass: "cell-figure text-ink-2",
        filter: "agDateColumnFilter",
        valueFormatter: (p: ValueFormatterParams<GridRow, Date>) => (p.node?.rowPinned || !p.value ? "" : formatLocal(p.value.toISOString())),
        getQuickFilterText: () => "",
      },
      {
        field: "contract_title",
        headerName: "Contract",
        minWidth: 170,
        flex: 1.6,
        filter: "agTextColumnFilter",
        cellRenderer: ContractCell,
      },
      {
        field: "kind",
        headerName: "Movement",
        minWidth: 136,
        width: 140,
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => (p.data?.kind ? `${LEDGER_KIND_META[p.data.kind].label} ${p.data.kind}` : ""),
        getQuickFilterText: (p) => (p.data?.kind ? `${LEDGER_KIND_META[p.data.kind].label} ${p.data.flow}` : ""),
        cellRenderer: KindCell,
      },
      {
        headerName: "Amount",
        marryChildren: true,
        children: [
          moneyColumn("held", "Into hold", "text-held"),
          moneyColumn("captured", "Captured", "text-ink"),
          moneyColumn("paid", "Paid out", "text-paid"),
          moneyColumn("returned", "Returned", "text-returned"),
        ],
      },
      {
        field: "paypal_ref",
        headerName: "PayPal reference",
        minWidth: 118,
        flex: 1,
        filter: "agTextColumnFilter",
        cellClass: "cell-figure text-ink-2",
        tooltipField: "paypal_ref",
        valueFormatter: (p) => (p.node?.rowPinned ? "" : (p.value ?? "—")),
      },
      {
        field: "contract_state",
        headerName: "Contract now",
        minWidth: 128,
        width: 132,
        filter: "agTextColumnFilter",
        cellRenderer: StateCell,
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<GridRow>>(() => ({ sortable: true, resizable: true, suppressHeaderMenuButton: false, floatingFilter: false }), []);

  return (
    <div className="flex flex-col gap-4 3xl:h-[max(46rem,calc(100dvh_-_var(--shell-chrome)))]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Ledger</p>
          <h1 className="mt-0.5 text-[1.375rem] leading-[1.75rem] font-semibold text-ink">Every dollar PayPal moved</h1>
          <p className="mt-1 max-w-2xl text-[0.8125rem] text-ink-2">
            One row per PayPal action: holds placed, captured, paid to workers, released or refunded. Updates live as contracts settle.
          </p>
        </div>
        <p className="flex items-center gap-2 tnum text-[0.68rem] text-ink-3" role="status">
          <span className={cx("size-2 rounded-[1px]", error ? "bg-disputed-fill" : "pulse-dot bg-paid-fill")} aria-hidden />
          {error ? "Paused" : "Live"} · refresh {POLL_MS / 1000}s
        </p>
      </div>

      {error ? (
        <Banner
          title={entries ? "Could not refresh the ledger" : "The ledger could not be loaded"}
          action={
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Banner>
      ) : null}

      {/*
        From 1024 px: the flow across the top, the figures beside the chart, the
        grid below. From 3xl (1760 px) the figures and chart stack beside the
        flow and the grid takes the rest of the screen's height; from 4xl
        (2400 px) the grid becomes a full-height column on the right.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] 3xl:min-h-0 3xl:flex-1 3xl:grid-cols-[minmax(0,1fr)_34rem] 3xl:grid-rows-[auto_auto_minmax(22rem,1fr)] 4xl:grid-cols-[minmax(0,1fr)_minmax(80rem,1.15fr)] 4xl:grid-rows-[auto_auto_minmax(16rem,1fr)]">
        <div className="flex min-w-0 flex-col lg:col-span-2 3xl:col-span-1 3xl:col-start-1 3xl:row-span-2 3xl:row-start-1 4xl:row-span-1 [&>*]:flex-1">
          {entries ? (
            <MoneyFlowSankey entries={entries} selected={soloKind} onSelect={chooseFlow} />
          ) : (
            <div className="h-[18rem] animate-pulse border border-rule bg-surface" aria-hidden />
          )}
        </div>

        <dl className="grid grid-cols-2 self-start overflow-hidden border border-rule bg-surface 3xl:col-start-2 3xl:row-start-1 4xl:col-start-1 4xl:row-start-2 4xl:grid-cols-4">
          <Tile label="Held by PayPal now" value={totals?.held} tone="text-held" mark="bg-held-fill" note="Reserved or captured, not yet paid out" loading={!entries} />
          <Tile label="Paid out to workers" value={totals?.paid} tone="text-paid" mark="bg-paid-fill" note="Confirmed by PayPal" loading={!entries} />
          <Tile label="Holds released" value={totals?.released} tone="text-returned" mark="bg-returned-fill" note="Payer never charged" loading={!entries} />
          <Tile label="Refunded to payers" value={totals?.refunded} tone="text-returned" mark="bg-returned-fill" note="From agreed splits" loading={!entries} />
        </dl>
        <div className="flex min-w-0 flex-col 3xl:col-start-2 3xl:row-start-2 4xl:col-start-1 4xl:row-start-3">
          {entries ? <MoneyChart entries={entries} /> : <div className="h-[14.5rem] animate-pulse border border-rule bg-surface" aria-hidden />}
        </div>

      <section
        aria-label="Money movements"
        className="flex min-w-0 flex-col gap-3 lg:col-span-2 3xl:col-start-1 3xl:row-start-3 4xl:col-start-2 4xl:row-span-3 4xl:row-start-1"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
            <label htmlFor="ledger-search" className="sr-only">
              Search the ledger
            </label>
            <input
              id="ledger-search"
              type="search"
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              placeholder="Search contract, movement, reference"
              className={cx(inputClass, "h-9 pl-9 text-[0.8125rem]")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Show movements" className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((k) => {
                const on = kinds.has(k.key);
                return (
                  <button
                    key={k.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setKinds((prev) => {
                        const next = new Set(prev);
                        if (next.has(k.key)) next.delete(k.key);
                        else next.add(k.key);
                        return next;
                      })
                    }
                    className={cx(
                      "inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-[0.75rem] font-semibold ring-1 ring-inset transition-colors duration-100",
                      on ? "bg-surface-2 text-ink ring-rule-strong hover:bg-head" : "text-ink-3 line-through ring-rule hover:text-ink-2",
                    )}
                  >
                    <span className={cx("size-2 rounded-[1px]", on ? k.tone : "bg-rule-strong")} aria-hidden />
                    {k.label}
                  </button>
                );
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!entries || entries.length === 0}
              onClick={() =>
                gridApi.current?.exportDataAsCsv({
                  fileName: "clause-ledger.csv",
                  // One header line: the "Amount" group above the money columns would be read as the header.
                  skipColumnGroupHeaders: true,
                  processCellCallback: (p) => {
                    const v = p.value;
                    // The totals row has no time: its `at` is only a placeholder.
                    if (v instanceof Date) return p.node?.rowPinned ? "" : v.toISOString();
                    if (typeof v === "number" && ["held", "captured", "paid", "returned"].includes(p.column.getColId())) return (v / 100).toFixed(2);
                    // A text cell a spreadsheet would run as a formula (a title such as =HYPERLINK(...)) is kept as text (DEF-16).
                    if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
                    return v ?? "";
                  },
                })
              }
            >
              <IconDownload size={15} /> CSV
            </Button>
          </div>
        </div>

        <div className={cx("ledger-grid", wide && "relative min-h-[20rem] flex-1")}>
          <AgGridReact<GridRow>
            containerStyle={wide ? { position: "absolute", inset: 0 } : undefined}
            modules={MODULES}
            theme={ultrawide ? themeUltrawide : theme}
            rowData={rows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            quickFilterText={quick}
            isExternalFilterPresent={() => kindsRef.current.size < KIND_FILTERS.length}
            doesExternalFilterPass={(node) => (node.data?.kind ? kindsRef.current.has(node.data.kind) : true)}
            pinnedBottomRowData={pinned}
            domLayout={wide ? "normal" : "autoHeight"}
            loading={entries === null && !error}
            animateRows
            enableCellTextSelection
            tooltipShowDelay={300}
            pagination={rows.length > 25}
            paginationAutoPageSize={wide}
            paginationPageSize={wide ? undefined : 25}
            paginationPageSizeSelector={false}
            onGridReady={(e) => {
              gridApi.current = e.api;
              recomputePinned();
            }}
            onModelUpdated={recomputePinned}
            overlayNoRowsTemplate={
              entries && entries.length === 0
                ? '<span class="text-sm text-ink-3">No money has moved yet. Rows appear here when a payer funds a contract.</span>'
                : '<span class="text-sm text-ink-3">No movements match these filters.</span>'
            }
          />
        </div>
        {entries && entries.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 tnum text-[0.68rem] text-ink-3">
            <span>Showing {visible} of {entries.length} movements. The totals row adds up what is shown.</span>
            {kinds.size < KIND_FILTERS.length ? (
              <button type="button" onClick={() => setKinds(ALL_KINDS())} className="font-sans text-[0.75rem] font-semibold text-ink underline underline-offset-2">
                Show all movements
              </button>
            ) : null}
          </p>
        ) : null}
      </section>
      </div>
    </div>
  );
}

function moneyColumn(field: Bucket, headerName: string, tone: string): ColDef<GridRow> {
  return {
    field,
    headerName,
    type: "rightAligned",
    cellDataType: "number",
    minWidth: 96,
    width: 100,
    filter: "agNumberColumnFilter",
    filterValueGetter: (p) => (p.data?.[field] == null ? null : (p.data[field] as number) / 100),
    getQuickFilterText: () => "",
    valueFormatter: (p: ValueFormatterParams<GridRow, number | null>) => {
      if (p.value == null) return p.node?.rowPinned ? formatCents(0, p.data?.currency ?? "USD") : "";
      return formatCents(p.value, p.data?.currency ?? "USD");
    },
    cellClass: (p) => cx("cell-figure", p.value == null ? "" : p.node.rowPinned ? "font-bold text-ink" : cx("font-semibold", tone)),
  };
}

function ContractCell(p: ICellRendererParams<GridRow, string>) {
  if (p.node.rowPinned) {
    return <span className="font-semibold text-ink">{p.value}</span>;
  }
  if (!p.data) return null;
  return (
    <Link
      href={`/contracts/${p.data.contract_id}`}
      title={`${p.value} · contract ${shortId(p.data.contract_id)}`}
      className="group flex min-w-0 items-baseline gap-2 text-ink"
    >
      <span className="truncate font-medium group-hover:underline">{p.value}</span>
    </Link>
  );
}

function KindCell(p: ICellRendererParams<GridRow, LedgerKind | null>) {
  if (p.node.rowPinned || !p.value) return null;
  const meta = LEDGER_KIND_META[p.value];
  return (
    <span className="flex h-full items-center leading-tight">
      <Chip tone={meta.tone} dot>
        {meta.label}
      </Chip>
    </span>
  );
}

function StateCell(p: ICellRendererParams<GridRow, ContractState | null>) {
  if (p.node.rowPinned || !p.value) return null;
  return <StateChip state={p.value} />;
}

function summarize(entries: LedgerRow[]) {
  const byCurrency = new Map<string, { held: number; paid: number; released: number; refunded: number }>();
  const byContract = new Map<string, LedgerRow[]>();
  for (const e of entries) {
    const list = byContract.get(e.contract_id) ?? [];
    list.push(e);
    byContract.set(e.contract_id, list);
  }
  for (const list of byContract.values()) {
    const currency = list[0].currency;
    const t = sumLedger(list);
    const acc = byCurrency.get(currency) ?? { held: 0, paid: 0, released: 0, refunded: 0 };
    acc.held += heldFrom(t);
    acc.paid += t.PAID_OUT;
    acc.released += t.VOIDED;
    acc.refunded += t.REFUNDED;
    byCurrency.set(currency, acc);
  }
  const pick = (k: "held" | "paid" | "released" | "refunded") =>
    [...byCurrency.entries()].map(([currency, v]) => ({ currency, cents: v[k] }));
  return { held: pick("held"), paid: pick("paid"), released: pick("released"), refunded: pick("refunded") };
}

function Tile({
  label,
  value,
  tone,
  mark,
  note,
  loading,
}: {
  label: string;
  value: { currency: string; cents: number }[] | undefined;
  tone: string;
  mark: string;
  note: string;
  loading: boolean;
}) {
  const shown = value && value.length > 0 ? value : [{ currency: "USD", cents: 0 }];
  return (
    <div className="flex flex-col justify-between border-rule px-4 py-3 odd:border-r nth-[-n+2]:border-b 4xl:not-last:border-r 4xl:nth-[-n+2]:border-b-0">
      <dt className="label flex items-center gap-1.5">
        <span className={cx("size-2 rounded-[1px]", mark)} aria-hidden />
        {label}
      </dt>
      <dd className={cx("mt-1 tnum text-[1.25rem] leading-7 font-semibold text-ink", tone && "")}>
        {loading ? <span className="inline-block h-7 w-24 animate-pulse rounded-xs bg-inset align-middle" /> : shown.map((v) => formatCents(v.cents, v.currency)).join(" + ")}
      </dd>
      <dd className="mt-0.5 text-[0.7rem] text-ink-3">{note}</dd>
    </div>
  );
}
