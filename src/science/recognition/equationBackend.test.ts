import { describe, expect, it } from "vitest";
import type { EquationBackend, EquationInput } from "./equationBackend";
import { createRecognitionService } from "./recognitionService";
import type { ImageModelBackend, RecognitionInput } from "./types";

const IMAGE: RecognitionInput = { imageDataUrl: "data:image/png;base64,AAAA", width: 100, height: 40 };
const PAGE = { model: { width: 100, height: 100, glyphs: [], rules: [], vrules: [] }, rect: { x: 0, y: 0, width: 1, height: 1 } };

function geometry(text: string | null, extra: Partial<EquationBackend> & { confidence?: number; doubts?: string[]; verbatim?: boolean } = {}): EquationBackend {
  const { confidence, doubts, verbatim, ...rest } = extra;
  return {
    id: "geometry-stub",
    modality: "geometry",
    isConfigured: () => true,
    supports: (input: EquationInput) => input.page != null,
    async recognize() {
      return text == null ? null : { text, ...(confidence !== undefined ? { confidence } : {}), ...(doubts ? { doubts } : {}), ...(verbatim ? { verbatim } : {}) };
    },
    ...rest,
  };
}
const model = (text: string): ImageModelBackend => ({ id: "model-stub", isConfigured: () => true, async infer() { return { text }; } });

describe("equation backends", () => {
  it("asks a backend that reads the page before one that reads the picture", async () => {
    const service = createRecognitionService({ mathBackend: [geometry("a+b"), model("x")] });
    const result = await service.recognizeEquation({ image: IMAGE, page: PAGE });
    expect(result.latex).toBe("a+b");
    expect(result.backend).toEqual({ id: "geometry-stub", modality: "geometry" });
  });

  it("falls through to the picture when the page has nothing to say", async () => {
    const service = createRecognitionService({ mathBackend: [geometry(null), model("x^2")] });
    const result = await service.recognizeEquation({ image: IMAGE, page: PAGE });
    expect(result.latex).toBe("x^2");
    expect(result.backend?.modality).toBe("image");
  });

  it("uses only the backends that understand what it was given", async () => {
    const service = createRecognitionService({ mathBackend: [geometry("a+b")] });
    // A picture alone: the page reader has nothing to read.
    expect((await service.recognizeEquation({ image: IMAGE })).status).toBe("unsupported");
    expect((await service.recognize("equation", IMAGE)).status).toBe("unsupported");
  });

  it("does not normalize what a backend says is already in its final form", async () => {
    // normalizeToLatex would respell `x^{2}`; a verbatim draft keeps its spelling.
    const verbatim = createRecognitionService({ mathBackend: geometry("x^{2}", { verbatim: true }) });
    expect((await verbatim.recognizeEquation({ page: PAGE })).latex).toBe("x^{2}");
  });

  it("holds a draft below the backend's own trust line as low-confidence, with its reasons", async () => {
    const doubtful = createRecognitionService({ mathBackend: geometry("a+b", { confidence: 0.8, trustAt: 0.95, doubts: ["A script sits between two lines."] }) });
    const result = await doubtful.recognizeEquation({ page: PAGE });
    expect(result.status).toBe("low-confidence");
    expect(result.confidence).toBe(0.8);
    expect(result.warnings).toEqual(["A script sits between two lines."]);
    const sure = createRecognitionService({ mathBackend: geometry("a+b", { confidence: 0.99, trustAt: 0.95 }) });
    const ok = await sure.recognizeEquation({ page: PAGE });
    expect(ok.status).toBe("success");
    expect(ok.warnings).toBeUndefined();
  });

  it("reports an error, not a result, when the only backend that tried failed", async () => {
    const broken = geometry("x", { recognize: async () => { throw new Error("boom"); } });
    const result = await createRecognitionService({ mathBackend: broken }).recognizeEquation({ page: PAGE });
    expect(result.status).toBe("error");
    expect(result.errors?.[0]).toContain("boom");
  });
});
