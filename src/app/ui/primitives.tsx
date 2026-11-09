import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * M9 UI kit (handoff FEAT-001 B). A single file housing the four shared UI
 * primitives used across the reader chrome, the app header settings menu, and
 * the annotation surfaces:
 *
 *  - {@link Button} - the plain themed button (font:inherit via theme.css).
 *  - {@link IconButton} - an icon-only button that REQUIRES an aria-label and
 *    renders a native title tooltip; supports aria-pressed for toggles.
 *  - {@link Menu} - a keyboard-navigable menu (arrow keys / Enter / Esc) with
 *    optional per-item icons and a right-aligned shortcut column. No centred
 *    outlined buttons: items are full-width left-aligned rows.
 *  - {@link Popover} - a surface portaled onto a fixed viewport layer with a
 *    z-index token, auto-flip + clamp-to-viewport (reusing {@link clampFixedAnchor}),
 *    closing on an outside click and on Esc.
 *
 * All four are presentation-only and carry NO workbench/data knowledge.
 */

/** A viewport-space anchor rectangle used to position a {@link Popover}. */
export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
}

/**
 * Clamp an anchor rect into viewport-space fixed coordinates for a floating
 * surface of a given width. The surface is centred over the anchor and clamped
 * 12px from each viewport edge; it sits above the anchor when there is room
 * (anchorTop > 64) and otherwise flips to just below it.
 *
 * This is the exact formula the reader has always used for its fixed surfaces;
 * it lives here now so every primitive clamps identically.
 */
export function clampFixedAnchor(
  rect: AnchorRect,
  surfaceWidth: number,
): { left: number; top: number } {
  const viewportWidth = (typeof window !== "undefined" && window.innerWidth) || 1024;
  const anchorCenterX = rect.left + rect.width / 2;
  const left = Math.max(
    12,
    Math.min(anchorCenterX - surfaceWidth / 2, viewportWidth - surfaceWidth - 12),
  );
  const top = rect.top > 64 ? rect.top - 48 : rect.bottom + 12;
  return { left, top };
}

/** Allow arbitrary `data-*` attributes on the primitive buttons. */
type DataAttrs = { [key: `data-${string}`]: string | number | boolean | undefined };

/** A plain themed button. Font is inherited globally via theme.css. */
export function Button({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & DataAttrs): JSX.Element {
  return (
    <button
      type="button"
      className={["ito-ui-btn", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * An icon-only button. The {@link IconButton.props.label} is REQUIRED and is
 * surfaced both as the accessible name (aria-label) and the native tooltip
 * (title). `pressed` drives aria-pressed for toggle controls.
 */
export function IconButton({
  label,
  pressed,
  className,
  children,
  title,
  ...rest
}: {
  label: string;
  pressed?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> &
  DataAttrs): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={["ito-ui-icon-btn", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A single {@link Menu} entry. */
export interface MenuItem {
  /** Stable key + default testid suffix. */
  readonly id: string;
  /** The visible label. */
  readonly label: string;
  /** Optional leading icon (inline SVG / glyph). */
  readonly icon?: React.ReactNode;
  /** Optional right-aligned shortcut hint (e.g. "⌘F"). */
  readonly shortcut?: string;
  /** Invoked on activation; the menu closes afterwards. */
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Overrides the default `menu-item-<id>` testid. */
  readonly testId?: string;
}

/**
 * A keyboard-navigable menu. Arrow keys move the roving focus, Enter/Space
 * activates, Esc closes. Items are full-width left-aligned rows with an icon
 * gutter and a right-aligned shortcut column (NOT centred outlined buttons).
 */
export function Menu({
  items,
  onClose,
  ariaLabel,
  className,
  testId,
}: {
  items: readonly MenuItem[];
  onClose: () => void;
  ariaLabel: string;
  className?: string;
  testId?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const enabledIndexes = items
    .map((it, i) => (it.disabled ? -1 : i))
    .filter((i) => i >= 0);
  const [active, setActive] = useState<number>(enabledIndexes[0] ?? 0);

  // Focus the active item as the roving index moves.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`);
    el?.focus();
  }, [active]);

  const move = useCallback(
    (dir: 1 | -1): void => {
      if (enabledIndexes.length === 0) return;
      const pos = enabledIndexes.indexOf(active);
      const next =
        pos === -1
          ? enabledIndexes[0]!
          : enabledIndexes[(pos + dir + enabledIndexes.length) % enabledIndexes.length]!;
      setActive(next);
    },
    [active, enabledIndexes],
  );

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[active];
      if (it && !it.disabled) {
        it.onSelect();
        onClose();
      }
    }
  };

  return (
    <div
      ref={ref}
      data-testid={testId ?? "ito-menu"}
      role="menu"
      aria-label={ariaLabel}
      className={["ito-ui-menu", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          data-testid={it.testId ?? `menu-item-${it.id}`}
          data-menu-index={i}
          tabIndex={i === active ? 0 : -1}
          disabled={it.disabled}
          className="ito-ui-menu-item"
          onMouseEnter={() => !it.disabled && setActive(i)}
          onClick={() => {
            it.onSelect();
            onClose();
          }}
        >
          <span className="ito-ui-menu-item-icon" aria-hidden="true">
            {it.icon}
          </span>
          <span className="ito-ui-menu-item-label">{it.label}</span>
          {it.shortcut && (
            <span className="ito-ui-menu-item-shortcut" aria-hidden="true">
              {it.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * A surface portaled onto a shared fixed viewport layer. It positions itself
 * over `anchor` using {@link clampFixedAnchor} (auto-flip + clamp-to-viewport),
 * sits on the popover z-index token, and closes on an outside click or Esc.
 */
export function Popover({
  anchor,
  width = 300,
  onClose,
  children,
  ariaLabel,
  role = "dialog",
  testId,
  className,
}: {
  anchor: AnchorRect;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
  role?: "dialog" | "menu";
  testId?: string;
  className?: string;
}): JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const { left, top } = clampFixedAnchor(anchor, width);

  // Close on Esc + any pointer-down outside the surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (surfaceRef.current && !surfaceRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    // A timeout defers the outside-click listener past the opening click.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const surface = (
    <div
      ref={surfaceRef}
      data-testid={testId ?? "ito-popover"}
      data-popover-id={reactId}
      role={role}
      aria-label={ariaLabel}
      className={["ito-ui-popover", className].filter(Boolean).join(" ")}
      style={{ position: "fixed", left, top, width }}
    >
      {children}
    </div>
  );

  if (typeof document === "undefined") return surface;
  return createPortal(
    <div data-testid="ito-popover-layer" className="ito-ui-popover-layer">
      {surface}
    </div>,
    document.body,
  );
}
