// Browser half of the Phase 2 spike (docs/spikes/pdf-glyph-geometry.md): is the
// glyph data that scripts/spikes/pdf-glyph-geometry.mjs reads in Node also
// there in the reader itself, with the reader's own pdf.js setup (real worker,
// real font loading), and what does it cost?
//
//   node scripts/spikes/pdf-glyph-geometry.browser.mjs
//
// It serves the source tree with Vite, opens it in headless Chromium and loads
// a corpus PDF through src/pdf/render.ts's own loadDocument. Set
// ITO_CHROMIUM_PATH to use an already-installed Chromium.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PDF = "src/science/research/latex/corpus/tex-display.pdf";
const PAGES = 40;

/** A page's glyph stream as text: font name, slot and width of every glyph, in order. */
const streamOf = (opList, fontName, OPS) => {
  const parts = [];
  let font = "";
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] === OPS.setFont) font = fontName(opList.argsArray[i][0]);
    else if (opList.fnArray[i] === OPS.showText) {
      for (const g of opList.argsArray[i][0]) {
        if (typeof g !== "number") parts.push(`${font}:${g.originalCharCode}:${g.width}`);
      }
    }
  }
  return parts.join(" ");
};

// --- Node reference ---------------------------------------------------------
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, PDF))), verbosity: 0 }).promise;
const reference = [];
for (let n = 1; n <= PAGES; n++) {
  const page = await doc.getPage(n);
  const opList = await page.getOperatorList();
  reference.push(streamOf(opList, (id) => page.commonObjs.get(id).name, pdfjs.OPS));
}
await doc.destroy();

// --- Browser ----------------------------------------------------------------
const server = await createServer({ root: ROOT, logLevel: "error", server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch(
  process.env.ITO_CHROMIUM_PATH ? { executablePath: process.env.ITO_CHROMIUM_PATH } : {},
);
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5199/");
  const result = await page.evaluate(
    async ({ pdf, pages, streamSrc, OPS }) => {
      // The reader's own entry point: its pdf.js build, worker and options.
      const { loadDocument } = await import("/src/pdf/render.ts");
      const version = (await (await fetch("/node_modules/pdfjs-dist/package.json")).json()).version;
      const streamOf = new Function(`return (${streamSrc})`)();
      const bytes = new Uint8Array(await (await fetch(`/${pdf}`)).arrayBuffer());
      const doc = await loadDocument(bytes);
      const out = { version, streams: [], opListMs: [], repeatMs: [], textContentMs: [], unresolvedFonts: 0, fontRefs: 0, fontFields: null };
      for (let n = 1; n <= pages; n++) {
        const p = await doc.getPage(n);
        let t = performance.now();
        const opList = await p.getOperatorList();
        out.opListMs.push(performance.now() - t);
        // Fonts are bound asynchronously in the browser: is each one usable
        // the moment the operator list resolves?
        const ids = new Set();
        for (let i = 0; i < opList.fnArray.length; i++) {
          if (opList.fnArray[i] === OPS.setFont) ids.add(opList.argsArray[i][0]);
        }
        const names = new Map();
        for (const id of ids) {
          out.fontRefs++;
          if (!p.commonObjs.has(id)) out.unresolvedFonts++;
          const font = await new Promise((done) => p.commonObjs.get(id, done));
          names.set(id, font.name);
          out.fontFields ??= Object.keys(font).filter((k) => typeof font[k] !== "function").sort();
        }
        out.streams.push(streamOf(opList, (id) => names.get(id), OPS));
        t = performance.now();
        await p.getOperatorList();
        out.repeatMs.push(performance.now() - t);
        t = performance.now();
        await p.getTextContent();
        out.textContentMs.push(performance.now() - t);
        p.cleanup();
      }
      return out;
    },
    // The operator codes are plain numbers, the same in both builds.
    { pdf: PDF, pages: PAGES, streamSrc: streamOf.toString(), OPS: { setFont: pdfjs.OPS.setFont, showText: pdfjs.OPS.showText } },
  );

  const stat = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mean = s.reduce((x, y) => x + y, 0) / s.length;
    return `mean ${mean.toFixed(1)}  median ${s[Math.floor(s.length / 2)].toFixed(1)}  max ${s[s.length - 1].toFixed(1)}`;
  };
  const identical = result.streams.filter((s, i) => s === reference[i]).length;
  const glyphs = reference.reduce((n, s) => n + (s ? s.split(" ").length : 0), 0);
  console.log(`pdfjs-dist in the app: ${result.version}; Node reference: ${pdfjs.version}`);
  console.log(`pages whose glyph stream (font name, slot, width) is identical in the browser and in Node: ${identical}/${PAGES} (${glyphs} glyphs)`);
  console.log(`font references not yet resolved when getOperatorList() returned: ${result.unresolvedFonts}/${result.fontRefs}`);
  console.log(`font object fields in the browser: ${result.fontFields.join(", ")}`);
  console.log(`getOperatorList, first call per page (ms):  ${stat(result.opListMs)}`);
  console.log(`getOperatorList, repeat call per page (ms): ${stat(result.repeatMs)}`);
  console.log(`getTextContent, per page (ms):              ${stat(result.textContentMs)}`);
} finally {
  await browser.close();
  await server.close();
}
