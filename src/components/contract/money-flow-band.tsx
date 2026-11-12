"use client";

/**
 * The money flow (docs/design.md, "The money flow"): where this contract's
 * money is right now and every path it can take, drawn as five places joined
 * by five legs. Places and labels are HTML in a grid that is a row on wide
 * screens and a column on phones; the legs are an SVG drawn over it from the
 * measured positions of the places. When money moves while the page is open,
 * the leg it took draws itself once and a packet travels along it.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Identity } from "@/lib/types";
import type { ContractBundle } from "../api";
import { formatCents } from "../format";
import { IconCheck, IconLock, IconReturn, IconSafe, IconX } from "../icons";
import { RoleMark } from "../role-mark";
import { LocalTime, RelativeTime } from "../time";
import { Card, cx } from "../ui";
import { moneyPosition } from "./money";
import { LEG_ORDER, moneyFlow, PLACE_ORDER, type FlowTone, type LegKey, type LegModel, type LegStatus, type MoneyFlow, type PlaceKey, type PlaceModel } from "./money-flow";

/** Classes per tone. Written out in full so the CSS build sees every class. */
const TONE: Record<FlowTone, { text: string; border: string; ring: string; soft: string; fill: string; stroke: string; edge: string }> = {
  neutral: { text: "text-ink", border: "border-ink", ring: "ring-ink", soft: "bg-surface-2", fill: "bg-ink text-surface", stroke: "var(--ink)", edge: "border-l-3 border-l-ink" },
  held: { text: "text-held", border: "border-held", ring: "ring-held", soft: "bg-held-soft", fill: "bg-held-fill text-held-on", stroke: "var(--held)", edge: "border-l-3 border-l-held" },
  paid: { text: "text-paid", border: "border-paid", ring: "ring-paid", soft: "bg-paid-soft", fill: "bg-paid-fill text-paid-on", stroke: "var(--paid)", edge: "border-l-3 border-l-paid" },
  returned: { text: "text-returned", border: "border-returned", ring: "ring-returned", soft: "bg-returned-soft", fill: "bg-returned-fill text-returned-on", stroke: "var(--returned)", edge: "border-l-3 border-l-returned" },
  disputed: { text: "text-disputed", border: "border-disputed", ring: "ring-disputed", soft: "bg-disputed-soft", fill: "bg-disputed-fill text-disputed-on", stroke: "var(--disputed)", edge: "border-l-3 border-l-disputed" },
  fail: { text: "text-fail", border: "border-fail", ring: "ring-fail", soft: "bg-fail-soft", fill: "bg-fail-fill text-fail-on", stroke: "var(--fail)", edge: "border-l-3 border-l-fail" },
};

/** Grid placement: a column of places on phones (returned beside the capture), one row on wide screens. */
const PLACE_CELL: Record<PlaceKey, string> = {
  payer: "col-start-1 row-start-1 @min-[58rem]:col-start-1 @min-[58rem]:row-start-1",
  hold: "col-start-1 row-start-3 @min-[58rem]:col-start-3 @min-[58rem]:row-start-1",
  capture: "col-start-1 row-start-5 @min-[58rem]:col-start-5 @min-[58rem]:row-start-1",
  worker: "col-start-1 row-start-7 @min-[58rem]:col-start-7 @min-[58rem]:row-start-1",
  returned: "col-start-2 row-start-5 @min-[58rem]:col-start-5 @min-[58rem]:row-start-3",
};
const LEG_CELL: Record<LegKey, string> = {
  fund: "col-start-1 row-start-2 @min-[58rem]:col-start-2 @min-[58rem]:row-start-1",
  capture: "col-start-1 row-start-4 @min-[58rem]:col-start-4 @min-[58rem]:row-start-1",
  payout: "col-start-1 row-start-6 @min-[58rem]:col-start-6 @min-[58rem]:row-start-1",
  release: "col-start-2 row-start-4 @min-[58rem]:col-start-4 @min-[58rem]:row-start-3",
  refund: "col-start-2 row-start-6 @min-[58rem]:col-start-5 @min-[58rem]:row-start-2",
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Geometry {
  width: number;
  height: number;
  paths: Record<LegKey, { d: string; end: { x: number; y: number; dir: "right" | "down" } }>;
}

/** The SVG path of every leg, from the measured places. Row layout when the payer and worker share a line. */
function legPaths(b: Record<PlaceKey, Box>): Geometry["paths"] {
  const cy = (k: PlaceKey) => b[k].y + b[k].h / 2;
  const cx_ = (k: PlaceKey) => b[k].x + b[k].w / 2;
  const right = (k: PlaceKey) => b[k].x + b[k].w;
  const bottom = (k: PlaceKey) => b[k].y + b[k].h;
  const r = 10;
  const row = Math.abs(b.payer.y - b.worker.y) < 4;
  if (row) {
    const h = (from: PlaceKey, to: PlaceKey) => {
      const y = cy(from);
      return { d: `M ${right(from)} ${y} H ${b[to].x - 1}`, end: { x: b[to].x - 1, y, dir: "right" as const } };
    };
    const hx = cx_("hold");
    const ry = cy("returned");
    return {
      fund: h("payer", "hold"),
      capture: h("hold", "capture"),
      payout: h("capture", "worker"),
      release: {
        d: `M ${hx} ${bottom("hold")} V ${ry - r} Q ${hx} ${ry} ${hx + r} ${ry} H ${b.returned.x - 1}`,
        end: { x: b.returned.x - 1, y: ry, dir: "right" },
      },
      refund: { d: `M ${cx_("capture")} ${bottom("capture")} V ${b.returned.y - 1}`, end: { x: cx_("capture"), y: b.returned.y - 1, dir: "down" } },
    };
  }
  // Column layout: the spine runs down the left gutter of the places.
  const sx = b.payer.x + 18;
  const v = (from: PlaceKey, to: PlaceKey) => ({ d: `M ${sx} ${bottom(from)} V ${b[to].y - 1}`, end: { x: sx, y: b[to].y - 1, dir: "down" as const } });
  const rx = b.returned.x + 18;
  const hy = cy("hold");
  return {
    fund: v("payer", "hold"),
    capture: v("hold", "capture"),
    payout: v("capture", "worker"),
    release: {
      d: `M ${right("hold")} ${hy} H ${rx - r} Q ${rx} ${hy} ${rx} ${hy + r} V ${b.returned.y - 1}`,
      end: { x: rx, y: b.returned.y - 1, dir: "down" },
    },
    refund: { d: `M ${right("capture")} ${cy("capture")} H ${b.returned.x - 1}`, end: { x: b.returned.x - 1, y: cy("capture"), dir: "right" } },
  };
}

/** Legs that newly carry money since the last update, in the order the money took them. */
function arrivalsBetween(prev: MoneyFlow, next: MoneyFlow): LegKey[] {
  const rank: Record<LegStatus, number> = { closed: 0, possible: 0, failed: 1, moving: 1, done: 2 };
  return LEG_ORDER.filter((k) => next.legs[k].status === "done" && rank[prev.legs[k].status] < 2);
}

const STEP_MS = 1200;

export function MoneyFlowBand({ bundle, identities }: { bundle: ContractBundle; identities: Identity[] }) {
  const flow = useMemo(() => moneyFlow(bundle), [bundle]);
  const { contract } = bundle;
  const position = moneyPosition(contract, bundle.ledger, bundle.payout, bundle.activity.last_failure);
  const payerName = identities.find((i) => i.email === contract.payer_email)?.display_name ?? contract.payer_email;
  const workerName = identities.find((i) => i.email === contract.worker_email)?.display_name ?? contract.worker_email;

  // ---- arrivals: computed while rendering from the previous flow (no effect needed to notice them)
  const [prevFlow, setPrevFlow] = useState(flow);
  const [arrival, setArrival] = useState<{ id: number; legs: LegKey[]; before: MoneyFlow } | null>(null);
  if (prevFlow !== flow) {
    setPrevFlow(flow);
    const legs = prevFlow.amount === flow.amount ? arrivalsBetween(prevFlow, flow) : [];
    if (legs.length > 0) setArrival({ id: (arrival?.id ?? 0) + 1, legs, before: arrival?.before ?? prevFlow });
  }
  const [playing, setPlaying] = useState<number | null>(null);
  // How many of the arriving legs have landed: a destination shows its new state only when the money reaches it.
  const [landed, setLanded] = useState<{ id: number; count: number }>({ id: 0, count: 0 });
  const band = useRef<HTMLElement | null>(null);

  // Bring the diagram into view when money moves (the run log may have the screen), then play the legs once.
  useEffect(() => {
    if (!arrival) return;
    const el = band.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const focus = document.activeElement;
    const typing = focus instanceof HTMLElement && (focus.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focus.tagName));
    let lead = 40;
    if (el && !typing) {
      const r = el.getBoundingClientRect();
      const visible = r.top >= 0 && r.top < window.innerHeight * 0.6;
      if (!visible) {
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        lead = reduce ? 40 : 700;
      }
    }
    // Under reduced motion nothing travels, so every destination takes its new state at once.
    const step = reduce ? 0 : STEP_MS;
    const start = setTimeout(() => setPlaying(arrival.id), lead);
    const lands = arrival.legs.map((_, i) => setTimeout(() => setLanded({ id: arrival.id, count: i + 1 }), lead + i * step + (reduce ? 0 : 1000)));
    const stop = setTimeout(() => {
      setPlaying((p) => (p === arrival.id ? null : p));
      setArrival((a) => (a?.id === arrival.id ? null : a));
    }, lead + arrival.legs.length * step + (reduce ? 0 : 1200));
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
      lands.forEach(clearTimeout);
    };
  }, [arrival]);

  const arriving = new Map<LegKey, number>((arrival?.legs ?? []).map((k, i) => [k, i * STEP_MS]));
  const arrivingPlace = new Map<PlaceKey, number>();
  for (const [k, delay] of arriving) arrivingPlace.set(flow.legs[k].to, delay + 1000);
  const landedCount = arrival && landed.id === arrival.id ? landed.count : 0;
  const placeShown = (k: PlaceKey): PlaceModel => {
    const i = arrival ? arrival.legs.findIndex((l) => flow.legs[l].to === k) : -1;
    return arrival && i >= landedCount ? arrival.before.places[k] : flow.places[k];
  };

  // ---- geometry: measured from the rendered places, redrawn when anything resizes
  const wrap = useRef<HTMLDivElement | null>(null);
  const placeEls = useRef<Partial<Record<PlaceKey, HTMLDivElement | null>>>({});
  const [geo, setGeo] = useState<Geometry | null>(null);
  useEffect(() => {
    const host = wrap.current;
    if (!host) return;
    const measure = () => {
      const base = host.getBoundingClientRect();
      const boxes = {} as Record<PlaceKey, Box>;
      for (const k of PLACE_ORDER) {
        const el = placeEls.current[k];
        if (!el) return;
        const r = el.getBoundingClientRect();
        boxes[k] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      }
      setGeo({ width: base.width, height: base.height, paths: legPaths(boxes) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    for (const k of PLACE_ORDER) {
      const el = placeEls.current[k];
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, []);

  const headTone = position.stage === "held" ? "text-held" : position.stage === "sending" ? (position.problem ? "text-disputed" : "text-paid") : ["paid", "split"].includes(position.stage) ? "text-paid" : ["released", "refunded"].includes(position.stage) ? "text-returned" : "text-ink";

  const marks: Record<PlaceKey, ReactNode> = {
    payer: <RoleMark role="payer" />,
    hold: <IconLock size={13} strokeWidth={2.2} />,
    capture: <IconSafe size={13} strokeWidth={2.2} />,
    worker: <RoleMark role="worker" />,
    returned: <IconReturn size={13} strokeWidth={2.2} />,
  };
  const subs: Record<PlaceKey, string> = {
    payer: payerName,
    hold: "authorization",
    capture: "Treuhand's PayPal balance",
    worker: workerName,
    returned: payerName,
  };

  return (
    <Card className="overflow-hidden">
      <section ref={band} aria-labelledby="money-flow-h" className="scroll-mt-20">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule bg-head px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id="money-flow-h" className="panel-title">
              Money flow
            </h2>
            <p className={cx("tnum text-[length:calc(0.8125rem*var(--fs,1))] font-semibold", headTone)} aria-live="polite" data-testid="money-headline">
              {position.headline}
            </p>
          </div>
          <span className="text-[length:calc(0.72rem*var(--fs,1))] text-ink-2">PayPal sandbox · {contract.currency}</span>
        </header>

        <div ref={wrap} className="@container relative px-3 pt-3.5 pb-3 sm:px-4" data-playing={playing !== null && playing === arrival?.id ? "" : undefined}>
          {geo ? <Legs geo={geo} flow={flow} arriving={arriving} quiet={arrival !== null && landedCount < arrival.legs.length} /> : null}
          <div
            className={cx(
              "flow-grid relative grid grid-cols-[minmax(0,1fr)_minmax(0,0.82fr)] gap-x-3",
              "@min-[58rem]:grid-cols-[minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)] @min-[58rem]:grid-rows-[auto_calc(3.25rem*var(--fs,1))_auto] @min-[58rem]:gap-x-0",
            )}
          >
            {PLACE_ORDER.map((k) => (
              <Place
                key={k}
                place={placeShown(k)}
                currency={flow.currency}
                mark={marks[k]}
                sub={subs[k]}
                className={PLACE_CELL[k]}
                arriveDelay={arrivingPlace.get(k)}
                ref={(el) => {
                  placeEls.current[k] = el;
                }}
              />
            ))}
            {LEG_ORDER.map((k) => (
              <LegLabel key={k} leg={flow.legs[k]} currency={flow.currency} className={LEG_CELL[k]} desk={k !== "refund" ? "around" : ["done", "moving", "failed"].includes(flow.legs.payout.status) ? "beside-left" : "beside"} arriveDelay={arriving.get(k)} />
            ))}
            <Legend className="col-span-2 col-start-1 row-start-8 mt-3 @min-[58rem]:col-span-2 @min-[58rem]:col-start-1 @min-[58rem]:row-start-3 @min-[58rem]:mt-0 @min-[58rem]:self-end" />
            <p className="col-span-2 col-start-1 row-start-9 mt-2 text-[length:calc(0.78rem*var(--fs,1))] leading-[calc(1.15rem*var(--fs,1))] text-ink-2 @min-[58rem]:col-span-2 @min-[58rem]:col-start-6 @min-[58rem]:row-start-3 @min-[58rem]:mt-0 @min-[58rem]:self-center @min-[58rem]:pl-4">
              {position.detail}
              {contract.paypal_order_id ? (
                <span className="mt-1 block text-[length:calc(0.72rem*var(--fs,1))] text-ink-3">
                  PayPal order <span className="font-code text-ink-2">{contract.paypal_order_id}</span>
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </section>
    </Card>
  );
}

function Place({
  place,
  currency,
  mark,
  sub,
  className,
  arriveDelay,
  ref,
}: {
  place: PlaceModel;
  currency: string;
  mark: ReactNode;
  sub: string;
  className: string;
  arriveDelay: number | undefined;
  ref: (el: HTMLDivElement | null) => void;
}) {
  const t = TONE[place.tone];
  const { status } = place;
  const current = status === "current";
  const frame: Record<typeof status, string> = {
    current: cx("bg-surface-2 border-rule-strong", t.edge),
    incoming: cx("bg-surface border-dashed", t.border),
    visited: "bg-surface border-rule-strong",
    possible: "bg-transparent border-dashed border-rule-strong",
    closed: "bg-transparent border-dotted border-rule-strong",
  };
  return (
    <div
      ref={ref}
      className={cx(
        "relative flex min-h-[calc(5.25rem*var(--fs,1))] min-w-0 flex-col justify-between border px-3 py-2 transition-colors duration-300",
        frame[status],
        arriveDelay !== undefined && cx("node-arrive", t.text),
        className,
      )}
      style={arriveDelay !== undefined ? ({ "--arrive-delay": `${arriveDelay}ms` } as CSSProperties) : undefined}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={cx("flex min-w-0 items-start gap-1.5", current || status === "incoming" ? t.text : status === "visited" ? "text-ink-2" : "text-ink-3")}>
          <span className="shrink-0">{mark}</span>
          <span className="min-w-0 text-[length:calc(0.75rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold break-words">{place.title}</span>
        </span>
        {current ? (
          <span className={cx("stamp shrink-0 self-start rounded-xs px-1 py-px text-[length:calc(0.62rem*var(--fs,1))] leading-[calc(0.75rem*var(--fs,1))] font-semibold", t.fill)}>
            NOW<span className="sr-only">: the money is here</span>
          </span>
        ) : status === "visited" ? (
          <IconCheck size={13} strokeWidth={2.6} className="shrink-0 text-ink-2" aria-label="money passed through" />
        ) : null}
      </div>
      <p className="truncate text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-ink-3">{sub}</p>
      <div className="mt-1 flex min-w-0 flex-col">
        {place.cents !== null ? (
          <span
            className={cx(
              "tnum leading-none font-medium whitespace-nowrap",
              current ? "figure-hero text-[length:calc(1.25rem*var(--fs,1))] text-ink" : status === "incoming" ? "text-[length:calc(1rem*var(--fs,1))] text-ink" : "text-[length:calc(0.9rem*var(--fs,1))] text-ink-3",
            )}
          >
            {formatCents(place.cents, currency)}
          </span>
        ) : null}
        <span className={cx("mt-1 text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-pretty", current ? "font-semibold text-ink" : status === "visited" || status === "incoming" ? "text-ink-2" : "text-ink-3")}>{place.word}</span>
      </div>
    </div>
  );
}

function LegLabel({
  leg,
  currency,
  className,
  desk,
  arriveDelay,
}: {
  leg: LegModel;
  currency: string;
  className: string;
  /**
   * Wide screens: "around" a horizontal leg (above and below the line) or "beside" a vertical one,
   * on its right; "beside-left" when the payout leg's lower label (a time, a batch reference) hangs
   * into that space (DEF-23).
   */
  desk: "around" | "beside" | "beside-left";
  arriveDelay: number | undefined;
}) {
  const t = TONE[leg.tone];
  const money = leg.cents !== null ? formatCents(leg.cents, currency) : null;
  const around = desk === "around";
  const left = desk === "beside-left";
  const top = cx(
    "flex min-w-0 flex-col gap-0.5 pt-2 pl-9",
    around
      ? "@min-[58rem]:absolute @min-[58rem]:inset-x-2 @min-[58rem]:bottom-1/2 @min-[58rem]:items-center @min-[58rem]:pt-0 @min-[58rem]:pb-1.5 @min-[58rem]:pl-0 @min-[58rem]:text-center"
      : cx("@min-[58rem]:flex-row @min-[58rem]:flex-wrap @min-[58rem]:items-baseline @min-[58rem]:gap-x-1.5 @min-[58rem]:gap-y-0 @min-[58rem]:pt-0 @min-[58rem]:pl-0", left && "@min-[58rem]:justify-end"),
  );
  const bottom = cx(
    "flex min-w-0 flex-col pb-2 pl-9",
    around
      ? "@min-[58rem]:absolute @min-[58rem]:inset-x-2 @min-[58rem]:top-1/2 @min-[58rem]:items-center @min-[58rem]:pt-1.5 @min-[58rem]:pb-0 @min-[58rem]:pl-0 @min-[58rem]:text-center"
      : cx("@min-[58rem]:pb-0 @min-[58rem]:pl-0 @min-[58rem]:[&>.leg-note]:hidden", left && "@min-[58rem]:items-end"),
  );
  const stamp = arriveDelay !== undefined ? { className: "leg-label-arrive", style: { "--arrive-delay": `${arriveDelay + 950}ms` } as CSSProperties } : null;

  let upper: ReactNode;
  let lower: ReactNode = null;
  switch (leg.status) {
    case "done":
      upper = (
        <>
          <span className={cx("text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold", t.text)}>{leg.verb}</span>
          {money ? <span className="tnum text-[length:calc(0.84rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold whitespace-nowrap text-ink">{money}</span> : null}
        </>
      );
      lower = (
        <>
          {leg.at ? <LocalTime iso={leg.at} className="tnum text-[length:calc(0.64rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] whitespace-nowrap text-ink-3" /> : null}
          {leg.ref ? <Ref label={leg.refLabel} value={leg.ref} /> : null}
          {leg.note ? <span className="leg-note text-[length:calc(0.66rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-ink-3">{leg.note}</span> : null}
          {leg.attempt ? <span className="leg-note tnum text-[length:calc(0.64rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-ink-3">{leg.attempt}</span> : null}
        </>
      );
      break;
    case "moving":
      upper = (
        <>
          <span className={cx("flex items-center gap-1 text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold", t.text)}>
            <span className={cx("size-1.5 rounded-[1px]", t.fill)} aria-hidden />
            {leg.verb}
          </span>
          {money ? <span className="tnum text-[length:calc(0.84rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold whitespace-nowrap text-ink">{money}</span> : null}
        </>
      );
      lower = (
        <>
          {leg.note ? (
            <span className="text-[length:calc(0.7rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold text-ink" role="status">
              {leg.note}
            </span>
          ) : null}
          {leg.attempt ? <span className="tnum text-[length:calc(0.64rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-disputed @min-[58rem]:hidden">{leg.attempt}</span> : null}
          {leg.ref ? <Ref label={leg.refLabel} value={leg.ref} /> : null}
        </>
      );
      break;
    case "failed":
      upper = (
        <>
          <span className={cx("flex items-center gap-1 text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold", t.text)}>
            <IconX size={11} strokeWidth={3} />
            {leg.verb}
          </span>
          {money ? <span className="tnum text-[length:calc(0.84rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold whitespace-nowrap text-ink-3 line-through decoration-1">{money}</span> : null}
        </>
      );
      lower = (
        <>
          {leg.note ? <span className="text-[length:calc(0.66rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-ink-2">{leg.note}</span> : null}
          {leg.ref ? <Ref label="last batch" value={leg.ref} /> : null}
        </>
      );
      break;
    case "possible":
      upper = (
        <>
          <span className="text-[length:calc(0.7rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold text-ink-3">{leg.verb} when</span>
          <span className="text-[length:calc(0.72rem*var(--fs,1))] leading-[calc(0.95rem*var(--fs,1))] text-ink-2">{leg.trigger}</span>
        </>
      );
      lower = leg.when ? (
        <span className="tnum text-[length:calc(0.64rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] text-ink-3">
          <LocalTime iso={leg.when} className="whitespace-nowrap text-ink-2" /> <RelativeTime iso={leg.when} className="whitespace-nowrap" />
        </span>
      ) : money ? (
        <span className="tnum text-[length:calc(0.68rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] whitespace-nowrap text-ink-3">{money}</span>
      ) : null;
      break;
    case "closed":
      upper = <span className="text-[length:calc(0.7rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] font-semibold text-ink-3">{leg.closedText}</span>;
      break;
  }

  return (
    <div className={cx("relative min-w-0", className)}>
      <div
        className={cx(
          !around && "@min-[58rem]:absolute @min-[58rem]:inset-y-0 @min-[58rem]:flex @min-[58rem]:w-max @min-[58rem]:max-w-[calc(15rem*var(--fs,1))] @min-[58rem]:flex-col @min-[58rem]:justify-center",
          !around && (left ? "@min-[58rem]:right-[calc(50%+0.75rem)] @min-[58rem]:text-right" : "@min-[58rem]:left-[calc(50%+0.75rem)]"),
        )}
      >
        <div className={cx(top, stamp?.className)} style={stamp?.style}>
          {upper}
        </div>
        {lower ? (
          <div className={cx(bottom, stamp?.className)} style={stamp?.style}>
            {lower}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Ref({ label, value }: { label: string; value: string }) {
  return (
    <span className="max-w-full min-w-0 font-code text-[length:calc(0.66rem*var(--fs,1))] leading-[calc(1rem*var(--fs,1))] break-all text-ink-2" title={`PayPal ${label} ${value}`}>
      <span className="sr-only">PayPal {label} </span>
      {value}
    </span>
  );
}

/** The legs, drawn over the grid from measured positions. Decorative: every leg's state is written in its label. */
function Legs({ geo, flow, arriving, quiet }: { geo: Geometry; flow: MoneyFlow; arriving: Map<LegKey, number>; quiet: boolean }) {
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={geo.width} height={geo.height} aria-hidden>
        {LEG_ORDER.map((k) => {
          const leg = flow.legs[k];
          const { d, end } = geo.paths[k];
          const t = TONE[leg.tone];
          const delay = arriving.get(k);
          const shownStatus: LegStatus = delay !== undefined ? "possible" : leg.status;
          const style = LEG_STROKE[shownStatus];
          const stroke = shownStatus === "done" || shownStatus === "moving" || shownStatus === "failed" ? t.stroke : style.stroke;
          return (
            <g key={k}>
              <path d={d} fill="none" stroke={stroke} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" className={shownStatus === "moving" ? "leg-flow" : undefined} />
              {shownStatus !== "closed" ? <Arrow end={end} color={stroke} /> : null}
              {delay !== undefined ? (
                <g className="leg-arrive-group" style={{ "--arrive-delay": `${delay}ms` } as CSSProperties}>
                  <path d={d} fill="none" stroke={t.stroke} strokeWidth={2.25} pathLength={1} className="leg-arrive" strokeLinecap="round" />
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
      {LEG_ORDER.map((k) => {
        const leg = flow.legs[k];
        const delay = arriving.get(k);
        // While money is still travelling to a place, the next leg out of it waits before it starts to flow.
        if (delay === undefined && (leg.status !== "moving" || quiet)) return null;
        return (
          <span
            key={`${k}-${delay ?? "loop"}`}
            aria-hidden
            className={cx("packet", delay !== undefined ? "packet-once" : "packet-loop", TONE[leg.tone].fill)}
            style={{ offsetPath: `path("${geo.paths[k].d}")`, "--arrive-delay": `${delay ?? 0}ms` } as CSSProperties}
          />
        );
      })}
    </>
  );
}

const LEG_STROKE: Record<LegStatus, { stroke: string; width: number; dash?: string }> = {
  done: { stroke: "", width: 2.25 },
  moving: { stroke: "", width: 2.25, dash: "7 6" },
  failed: { stroke: "", width: 1.75, dash: "4 4" },
  possible: { stroke: "var(--field)", width: 1.5, dash: "3 4" },
  closed: { stroke: "var(--rule-strong)", width: 1.25, dash: "1 5" },
};

function Arrow({ end, color }: { end: { x: number; y: number; dir: "right" | "down" }; color: string }) {
  const { x, y, dir } = end;
  const d = dir === "right" ? `M ${x - 7} ${y - 4.5} L ${x} ${y} L ${x - 7} ${y + 4.5} Z` : `M ${x - 4.5} ${y - 7} L ${x} ${y} L ${x + 4.5} ${y - 7} Z`;
  return <path d={d} fill={color} />;
}

function Legend({ className }: { className: string }) {
  const sample = (dash: string | undefined, color: string, width = 2) => (
    <svg width="22" height="6" aria-hidden className="shrink-0">
      <path d="M 1 3 H 21" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[length:calc(0.7rem*var(--fs,1))] text-ink-3", className)} aria-label="How to read the money flow">
      <li className="flex items-center gap-1.5">{sample(undefined, "var(--ink-2)")}moved</li>
      <li className="flex items-center gap-1.5">{sample("7 6", "var(--ink-2)")}moving now</li>
      <li className="flex items-center gap-1.5">{sample("3 4", "var(--field)", 1.5)}can still move</li>
      <li className="flex items-center gap-1.5">{sample("1 5", "var(--rule-strong)", 1.5)}no longer possible</li>
    </ul>
  );
}
