import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "@/components/brand";

// The image a shared link shows: the mark and name, the headline, the one sentence, and the home page's
// example run in its final state, drawn in the terminal's dark theme and its typeface (IBM Plex Sans, OFL,
// src/assets/fonts). Static: generated once at build.
export const alt = "Treuhand: contracts that pay themselves. An example run in which four tests pass and PayPal pays out $400.00.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TESTS = ["The site loads at a public URL", "Works at phone width (375px)", "A visitor can tell what the bakery sells", "Sign-up form confirms the address"];

const font = (file: string) => readFile(join(process.cwd(), "src/assets/fonts", file));

function Pass() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, height: 26, padding: "0 9px", borderRadius: 3, background: BRAND.paid, color: BRAND.paidOn, fontSize: 15, fontWeight: 600, letterSpacing: 0.6 }}>
      {/* drawn, not a glyph, like the check in the mark */}
      <svg width="12" height="12" viewBox="0 0 32 32">
        <path d="M5 17 L13 25 L27 8" fill="none" stroke={BRAND.paidOn} strokeWidth="5" strokeLinecap="square" />
      </svg>
      PASS
    </div>
  );
}

export default async function OpengraphImage() {
  const [regular, semibold] = await Promise.all([font("IBMPlexSans-Regular.ttf"), font("IBMPlexSans-SemiBold.ttf")]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: BRAND.paper, color: BRAND.ink, padding: "52px 60px", borderTop: `6px solid ${BRAND.accent}`, fontFamily: "Plex" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <svg width="40" height="40" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="3" fill={BRAND.accent} />
            <path d="M8.5 16.5 L13.5 21.5 L23.5 10.5" fill="none" stroke={BRAND.on} strokeWidth="4" strokeLinecap="square" />
          </svg>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 600, letterSpacing: -0.4 }}>Treuhand</div>
        </div>
        <div style={{ display: "flex", flex: 1, gap: 48, alignItems: "center", paddingBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", width: 448 }}>
            <div style={{ display: "flex", fontSize: 54, fontWeight: 600, lineHeight: 1.1, letterSpacing: -1 }}>Contracts that pay themselves</div>
            <div style={{ display: "flex", marginTop: 26, fontSize: 25, lineHeight: 1.45, color: BRAND.ink2 }}>
              Describe a job in plain English; an AI turns it into tests both sides sign, PayPal holds the money, and the worker is paid when
              every test passes.
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, border: `1px solid ${BRAND.rule}`, background: BRAND.surface }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 20px", background: BRAND.head, fontSize: 15, fontWeight: 600, letterSpacing: 0.8 }}>
              <div style={{ display: "flex", color: BRAND.ink2 }}>EXAMPLE RUN · WEBSITE MILESTONE</div>
              <div style={{ display: "flex", color: BRAND.paid, letterSpacing: 0 }}>All 4 passed</div>
            </div>
            {TESTS.map((t, i) => (
              <div key={t} style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 20px", borderTop: i ? `1px solid ${BRAND.rule}` : "none", fontSize: 20 }}>
                <div style={{ display: "flex", color: BRAND.ink3, width: 12 }}>{i + 1}</div>
                <Pass />
                <div style={{ display: "flex", fontWeight: 600 }}>{t}</div>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "15px 20px", borderTop: `1px solid ${BRAND.rule}`, fontSize: 18, fontWeight: 600 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <span style={{ color: BRAND.held }}>Held by PayPal</span>
                <span style={{ color: BRAND.ink3 }}>—</span>
                <span style={{ color: BRAND.held }}>Captured</span>
                <span style={{ color: BRAND.ink3 }}>—</span>
                <span style={{ color: BRAND.paid }}>Paid out</span>
              </div>
              <div style={{ display: "flex", color: BRAND.paid, fontSize: 26 }}>$400.00</div>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Plex", data: regular, style: "normal", weight: 400 },
        { name: "Plex", data: semibold, style: "normal", weight: 600 },
      ],
    },
  );
}
