import type { DocumentJson } from "../editor";

/** Append a plain paragraph of text to a subject-page document JSON. */
export function appendText(json: DocumentJson, text: string): DocumentJson {
  const doc = json as { type: string; content?: unknown[] };
  return {
    ...doc,
    content: [...(doc.content ?? []), { type: "paragraph", content: [{ type: "text", text }] }],
  } as DocumentJson;
}
