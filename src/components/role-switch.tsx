/**
 * "View as Payer / Worker". A plain form posting to the `setViewAs` server
 * action, so it works before hydration. The active role is filled in its
 * colour and carries its letter mark, so a screen recording shows the switch
 * at a glance and the roles never depend on colour alone.
 */
import { setViewAs } from "@/app/actions";
import type { Identity, Party } from "@/lib/types";
import { RoleMark } from "./role-mark";
import { cx } from "./ui";

const ROLE_STYLE: Record<Party, { active: string; label: string }> = {
  payer: { active: "bg-payer-fill text-payer-on", label: "Payer" },
  worker: { active: "bg-worker-fill text-worker-on", label: "Worker" },
};

export function RoleSwitch({ role, identities }: { role: Party; identities: Identity[] }) {
  return (
    <form action={setViewAs} className="flex items-center gap-2.5">
      <span className="label hidden md:inline" id="view-as-label">
        Viewing as
      </span>
      <div role="group" aria-labelledby="view-as-label" className="flex border border-rule bg-inset">
        {(["payer", "worker"] as const).map((r) => {
          const identity = identities.find((i) => i.role === r);
          const active = role === r;
          const style = ROLE_STYLE[r];
          return (
            <button
              key={r}
              type="submit"
              name="role"
              value={r}
              aria-pressed={active}
              title={identity ? `${identity.display_name} <${identity.email}>` : undefined}
              className={cx(
                "flex h-8 items-center gap-2 border-l border-rule px-2.5 text-[0.8125rem] font-semibold transition-colors duration-100 first:border-l-0 sm:px-3",
                active ? style.active : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <RoleMark role={r} active={active} />
              <span>{style.label}</span>
              {identity ? (
                <span className={cx("hidden font-normal lg:inline", active ? "opacity-85" : "text-ink-3")}>{identity.display_name}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </form>
  );
}
