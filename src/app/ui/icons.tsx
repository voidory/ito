import type { ReactNode } from "react";

/**
 * Small inline-SVG icon set shared by menus and toolbars. 16px, stroke-based,
 * `currentColor` so they follow the surrounding text/theme colour.
 */
function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icons = {
  comment: (
    <Svg>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </Svg>
  ),
  pencil: (
    <Svg>
      <path d="M10.5 3l2.5 2.5L5.5 13H3v-2.5z" />
    </Svg>
  ),
  link: (
    <Svg>
      <path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.6.6" />
      <path d="M9.2 6.8a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.6-.6" />
    </Svg>
  ),
  quote: (
    <Svg>
      <path d="M3 5.5h3.5V9H4a1.5 1.5 0 0 0 1.5 2" />
      <path d="M9.5 5.5H13V9h-2.5A1.5 1.5 0 0 0 12 11" />
    </Svg>
  ),
  nodes: (
    <Svg>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="8" cy="12" r="1.6" />
      <path d="M5.4 4.4l5.2.4M5 5.4l2.2 5.3M10.9 6.4L8.9 10.7" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8h6l.5-8" />
    </Svg>
  ),
  trashAll: (
    <Svg>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8h6l.5-8M6.7 7l2.6 3.2M9.3 7L6.7 10.2" />
    </Svg>
  ),
  area: (
    <Svg>
      <path d="M2.5 5.5V3.5a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2" />
    </Svg>
  ),
  swap: (
    <Svg>
      <path d="M3 5.5h9l-2-2M13 10.5H4l2 2" />
    </Svg>
  ),
  lines: (
    <Svg>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
    </Svg>
  ),
  motion: (
    <Svg>
      <path d="M3 8h2.5l1.5-4 2 8 1.5-4H13" />
    </Svg>
  ),
  search: (
    <Svg>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </Svg>
  ),
  fitWidth: (
    <Svg>
      <path d="M2.5 8h11M4.5 5.5L2.5 8l2 2.5M11.5 5.5l2 2.5-2 2.5" />
    </Svg>
  ),
} as const;
