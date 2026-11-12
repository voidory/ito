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
  plus: (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  copy: (
    <Svg>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </Svg>
  ),
  open: (
    <Svg>
      <path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
    </Svg>
  ),
  upload: (
    <Svg>
      <path d="M8 10.5V3M5 6l3-3 3 3M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
    </Svg>
  ),
  globe: (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
    </Svg>
  ),
  files: (
    <Svg>
      <path d="M3.5 2.5h5l3 3v8h-8z" />
      <path d="M8.5 2.5v3h3" />
    </Svg>
  ),
  history: (
    <Svg>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4M2.5 3v3h3M8 5v3l2 1.5" />
    </Svg>
  ),
  inbox: (
    <Svg>
      <path d="M2.5 9l1.5-5h8l1.5 5v3.5h-11zM2.5 9h3.5l.5 1.5h3L10 9h3.5" />
    </Svg>
  ),
  reset: (
    <Svg>
      <path d="M3 8a5 5 0 1 1 1.6 3.7M3 12V8.5h3.5" />
    </Svg>
  ),
  panel: (
    <Svg>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </Svg>
  ),
} as const;
