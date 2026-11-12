import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A reusable, portaled right-click menu: icon-led rows, optional shortcut hint,
 * separators, danger styling, flip/clamp positioning, arrow-key navigation, and
 * Esc / outside-click dismissal. Presentation only; callers supply the items.
 */
export type ContextMenuEntry =
  | {
      readonly kind?: "item";
      readonly id: string;
      readonly label: string;
      readonly icon?: ReactNode;
      readonly shortcut?: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly onSelect: () => void;
    }
  | { readonly kind: "separator"; readonly id: string }
  | { readonly kind: "label"; readonly id: string; readonly label: string };

const WIDTH = 248;

export function ContextMenuSurface({
  x,
  y,
  entries,
  onClose,
  ariaLabel,
  testId = "app-context-menu",
}: {
  x: number;
  y: number;
  entries: readonly ContextMenuEntry[];
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const items = entries.filter(
    (e): e is Extract<ContextMenuEntry, { id: string; onSelect: () => void }> =>
      e.kind !== "separator" && e.kind !== "label",
  );
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = y;
    if (top + h > vh - 8) top = Math.max(8, y - h);
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    const left = Math.max(8, Math.min(x, vw - WIDTH - 8));
    setPos({ left, top });
    el.focus();
  }, [x, y, entries.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (enabled.length === 0) return;
      const cur = enabled.indexOf(active);
      const next =
        e.key === "ArrowDown"
          ? enabled[(cur + 1) % enabled.length]!
          : enabled[(cur - 1 + enabled.length) % enabled.length]!;
      setActive(next);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const it = items[active];
      if (it && !it.disabled) {
        onClose();
        it.onSelect();
      }
    }
  };

  let itemIndex = -1;
  const menu = (
    <div
      ref={ref}
      data-testid={testId}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="ito-ctx-menu"
      style={{ position: "fixed", left: pos.left, top: pos.top, width: WIDTH, outline: "none" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((e) => {
        if (e.kind === "separator") {
          return <div key={e.id} className="ito-ctx-sep" role="separator" />;
        }
        if (e.kind === "label") {
          return (
            <div key={e.id} className="ito-ctx-heading">
              {e.label}
            </div>
          );
        }
        itemIndex += 1;
        const idx = itemIndex;
        return (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            data-testid={`ctx-${e.id}`}
            disabled={e.disabled}
            data-active={active === idx ? "true" : undefined}
            className={["ito-ctx-item", e.danger ? "ito-ctx-item-danger" : null]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={() => !e.disabled && setActive(idx)}
            onClick={() => {
              onClose();
              e.onSelect();
            }}
          >
            <span className="ito-ctx-item-icon" aria-hidden="true">
              {e.icon}
            </span>
            <span className="ito-ctx-item-label">{e.label}</span>
            {e.shortcut && <kbd className="ito-ctx-item-kbd">{e.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
  return createPortal(menu, document.body);
}
