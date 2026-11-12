"use client";

/**
 * Every contract with its place on the track, its money, parties and
 * deadline, from `GET /api/contracts`. Refreshes in the background so states
 * stay current.
 */
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { Contract, ContractState, Identity } from "@/lib/types";
import { api, errorMessage } from "./api";
import { CONTRACT_TYPE_META, formatCents, MONEY_WORD, shortId } from "./format";
import { IconArrowRight, IconCode, IconGlobe, IconPlus } from "./icons";
import { MicroTrack } from "./contract/state-rail";
import { RoleMark } from "./role-mark";
import { RelativeTime, useNow } from "./time";
import { useMinWidth } from "./use-min-width";
import { usePolling } from "./use-polling";
import { Banner, Button, cx, TONE_TEXT } from "./ui";

const CLOSED: ContractState[] = ["PAID", "EXPIRED", "SETTLED"];
type Filter = "all" | "open" | "closed";

export function ContractList({ identities }: { identities: Identity[] }) {
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const splitList = useMinWidth("150rem");

  const load = useCallback(async () => {
    try {
      const data = await api<{ contracts: Contract[] }>("/api/contracts");
      setContracts(data.contracts);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  usePolling(load, 10_000);
  const now = useNow();

  const counts = useMemo(() => {
    const list = contracts ?? [];
    return {
      all: list.length,
      open: list.filter((c) => !CLOSED.includes(c.state)).length,
      closed: list.filter((c) => CLOSED.includes(c.state)).length,
    };
  }, [contracts]);

  // Totals by where the money is, from each contract's state (the list has no ledger), per currency.
  const tape = useMemo(() => {
    const sum = (pick: (c: Contract) => boolean) => {
      const by = new Map<string, number>();
      for (const c of contracts ?? []) if (pick(c)) by.set(c.currency, (by.get(c.currency) ?? 0) + c.amount_cents);
      return [...by.entries()].map(([currency, cents]) => formatCents(cents, currency)).join(" + ") || formatCents(0, "USD");
    };
    return {
      held: sum((c) => MONEY_WORD[c.state].tone === "held"),
      paid: sum((c) => c.state === "PAID"),
      unfunded: sum((c) => c.state === "DRAFT" || c.state === "SIGNED"),
    };
  }, [contracts]);

  const shown = (contracts ?? []).filter((c) =>
    filter === "all" ? true : filter === "open" ? !CLOSED.includes(c.state) : CLOSED.includes(c.state),
  );
  const name = (email: string) => identities.find((i) => i.email === email)?.display_name ?? email;

  return (
    <div className="flex flex-col gap-4 3xl:min-h-[calc(100dvh_-_var(--shell-chrome))]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Contracts</p>
          <h1 className="mt-0.5 text-[1.375rem] leading-[1.75rem] font-semibold text-ink">Every deal, and where its money is</h1>
        </div>
        <Link
          href="/"
          className="inline-flex h-8 items-center gap-2 rounded-sm bg-accent-fill px-3 text-[0.8125rem] font-semibold text-accent-on transition-[filter] duration-100 hover:brightness-110"
        >
          <IconPlus size={16} /> New contract
        </Link>
      </div>

      {/* From 3xl the figures become a rail on the left and the list takes the rest of the width and,
          like a blotter, the rest of the window's height. */}
      <div className="flex flex-col gap-4 3xl:grid 3xl:flex-1 3xl:grid-cols-[17rem_minmax(0,1fr)] 3xl:items-start 3xl:gap-x-3">
      {contracts ? (
        <dl className="grid grid-cols-2 overflow-hidden border border-rule bg-surface sm:grid-cols-4 3xl:sticky 3xl:top-[3.75rem] 3xl:col-start-1 3xl:row-start-1 3xl:grid-cols-1">
          <Stat label="Contracts" value={String(counts.all)} note={`${counts.open} in progress · ${counts.closed} closed`} />
          <Stat label="Held by PayPal" value={tape.held} tone="text-held" note="waiting on tests" />
          <Stat label="Paid in full" value={tape.paid} tone="text-paid" note="every test passed" />
          <Stat label="Not funded yet" value={tape.unfunded} tone="text-ink-2" note="draft or signed" />
        </dl>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4 3xl:col-start-2 3xl:row-start-1 3xl:self-stretch">
      {error ? (
        <Banner
          title={contracts ? "Could not refresh the list" : "The contracts could not be loaded"}
          action={
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Banner>
      ) : null}

      {contracts === null && !error ? <ListSkeleton /> : null}

      {contracts !== null ? (
        <>
          <div role="tablist" aria-label="Filter contracts" className="flex w-fit divide-x divide-rule border border-rule bg-inset">
            {(
              [
                ["all", "All"],
                ["open", "In progress"],
                ["closed", "Closed"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                type="button"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={cx(
                  "flex h-7 items-center gap-1.5 px-3 text-[0.8125rem] font-semibold transition-colors duration-100",
                  filter === key ? "bg-accent-fill text-accent-on" : "text-ink-3 hover:text-ink",
                )}
              >
                {label} <span className={cx("tnum text-[0.7rem] font-medium", filter === key ? "text-accent-on" : "text-ink-3")}>{counts[key]}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-rule-strong bg-surface px-6 py-12 text-center">
              <p className="tnum text-[0.7rem] text-ink-3">{contracts.length === 0 ? "0 contracts" : "0 matches"}</p>
              <p className="mt-1.5 font-semibold text-ink">{contracts.length === 0 ? "No contracts yet" : "Nothing here"}</p>
              <p className="mt-1 text-sm text-ink-3">
                {contracts.length === 0 ? "Describe a deal and the AI drafts the first one." : "No contracts match this filter."}
              </p>
              {contracts.length === 0 ? (
                <Link href="/" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-2">
                  Draft a contract <IconArrowRight size={15} />
                </Link>
              ) : null}
            </div>
          ) : (
            <>
              {/* From 4xl the list is split into two tables side by side, read down the first and then the second. */}
              <div className="grid gap-3 max-md:hidden 3xl:flex-1 4xl:grid-cols-2">
                {columnsOf(shown, splitList ? 2 : 1).map((rows, i) => (
                  <div key={i} className="self-start overflow-hidden border border-rule bg-surface 3xl:self-stretch">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-rule bg-surface-2">
                      <tr>
                        <th scope="col" className="label px-4 py-2">Contract</th>
                        <th scope="col" className="label px-3 py-2">Track</th>
                        <th scope="col" className="label px-3 py-2 text-right">Amount</th>
                        <th scope="col" className="label px-3 py-2">Payer → Worker</th>
                        <th scope="col" className="label px-3 py-2">Deadline</th>
                        <th scope="col" className="label px-4 py-2 text-right">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {rows.map((c) => {
                        const overdue = !CLOSED.includes(c.state) && now !== null && Date.parse(c.deadline_at) < now;
                        const money = MONEY_WORD[c.state];
                        return (
                          <tr key={c.id} className="group relative transition-colors duration-100 hover:bg-surface-2">
                            <td className="max-w-0 px-4 py-2.5 lg:w-[34%]">
                              <Link href={`/contracts/${c.id}`} className="flex items-center gap-3 after:absolute after:inset-0">
                                <TypeIcon type={c.type} />
                                <span className="min-w-0">
                                  <span className="block truncate font-semibold text-ink group-hover:underline">{c.title}</span>
                                  <span className="block tnum text-[0.66rem] text-ink-3">
                                    {CONTRACT_TYPE_META[c.type].short} · <span className="normal-case">{shortId(c.id)}</span>
                                  </span>
                                </span>
                              </Link>
                            </td>
                            <td className="px-3 py-2.5">
                              <MicroTrack state={c.state} />
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className="block tnum text-[0.8125rem] font-semibold text-ink">{formatCents(c.amount_cents, c.currency)}</span>
                              <span className={cx("block text-[0.68rem] whitespace-nowrap", money.tone === "neutral" ? "text-ink-3" : TONE_TEXT[money.tone])}>
                                {money.label}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">
                              <span className="inline-flex items-center gap-1.5">
                                <RoleMark role="payer" />
                                {name(c.payer_email)}
                              </span>
                              <span className="mx-1.5 text-ink-3">→</span>
                              <span className="inline-flex items-center gap-1.5">
                                <RoleMark role="worker" />
                                {name(c.worker_email)}
                              </span>
                            </td>
                            <td className={cx("px-3 py-2.5 tnum text-[0.72rem] whitespace-nowrap", overdue ? "font-semibold text-fail" : "text-ink-2")}>
                              <RelativeTime iso={c.deadline_at} />
                            </td>
                            <td className="px-4 py-2.5 text-right tnum text-[0.72rem] whitespace-nowrap text-ink-3">
                              <RelativeTime iso={c.updated_at} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                ))}
              </div>

              <div className="overflow-hidden border border-rule bg-surface md:hidden">

              <ul className="divide-y divide-rule">
                {shown.map((c) => {
                  const money = MONEY_WORD[c.state];
                  return (
                    <li key={c.id}>
                      <Link href={`/contracts/${c.id}`} className="flex flex-col gap-2 px-3.5 py-3 active:bg-surface-2">
                        <div className="flex items-start justify-between gap-3">
                          <span className="flex min-w-0 items-start gap-2.5">
                            <TypeIcon type={c.type} />
                            <span className="font-semibold text-ink">{c.title}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block tnum text-[0.8125rem] font-semibold text-ink">{formatCents(c.amount_cents, c.currency)}</span>
                            <span className={cx("block text-[0.68rem]", money.tone === "neutral" ? "text-ink-3" : TONE_TEXT[money.tone])}>{money.label}</span>
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 pl-[2.375rem]">
                          <MicroTrack state={c.state} />
                          <span className="tnum text-[0.68rem] text-ink-3">
                            due <RelativeTime iso={c.deadline_at} />
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              </div>
            </>
          )}
        </>
      ) : null}
      </div>
      </div>
    </div>
  );
}

/** Splits rows into `n` consecutive runs of near-equal length, for tables read one after the other. */
function columnsOf<T>(rows: T[], n: number): T[][] {
  const size = Math.ceil(rows.length / n);
  return Array.from({ length: n }, (_, i) => rows.slice(i * size, (i + 1) * size)).filter((r) => r.length > 0);
}

function Stat({ label, value, note, tone = "text-ink" }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <div className="border-rule px-4 py-2.5 not-last:border-r max-sm:nth-2:border-r-0 max-sm:nth-[-n+2]:border-b 3xl:not-last:border-r-0 3xl:not-last:border-b">
      <dt className="label">{label}</dt>
      <dd className={cx("mt-0.5 tnum text-[1.125rem] leading-6 font-semibold text-ink", tone && "")}>{value}</dd>
      <dd className="text-[0.7rem] text-ink-3">{note}</dd>
    </div>
  );
}

function TypeIcon({ type }: { type: Contract["type"] }) {
  const Icon = type === "code_bounty" ? IconCode : IconGlobe;
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-inset text-ink-2 ring-1 ring-rule ring-inset" title={CONTRACT_TYPE_META[type].label}>
      <Icon size={15} />
    </span>
  );
}

function ListSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-2 rounded-lg border border-rule bg-surface p-4" aria-busy="true" aria-label="Loading contracts">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 rounded-xs bg-inset" />
      ))}
    </div>
  );
}
