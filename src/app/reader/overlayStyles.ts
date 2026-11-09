import type { CSSProperties } from "react";

/**
 * Shared inline presentation for the reader shell + right-panel sidebar, lifted
 * out of Reader.tsx during the M9 overlay split. The annotation OVERLAYS
 * (selection toolbar, highlight edit popover, offloaded citation popover, the
 * association/context menus) no longer live here: their static presentation
 * moved to semantic CSS classes in theme.css (see .ito-selection-toolbar,
 * .ito-highlight-popover, .ito-offloaded-popover, etc.). Only the shell/sidebar
 * style blocks that Reader.tsx and AnnotationSidebar.tsx still consume remain,
 * and they are re-exported from AnnotationOverlays.tsx so every existing import
 * keeps resolving.
 */
export const styles: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.5rem 1rem",
    borderBottom: "1px solid #ddd",
    background: "#fafafa",
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  main: { flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "stretch" },
  pane: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    borderRight: "1px solid #eee",
  },
  paneScroll: { flex: 1, minHeight: 0, overflow: "auto", padding: "8px 12px 32px" },
  divider: {
    flex: "0 0 8px",
    cursor: "col-resize",
    background: "#e6e6e6",
    borderLeft: "1px solid #d4d4d4",
    borderRight: "1px solid #d4d4d4",
    alignSelf: "stretch",
  },
  responsiveStub: {
    padding: "0.75rem 1rem",
    margin: "0.5rem",
    background: "#fff4e5",
    border: "1px solid #f0c38a",
    borderRadius: "6px",
    color: "#7a4b00",
    fontSize: "0.85rem",
  },
  paneHeader: {
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: "6px",
    overflowX: "auto",
    margin: 0,
    padding: "4px 12px",
  },
  rangeSelector: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    padding: "0.5rem",
    background: "#eef4ff",
    borderRadius: "6px",
    marginBottom: "0.5rem",
  },
  mount: { position: "relative" },
  scopeStatus: {
    padding: "0.5rem 0.75rem",
    margin: "0 0 0.5rem",
    background: "#fff4e5",
    border: "1px solid #f0c38a",
    borderRadius: "6px",
    color: "#7a4b00",
    fontSize: "0.82rem",
  },
  findBar: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    borderBottom: "1px solid var(--ito-border, #dcd6c8)",
    background: "var(--ito-bg-elevated, #fff)",
  },
  websiteBadge: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.4rem",
    borderRadius: "4px",
    background: "#e6f0fb",
    color: "#2c4a6f",
  },
  websiteSnapshot: {
    maxWidth: "100%",
    padding: "0.5rem",
    background: "#fff",
    lineHeight: 1.5,
    userSelect: "text",
  },
  sidebar: {
    width: "20rem",
    minWidth: "20rem",
    borderLeft: "1px solid #ddd",
    padding: "1rem",
    overflow: "auto",
    background: "#fcfcfc",
  },
  fixedLayer: { position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: 1000 },
  returnNotice: {
    padding: "0.5rem 1rem",
    background: "#fff4e5",
    borderBottom: "1px solid #f0c38a",
    color: "#7a4b00",
    fontSize: "0.85rem",
  },
};
