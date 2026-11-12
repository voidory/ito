import { useCallback, useEffect, useState } from "react";
import { ContextMenuSurface, type ContextMenuEntry } from "./ui/ContextMenu";
import { Icons } from "./ui/icons";

/**
 * App-wide right-click menu. The browser's default menu ("Back / Reload / View
 * source…") is never useful in this app, so outside editable text we replace it
 * with a short list that depends on WHAT was clicked:
 *
 *  - the PDF page keeps its own richer menu (it prevents default first, so this
 *    layer steps aside);
 *  - text inputs / the page editor keep the native menu (cut / copy / paste /
 *    spell-check), which a custom list cannot replicate;
 *  - everywhere else: view-specific actions, then "Go to…" navigation.
 *
 * Actions are routed through the SAME visible controls (by data-testid) so a
 * menu item can never drift from what the button does or bypass its guards.
 */

function press(testId: string): void {
  (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null)?.click();
}

/**
 * Open a node's page the way the canvas does. A click on a node only SELECTS it
 * (select-then-open); the node then offers its own "Open page" control. So:
 * select it, wait for that control to render, and press it — the same path as
 * the visible button, including its camera dive and workspace switch.
 */
function openNodePage(node: Element): void {
  (node.querySelector("circle") as unknown as HTMLElement | null)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  let frames = 0;
  const tryOpen = (): void => {
    const open = node.querySelector(".node-open-page") as unknown as HTMLElement | null;
    if (open) {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return;
    }
    if (++frames < 30) requestAnimationFrame(tryOpen);
  };
  requestAnimationFrame(tryOpen);
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest("input, textarea, select, [contenteditable='true'], .ProseMirror")) return true;
  return false;
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly entries: readonly ContextMenuEntry[];
  readonly label: string;
}

function navEntries(): ContextMenuEntry[] {
  return [
    { kind: "label", id: "h-go", label: "Go to" },
    { id: "go-files", label: "Files", icon: Icons.files, onSelect: () => press("view-files") },
    { id: "go-nodes", label: "Nodes", icon: Icons.nodes, onSelect: () => press("view-nodes") },
    { id: "go-history", label: "History", icon: Icons.history, onSelect: () => press("view-history") },
    { id: "go-captures", label: "Captures", icon: Icons.inbox, onSelect: () => press("view-captures") },
  ];
}

/** Build the entries for a right-click on `target`. Exported for tests. */
export function buildContextEntries(target: Element, selectedText: string): {
  entries: ContextMenuEntry[];
  label: string;
} {
  const entries: ContextMenuEntry[] = [];
  let label = "Actions";

  if (selectedText) {
    entries.push({
      id: "copy",
      label: "Copy",
      icon: Icons.copy,
      shortcut: "Ctrl C",
      onSelect: () => void navigator.clipboard?.writeText(selectedText),
    });
    entries.push({ kind: "separator", id: "s-copy" });
  }

  const libraryRow = target.closest('[data-testid="library-item"]');
  const node = target.closest('[data-testid="graph-node"]');
  const hub = target.closest('[data-testid="graph-hub"]');

  if (libraryRow) {
    label = "Document actions";
    const id = libraryRow.getAttribute("data-source-id");
    entries.push({
      id: "doc-open",
      label: "Open",
      icon: Icons.open,
      onSelect: () => (libraryRow.querySelector('[data-testid="library-open"]') as HTMLElement | null)?.click(),
    });
    entries.push({
      id: "doc-select",
      label: "Select for “Open together”",
      icon: Icons.plus,
      onSelect: () => (libraryRow.querySelector('input[type="checkbox"]') as HTMLElement | null)?.click(),
    });
    entries.push({ kind: "separator", id: "s-doc" });
    entries.push({
      id: "doc-delete",
      label: "Delete…",
      icon: Icons.trash,
      danger: true,
      onSelect: () =>
        (document.querySelector(`[data-testid="delete-source"][data-source-id="${id}"]`) as HTMLElement | null)?.click(),
    });
    entries.push({ kind: "separator", id: "s-doc2" });
  } else if (target.closest('[data-testid="library"]')) {
    label = "Library actions";
    entries.push({ id: "lib-import", label: "Import PDF…", icon: Icons.upload, onSelect: () => press("import-pdf-btn") });
    entries.push({ id: "lib-web", label: "Add website…", icon: Icons.globe, onSelect: () => press("add-website") });
    entries.push({ id: "lib-zotero", label: "Import from Zotero…", icon: Icons.files, onSelect: () => press("import-zotero-btn") });
    entries.push({ kind: "separator", id: "s-lib" });
  } else if (node) {
    label = "Node actions";
    entries.push({
      id: "node-open",
      label: "Open page",
      icon: Icons.open,
      onSelect: () => openNodePage(node),
    });
    entries.push({ kind: "separator", id: "s-node" });
  } else if (hub) {
    label = "Connection actions";
    entries.push({
      id: "hub-open",
      label: "Open connecting page",
      icon: Icons.open,
      onSelect: () => {
        // A click on the hub itself only selects it; the explicit control opens.
        const rel = hub.getAttribute("data-relationship-id");
        (
          document.querySelector(`[data-testid="open-connecting-page"][data-relationship-id="${rel}"]`) as unknown as HTMLElement | null
        )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      },
    });
    entries.push({
      id: "hub-label",
      label: "Edit label…",
      icon: Icons.pencil,
      onSelect: () => {
        const rel = hub.getAttribute("data-relationship-id");
        (
          document.querySelector(`[data-testid="edit-hub-label"][data-relationship-id="${rel}"]`) as unknown as HTMLElement | null
        )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      },
    });
    entries.push({ kind: "separator", id: "s-hub" });
  } else if (target.closest('[data-testid="nodes-view"]')) {
    label = "Map actions";
    entries.push({ id: "map-subject", label: "New subject page", icon: Icons.plus, onSelect: () => press("nodes-create-subject-btn") });
    entries.push({ id: "map-category", label: "New category", icon: Icons.plus, onSelect: () => press("nodes-create-category-btn") });
    entries.push({ id: "map-connect", label: "Connect nodes", icon: Icons.link, onSelect: () => press("nodes-connect-mode-btn") });
    entries.push({ kind: "separator", id: "s-map" });
    entries.push({ id: "map-reset", label: "Reset view", icon: Icons.reset, onSelect: () => press("canvas-zoom-reset") });
    entries.push({ kind: "separator", id: "s-map2" });
  } else if (target.closest('[data-testid="reader"]')) {
    label = "Reader actions";
    entries.push({ id: "rd-back", label: "Back to Library", icon: Icons.files, onSelect: () => press("back-to-library") });
    entries.push({ id: "rd-annots", label: "Show / hide annotations", icon: Icons.panel, onSelect: () => press("toggle-highlights-tab") });
    entries.push({ id: "rd-thumbs", label: "Show / hide thumbnails", icon: Icons.panel, onSelect: () => press("toggle-left-sidebar") });
    entries.push({ id: "rd-fit", label: "Fit width", icon: Icons.fitWidth, onSelect: () => press("fit-width") });
    entries.push({ kind: "separator", id: "s-rd" });
  }

  entries.push(...navEntries());
  return { entries, label };
}

export function AppContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      // A surface that already handled it (the PDF page menu) wins.
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      // Native menu stays for editable text (cut/copy/paste/spellcheck).
      if (isEditable(target)) return;
      // Our own menu: just suppress the browser's.
      if (target.closest(".ito-ctx-menu")) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const sel = window.getSelection()?.toString().trim() ?? "";
      const { entries, label } = buildContextEntries(target, sel);
      setMenu({ x: e.clientX, y: e.clientY, entries, label });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!menu) return null;
  return (
    <ContextMenuSurface
      x={menu.x}
      y={menu.y}
      entries={menu.entries}
      ariaLabel={menu.label}
      onClose={close}
    />
  );
}
