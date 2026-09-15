/**
 * PDF text extraction.
 *
 * Naively concatenating pdf.js text items destroys exam papers: mark
 * allocations sit in a right-hand column, mark schemes are tables, and answer
 * lines interleave with question text. So items are bucketed into visual lines
 * by their y-coordinate and sorted by x within a line, which reconstructs the
 * reading order well enough for the question parser to work on.
 *
 * Pages whose text layer is thin (scanned papers) are reported as such so the
 * caller can decide whether to spend an OCR call on them.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let pdfjs;
async function lib() {
  if (!pdfjs) {
    // The legacy build is the one that runs under Node without a DOM.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // require.resolve returns a native path. On Windows that is "C:\…", which
    // the ESM loader rejects as an unknown URL scheme ("c:"), so it must be
    // converted to a file:// URL before pdf.js tries to import the worker.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  return pdfjs;
}

/** Items on roughly the same baseline belong to the same line. */
const Y_TOLERANCE = 2.5;

/**
 * @returns {Promise<{pages: {n:number, text:string, thin:boolean}[], pageCount:number}>}
 */
export async function extractPages(path) {
  const { getDocument } = await lib();
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = itemsToText(content.items);
    pages.push({
      n,
      text,
      // A real exam page carries several hundred characters. Much less than
      // that means the text layer is missing or is image-only.
      thin: text.replace(/\s/g, "").length < 180,
    });
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pages, pageCount };
}

/**
 * A visible gap between two text items is a space, even when neither item
 * contains one.
 *
 * This matters more than it sounds. Exam papers set the question number as its
 * own text item in the left margin, so concatenating naively yields
 * "1Here are the first four terms". And worse, "2450 students were asked",
 * which is question 2 asking about 450 students. Both are unparseable, and the
 * second is indistinguishable from a line that really does start with 2450.
 * Measuring the gap recovers the space and makes the question number visible
 * to the parser again.
 */
const GAP_IS_SPACE = 1.2;

function itemsToText(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let line = lines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, str: it.str, width: it.width ?? 0 });
  }

  lines.sort((a, b) => b.y - a.y); // PDF origin is bottom-left
  return lines
    .map((l) => {
      const parts = l.parts.sort((a, b) => a.x - b.x);
      let out = "";
      let cursor = null;
      for (const p of parts) {
        if (cursor !== null && p.x - cursor > GAP_IS_SPACE && !/\s$/.test(out) && !/^\s/.test(p.str)) {
          out += " ";
        }
        out += p.str;
        cursor = p.x + p.width;
      }
      return out.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Render one page to PNG for OCR. Requires the optional `canvas` package; when
 * it is absent the caller falls back to whatever text layer exists rather than
 * making the whole pipeline depend on a native module.
 */
export async function renderPagePng(path, pageNo, scale = 2) {
  let createCanvas;
  try {
    ({ createCanvas } = require("canvas"));
  } catch {
    return null; // OCR unavailable. Not fatal
  }
  const { getDocument } = await lib();
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({ data, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  const buf = canvas.toBuffer("image/png");
  await doc.destroy();
  return buf;
}

/** Cheap structural fingerprint so re-ingesting an unchanged file is a no-op. */
export async function sha256(path) {
  const { createHash } = await import("node:crypto");
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
