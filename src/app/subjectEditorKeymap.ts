/**
 * Editing keymap for the continuous subject editor. The composition is a plain
 * rich-text surface (writing before/between/after quotes) so it uses the
 * ProseMirror base keymap plus the usual Enter/Backspace/Delete/join commands.
 * There is deliberately NO template or mandatory section (spec section 9).
 */

import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type { Plugin } from "prosemirror-state";
import { subjectSchema } from "../editor";

export function subjectKeymapPlugins(): Plugin[] {
  const strong = subjectSchema.marks.strong!;
  const em = subjectSchema.marks.em!;
  const paragraph = subjectSchema.nodes.paragraph!;
  return [
    // Undo/redo history so typing, formatting, quote inserts and block moves
    // are all reversible (Mod-z / Mod-y / Mod-Shift-z). The history plugin must
    // precede the keymaps so the tracked transactions include their edits.
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
    }),
    keymap({
      "Mod-b": toggleMark(strong),
      "Mod-i": toggleMark(em),
      "Shift-Ctrl-0": setBlockType(paragraph),
    }),
    keymap(baseKeymap),
  ];
}
