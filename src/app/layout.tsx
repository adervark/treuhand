import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { NavLinks } from "@/components/nav-links";
import { RoleSwitch } from "@/components/role-switch";
import { RoleSync } from "@/components/role-sync";
import { THEME_COOKIE, type ThemeChoice } from "@/components/theme-cookie";
import { ThemeSwitch } from "@/components/theme-switch";
import { listIdentities } from "@/lib/db/identities";
import { getViewerRole } from "@/lib/viewer";
import "./globals.css";

// One reading face for text and figures (tabular digits), and a mono kept for
// identifiers and raw machine output (docs/design.md, Typography).
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const DESCRIPTION =
  "Contracts that pay themselves: describe a job in plain English, an AI turns it into tests both sides sign, PayPal holds the money, and the worker is paid when every test passes.";

export const metadata: Metadata = {
  // Absolute URLs for the Open Graph image: the deployed address on Render, this machine otherwise.
  metadataBase: new URL(process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`),
  title: { default: "Treuhand · contracts that pay themselves", template: "%s · Treuhand" },
  description: DESCRIPTION,
  applicationName: "Treuhand",
  openGraph: { type: "website", siteName: "Treuhand", title: "Treuhand · contracts that pay themselves", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Treuhand · contracts that pay themselves", description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6e7e9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const role = await getViewerRole();
  const identities = listIdentities();
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: ThemeChoice = stored === "light" || stored === "dark" ? stored : "system";

  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      data-viewer={role}
      data-theme={theme === "system" ? undefined : theme}
    >
      <body className="flex min-h-full flex-col">
        <header className={`sticky top-0 z-30 border-b border-rule bg-paper role-band-${role}`}>
          <div className="flex w-full flex-wrap items-stretch justify-between gap-x-4 gap-y-1 px-4 sm:px-6 3xl:px-8">
            <div className="flex min-h-11 items-stretch gap-3 pt-0.5 sm:gap-6">
              <Link href="/" className="flex items-center gap-2 text-[0.9375rem] font-bold tracking-[-0.01em] text-ink" aria-label="Treuhand home">
                <BrandMark />
                Treuhand
              </Link>
              <nav aria-label="Main" className="flex">
                <NavLinks />
              </nav>
            </div>
            <div className="flex items-center gap-2 pt-0.5 pb-2 sm:gap-3 md:pb-0">
              <RoleSwitch role={role} identities={identities} />
              <RoleSync role={role} />
              <ThemeSwitch initial={theme} />
            </div>
          </div>
        </header>
        <main className="w-full flex-1 px-4 py-5 sm:px-6 sm:py-6 3xl:px-8">{children}</main>
        <footer className="border-t border-rule">
          <div className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-[0.75rem] text-ink-3 sm:px-6 3xl:px-8">
            <span>Treuhand · contracts that pay themselves</span>
            <span>PayPal sandbox · no real money moves</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
