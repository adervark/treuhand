/**
 * Proviso's mark: a square in the accent with a check, the shape a met
 * condition takes on the track, so the brand is the product's own vocabulary.
 * The favicon (src/app/icon.svg, favicon.ico), the app icon and the Open Graph
 * image draw the same mark.
 */
export function BrandMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="3" className="fill-accent-fill" />
      <path d="M8.5 16.5 L13.5 21.5 L23.5 10.5" fill="none" className="stroke-accent-on" strokeWidth="4" strokeLinecap="square" />
    </svg>
  );
}

/** The mark's colours as plain values, for images drawn outside the page (icons, the Open Graph image). */
export const BRAND = { accent: "#3d5afe", on: "#ffffff", paper: "#0b0b0c", surface: "#161617", head: "#2c2c2e", rule: "#2a2a2c", ink: "#e8e8e8", ink2: "#bdbdbd", ink3: "#959595", paid: "#3cc472", paidOn: "#00170a", held: "#f5a524", machine: "#3fc5de", alarm: "#ff5a5f" } as const;
