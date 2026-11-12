import { connection } from "next/server";
import { Composer } from "@/components/composer";
import { ExampleRun } from "@/components/example-run";
import { cx } from "@/components/ui";
import { listIdentities } from "@/lib/db/identities";

const STEPS: { n: string; title: string; body: string; who: string; tone: string; mark: string; num: string }[] = [
  {
    n: "1",
    title: "Draft",
    body: "The AI turns your sentence into tests a machine can check, and refuses the ones it can't. Both sides edit and sign.",
    who: "AI proposes, people decide",
    tone: "text-machine",
    mark: "bg-machine-fill",
    num: "3xl:bg-machine-fill 3xl:text-machine-on",
  },
  {
    n: "2",
    title: "Fund",
    body: "The payer approves with PayPal. The money is held on their account, not charged.",
    who: "PayPal holds",
    tone: "text-held",
    mark: "bg-held-fill",
    num: "3xl:bg-held-fill 3xl:text-held-on",
  },
  {
    n: "3",
    title: "Verify",
    body: "The worker submits a link. The AI opens it, runs every test and records its evidence.",
    who: "AI judges",
    tone: "text-machine",
    mark: "bg-machine-fill",
    num: "3xl:bg-machine-fill 3xl:text-machine-on",
  },
  {
    n: "4",
    title: "Settle",
    body: "Every test passes: PayPal pays the worker. The deadline passes first: the hold is released.",
    who: "PayPal pays",
    tone: "text-paid",
    mark: "bg-paid-fill",
    num: "3xl:bg-paid-fill 3xl:text-paid-on",
  },
];

export default async function Home() {
  await connection(); // better-sqlite3 is synchronous: read at request time, not at build
  const identities = listIdentities();

  const intro = (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[1.625rem] leading-[2rem] font-semibold text-ink 3xl:text-[2rem] 3xl:leading-[2.5rem]">Contracts that pay themselves</h1>
        <p className="mt-2 max-w-[38rem] text-[0.9375rem] leading-relaxed text-ink-2 3xl:text-[1rem]">
          Describe a job in plain English; an AI turns it into tests both sides sign, PayPal holds the money, and the worker is paid
          when every test passes.
        </p>
      </div>
      <ExampleRun />
    </div>
  );

  const outro = (
    // From 3xl the four steps are a rail down the column: numbered stops in each step's colour, joined by a line,
    // sharing the column's height between them (the state rail's idiom, docs/design.md 1.3).
    <section aria-labelledby="how-h" className="border border-rule bg-surface 3xl:flex 3xl:h-full 3xl:flex-col">
      <h2 id="how-h" className="panel-title border-b border-rule bg-head px-3 py-1.5">
        How a contract travels
      </h2>
      <ol className="grid sm:grid-cols-2 lg:grid-cols-4 3xl:flex 3xl:flex-1 3xl:flex-col 3xl:py-1.5">
        {STEPS.map((s) => (
          <li
            key={s.n}
            className="flex flex-col gap-1 border-rule px-3 py-3 max-sm:border-t sm:[&:nth-child(n+3)]:border-t lg:border-l lg:first:border-l-0 lg:[&:nth-child(n+3)]:border-t-0 3xl:relative 3xl:flex-1 3xl:border-l-0 3xl:gap-1.5 3xl:py-3.5 3xl:pr-4 3xl:pl-13 3xl:after:absolute 3xl:after:top-11 3xl:after:-bottom-3 3xl:after:left-[1.625rem] 3xl:after:w-0.5 3xl:after:-translate-x-1/2 3xl:after:bg-rule-strong 3xl:last:after:hidden"
          >
            <p className="flex flex-wrap items-baseline gap-x-2 text-[0.875rem] font-semibold text-ink 3xl:text-[1rem]">
              <span className={cx("tnum font-medium text-ink-3 3xl:absolute 3xl:top-3 3xl:left-3 3xl:grid 3xl:size-7 3xl:place-items-center 3xl:text-[0.875rem] 3xl:font-semibold", s.num)}>
                {s.n}
              </span>
              {s.title}
              <span className={cx("flex items-center gap-1.5 text-[0.72rem] font-medium 3xl:text-[0.75rem]", s.tone)}>
                <span className={cx("size-2 shrink-0", s.mark)} aria-hidden />
                {s.who}
              </span>
            </p>
            <p className="text-[0.8125rem] leading-relaxed text-ink-2 3xl:text-[0.875rem]">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );

  return <Composer intro={intro} outro={outro} identities={identities} />;
}
