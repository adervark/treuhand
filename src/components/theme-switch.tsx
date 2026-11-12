"use client";

/** System / Light / Dark. The choice persists in a cookie; "System" follows the OS. */
import { useState } from "react";
import { IconMonitor, IconMoon, IconSun } from "./icons";
import { applyTheme, type ThemeChoice } from "./theme";
import { cx } from "./ui";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof IconSun }[] = [
  { value: "system", label: "Follow system theme", Icon: IconMonitor },
  { value: "light", label: "Light theme", Icon: IconSun },
  { value: "dark", label: "Dark theme", Icon: IconMoon },
];

export function ThemeSwitch({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);
  return (
    <div role="group" aria-label="Theme" className="flex divide-x divide-rule border border-rule bg-inset">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => {
              setChoice(value);
              applyTheme(value);
            }}
            className={cx(
              "grid size-7 place-items-center transition-colors duration-100",
              active ? "bg-accent-fill text-accent-on" : "text-ink-3 hover:text-ink",
            )}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
