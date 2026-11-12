"use client";

/**
 * The verdict moment. Verdicts that arrive while the page is open are played in
 * one at a time, in the order of the tests, instead of all at once: a test
 * decided by code lands on its turn; a test judged by a review panel shows its
 * reviewers' votes one by one and only then its result. Verdicts already there
 * when the page opened, and everything under reduced motion, show at once.
 *
 * Nothing is shown before the API has reported it: this only holds a verdict
 * back for a moment after it arrives. Each verdict plays once (by its id), so a
 * re-run plays again and a poll that returns the same verdicts does not.
 *
 * `playing` is true while any verdict is still held back or being voted on:
 * the contract page holds the rest of the page on what it showed before those
 * verdicts arrived until it is false (contract-view.tsx), so no panel announces
 * a result the run log has not shown yet.
 */
import { useEffect, useState } from "react";
import { useReducedMotion } from "../use-reduced-motion";
import { readPanel } from "./review-panel";
import type { ConditionRow } from "./verdicts";

/** Between one test's result and the next test's turn. */
const TURN_MS = 650;
/** At most this long for the turns of one batch of verdicts, however many tests it has, so a reveal stays short. */
const BATCH_TURNS_MS = 2600;
/** Between one reviewer's vote and the next. */
const VOTE_MS = 700;
/** Between the last vote and the panel's result. */
const RESULT_MS = 550;

interface Slot {
  start: number;
  done: number;
  votes: number;
}

function boundaries(s: Slot): number[] {
  const out = [s.start, s.done];
  for (let k = 1; k <= s.votes; k++) out.push(s.start + k * VOTE_MS);
  return out;
}

/**
 * `rows` as the run log shows them now, and whether a reveal is playing. `verdictIds` is every verdict id in the
 * bundle (all attempts), or null until the bundle has loaded: what is there when it loads is shown at once.
 */
export function useStagedRows(rows: ConditionRow[], verdictIds: string[] | null): { rows: ConditionRow[]; playing: boolean } {
  const reduced = useReducedMotion();
  // Verdict ids present when the page opened (null until the first effect has run).
  const [known, setKnown] = useState<ReadonlySet<string> | null>(null);
  const [plan, setPlan] = useState<ReadonlyMap<string, Slot>>(new Map());
  const [now, setNow] = useState(0);

  // Plan newly arrived verdicts, in test order, each after the one before.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (known === null) {
        if (verdictIds) setKnown(new Set(verdictIds));
        return;
      }
      const fresh = rows.filter((r) => r.verdict && !known.has(r.verdict.id) && !plan.has(r.verdict.id));
      if (fresh.length === 0) return;
      const t = Date.now();
      if (reduced) {
        setKnown(new Set([...known, ...fresh.map((r) => r.verdict!.id)]));
        return;
      }
      const turn = Math.min(TURN_MS, Math.round(BATCH_TURNS_MS / fresh.length));
      let at = Math.max(t, ...[...plan.values()].map((s) => s.done + turn));
      const next = new Map(plan);
      for (const r of fresh) {
        const votes = readPanel(r.verdict!.evidence)?.reviewers.length ?? 0;
        const slot = { start: at, done: votes > 0 ? at + votes * VOTE_MS + RESULT_MS : at, votes };
        next.set(r.verdict!.id, slot);
        at = slot.done + turn;
      }
      setPlan(next);
      setNow(t);
    }, 0);
    return () => clearTimeout(timer);
  }, [rows, verdictIds, known, plan, reduced]);

  // Re-render at the next moment something changes on screen.
  useEffect(() => {
    const upcoming = [...plan.values()].flatMap(boundaries).filter((b) => b > now);
    if (upcoming.length === 0) return;
    const wait = Math.max(0, Math.min(...upcoming) - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [plan, now]);

  if (known === null) return { rows, playing: false };
  // Under reduced motion nothing is held back, not even for the moment before the effect above has run.
  const shown = reduced ? new Set([...known, ...rows.flatMap((r) => (r.verdict ? [r.verdict.id] : []))]) : known;
  const playing = rows.some((r) => {
    if (!r.verdict || shown.has(r.verdict.id)) return false;
    const slot = plan.get(r.verdict.id);
    return !slot || now < slot.done;
  });
  return { rows: stage(rows, shown, plan, now), playing };
}

/** The rows as they should read at `now`: held-back verdicts as still to come, a voting panel as still checking. */
function stage(rows: ConditionRow[], known: ReadonlySet<string>, plan: ReadonlyMap<string, Slot>, now: number): ConditionRow[] {
  const out: ConditionRow[] = [];
  let checking = false;
  for (const r of rows) {
    const v = r.verdict;
    let staged: ConditionRow = r;
    if (v && !known.has(v.id)) {
      const slot = plan.get(v.id);
      if (!slot || now < slot.start) staged = { condition: r.condition, verdict: null, outcome: "queued" };
      else if (now < slot.done) staged = { ...r, outcome: "checking", voting: Math.min(slot.votes, Math.floor((now - slot.start) / VOTE_MS)) };
    }
    // One test is checked at a time: the first one being checked or held back shows as checking, the rest as queued.
    const pending = staged.outcome === "checking" || (staged !== r && staged.outcome === "queued");
    if (!pending) out.push(staged);
    else if (checking) out.push({ condition: r.condition, verdict: null, outcome: "queued" });
    else {
      checking = true;
      out.push({ ...staged, outcome: "checking" });
    }
  }
  return out;
}
