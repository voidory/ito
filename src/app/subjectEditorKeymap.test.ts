/**
 * Undo/redo wiring for the subject editor (m8). The keymap must include the
 * prosemirror-history plugin and bind Mod-z / Mod-y / Mod-Shift-z so composed
 * edits are reversible. We drive the plugins headlessly: apply a text insert,
 * run undo, and assert the doc reverts; then redo and assert it comes back.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import { subjectSchema } from "../editor";
import { subjectKeymapPlugins } from "./subjectEditorKeymap";

function text(state: EditorState): string {
  return state.doc.textContent;
}

describe("subject editor keymap", () => {
  it("includes the history plugin among the subject keymap plugins", () => {
    const plugins = subjectKeymapPlugins();
    const state = EditorState.create({ schema: subjectSchema, plugins });
    // The history plugin exposes undo/redo depth through its state; a fresh
    // doc has nothing to undo. Applying undo as a no-op must not throw.
    expect(undo(state, undefined)).toBe(false);
  });

  it("undo reverts a typed insertion and redo restores it", () => {
    const plugins = subjectKeymapPlugins();
    let state = EditorState.create({ schema: subjectSchema, plugins });

    // Type some text as a tracked transaction.
    state = state.apply(state.tr.insertText("hello world"));
    expect(text(state)).toContain("hello world");

    // Undo via the history command, dispatching through apply.
    const undone = undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(undone).toBe(true);
    expect(text(state)).not.toContain("hello world");

    // Redo brings the text back.
    const redone = redo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(redone).toBe(true);
    expect(text(state)).toContain("hello world");
  });
});
