/**
 * Line icons drawn for Clause (24px grid, 1.75 stroke). Decorative by
 * default: pass `title` to make one meaningful to screen readers.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { title?: string; size?: number };

function Svg({ title, size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.2 4.2L19 7" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconQuestion = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.3 9.2a2.8 2.8 0 015.4 1c0 1.9-2.7 2.4-2.7 4.1" />
    <path d="M12 17.6v.1" strokeWidth={2.4} />
  </Svg>
);

export const IconCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6.5" strokeDasharray="2.6 2.6" />
  </Svg>
);

export const IconScan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16" />
    <path d="M4 12h16" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
  </Svg>
);

/** A safe: money captured into Treuhand's PayPal balance, waiting to pay out. */
export const IconSafe = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="16" height="14" rx="1.5" />
    <circle cx="12" cy="11.5" r="3" />
    <path d="M12 8.5v1M12 13.5v1M7 18.5V20.5M17 18.5V20.5" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l1.9 5.2a2 2 0 001.2 1.2l5.2 1.9-5.2 1.9a2 2 0 00-1.2 1.2L12 20.1l-1.9-5.2a2 2 0 00-1.2-1.2L3.7 11.8l5.2-1.9a2 2 0 001.2-1.2z" />
  </Svg>
);

export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5z" />
  </Svg>
);

export const IconPen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20l1-4.2L15.6 5.2a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.2 19 4 20z" />
    <path d="M13.5 7.3l3.2 3.2" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l.8 12a1.5 1.5 0 001.5 1.4h6.4a1.5 1.5 0 001.5-1.4l.8-12" />
  </Svg>
);

export const IconScale = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v16M7 20h10M5 7h14" />
    <path d="M5 7l-2.5 6a3 3 0 005 0L5 7zM19 7l-2.5 6a3 3 0 005 0L19 7z" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8.5 8" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 8A8 8 0 005 9.5M4.5 16A8 8 0 0019 14.5" />
    <path d="M19.5 3.5V8H15M4.5 20.5V16H9" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z" />
    <path d="M12 8.5v4.2" />
    <path d="M12 15.6v.1" strokeWidth={2.4} />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.75" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.2A7.8 7.8 0 019.8 4.5a7.8 7.8 0 109.7 9.7z" />
  </Svg>
);

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);

export const IconReturn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 8L4.5 12.5 9 17" />
    <path d="M4.5 12.5H15a4.5 4.5 0 000-9h-2" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4l9 16H3l9-16z" />
    <path d="M12 10v4.5" />
    <path d="M12 17.4v.1" strokeWidth={2.4} />
  </Svg>
);
