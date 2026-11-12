"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const LINKS = [
  { href: "/", label: "New contract", short: "New", match: (p: string) => p === "/" },
  { href: "/contracts", label: "Contracts", match: (p: string) => p.startsWith("/contracts") },
  { href: "/ledger", label: "Ledger", match: (p: string) => p.startsWith("/ledger") },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="flex items-stretch gap-0.5 self-stretch">
      {LINKS.map((link) => {
        const active = link.match(pathname);
        return (
          <li key={link.href} className="flex">
            <Link
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "relative flex items-center px-2.5 text-[0.75rem] font-medium whitespace-nowrap uppercase transition-colors duration-100 sm:px-3",
                "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:transition-colors",
                active ? "text-ink after:bg-accent-fill" : "text-ink-3 after:bg-transparent hover:text-ink",
              )}
            >
              {"short" in link ? (
                <>
                  <span className="sm:hidden">{link.short}</span>
                  <span className="max-sm:hidden">{link.label}</span>
                </>
              ) : (
                link.label
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
