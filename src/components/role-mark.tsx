/** A role's letter mark (P / W) in its colour, so a role never depends on colour alone. */
import type { Party } from "@/lib/types";
import { cx } from "./ui";

const MARK: Record<Party, { letter: string; idle: string; active: string }> = {
  payer: { letter: "P", idle: "bg-payer-soft text-payer ring-1 ring-inset ring-payer/60", active: "bg-payer-on text-payer-fill" },
  worker: { letter: "W", idle: "bg-worker-soft text-worker ring-1 ring-inset ring-worker/60", active: "bg-worker-on text-worker-fill" },
};

export function RoleMark({
  role,
  active = false,
  size = "sm",
  className,
}: {
  role: Party;
  active?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const m = MARK[role];
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-xs tnum leading-none font-bold",
        size === "sm" ? "size-[1.1rem] text-[0.62rem]" : "size-6 text-[0.8rem]",
        active ? m.active : m.idle,
        className,
      )}
    >
      {m.letter}
    </span>
  );
}
