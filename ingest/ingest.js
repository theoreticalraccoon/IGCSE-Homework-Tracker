#!/usr/bin/env node
/**
 * Markwise ingestion CLI.
 *
 *   node ingest.js papers     --dir ./pdfs [--subject 0625] [--dry]
 *   node ingest.js syllabus   --file ./0625_y25_sy.pdf
 *   node ingest.js boundaries --dir ./pdfs
 *   node ingest.js reembed    [--subject 0625]
 *   node ingest.js status
 *
 * `papers` is the main command. It walks a directory of PDFs, groups question
 * papers with their mark schemes and examiner reports by paper identity, and
 * writes one embedded chunk per question part.
 *
 * The run is resumable: a paper whose sha256 already matches the database is
 * skipped without being opened, so re-running after a crash costs almost
 * nothing, and adding a new session to an existing corpus only processes the
 * new files.
 */

import { readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import pLimit from "p-limit";

import { CONCURRENCY, EMBED_BATCH } from "./lib/config.js";
import { extractPages, renderPagePng, sha256 } from "./lib/pdf.js";
import { ocrPage, embedBatch } from "./lib/gemini.js";
import { parseFilename, titleFor } from "./lib/filename.js";
import {
  parseQuestionPaper, parseMarkScheme, llmParseQuestions, llmParseMarkScheme,
  looksParsed, dropCoverPage,
} from "./lib/parse.js";
import { pairQuestions, attachExaminerReport } from "./lib/pair.js";
import { commandWord, classifyBatch, topicVocabulary } from "./lib/classify.js";
import { parseSyllabus, llmParseSyllabus, parseGradeThresholds } from "./lib/syllabus.js";
import {
  db, ensureSubject, getSubject, upsertPaper, insertChunks, coverage,
  chunksMissingEmbedding, setEmbedding, upsertGradeBoundaries,
} from "./lib/db.js";

/* ------------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const command = argv[0];
const flags = Object.fromEntries(
  argv.slice(1).reduce((acc, a, i, arr) => {
    if (!a.startsWith("--")) return acc;
    const key = a.slice(2);
    const next = arr[i + 1];
    acc.push([key, next && !next.startsWith("--") ? next : true]);
    return acc;
  }, []),
);

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);

/** Questions per classification call. Smaller batches survive tight quotas. */
const CLASSIFY_BATCH = Number(process.env.CLASSIFY_BATCH || 25);

/** Below this share of question parts paired, the model re-reads the scheme. */
const MS_PAIR_TARGET = 0.85;

/** Pair one set of mark-scheme rows and score the result. */
function attempt(questions, msRows) {
  const { paired, stats } = pairQuestions(questions, msRows);
  const hit = paired.filter((p) => p.msText).length;
  return { paired, stats, rate: questions.length ? hit / questions.length : 0 };
}

/* ------------------------------------------------------------------- main -- */

const COMMANDS = { papers, syllabus, boundaries, reembed, classify, status };

if (!command || !COMMANDS[command]) {
  log(`Markwise ingestion

  node ingest.js papers     --dir <folder> [--subject 0625] [--dry] [--ocr]
  node ingest.js syllabus   --file <file.pdf> [--subject 0625]
  node ingest.js boundaries --dir <folder>
  node ingest.js reembed    [--subject 0625]
  node ingest.js classify   [--subject 0625] [--all]
  node ingest.js status
`);
  process.exit(command ? 1 : 0);
}

try {
  await COMMANDS[command]();
  process.exit(0);
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
}

/* ----------------------------------------------------------------- papers -- */

async function papers() {
  const dir = flags.dir;
  if (!dir) throw new Error("--dir is required.");

  const files = await listPdfs(dir);
  log(`Found ${files.length} PDF${files.length === 1 ? "" : "s"} in ${dir}\n`);

  // Group by paper identity so a question paper meets its mark scheme.
  const groups = new Map();
  const skipped = [];

  for (const file of files) {
    const meta = parseFilename(basename(file));
    if (!meta || !meta.subjectCode) {
      skipped.push(basename(file));
      continue;
    }
    if (flags.subject && meta.subjectCode !== String(flags.subject)) continue;
    if (!["qp", "ms", "er"].includes(meta.kind)) continue;

    const id = `${meta.subjectCode}|${meta.year}|${meta.session}|${meta.paperNo}|${meta.variant}`;
    if (!groups.has(id)) groups.set(id, { meta, files: {} });
    const group = groups.get(id);
    group.files[meta.kind] = file;
    // The group inherits the identity of whichever file arrived first, which
    // is alphabetical: "…_er_13" before "…_qp_13". The question paper is the
    // one whose code every chunk is cited by, so it always wins.
    if (meta.kind === "qp") group.meta = meta;
  }

  if (skipped.length) {
    warn(`${skipped.length} file(s) had unrecognisable names and were skipped, e.g. ${skipped[0]}`);
  }
  log(`${groups.size} paper group(s) to process.\n`);

  const limit = pLimit(Math.max(1, CONCURRENCY));
  const totals = { papers: 0, chunks: 0, paired: 0, unpaired: 0, skipped: 0 };

  await Promise.all(
    [...groups.values()].map((g) =>
      limit(async () => {
        try {
          const r = await ingestGroup(g);
          totals.papers += r.papers;
          totals.chunks += r.chunks;
          totals.paired += r.paired;
          totals.unpaired += r.unpaired;
          totals.skipped += r.skipped;
        } catch (e) {
          warn(`${g.meta.code}: ${e.message}`);
        }
      })
    ),
  );

  log(`
Done.
  papers ingested : ${totals.papers} (${totals.skipped} unchanged, skipped)
  question chunks : ${totals.chunks}
  with mark scheme: ${totals.paired}
  without         : ${totals.unpaired}`);

  if (totals.unpaired > totals.paired && totals.paired > 0) {
    warn("More unpaired than paired questions: are the mark scheme PDFs in this folder?");
  }
}

async function ingestGroup({ meta, files }) {
  const tag = meta.code ?? `${meta.subjectCode} ${meta.session} ${meta.year}`;
  const result = { papers: 0, chunks: 0, paired: 0, unpaired: 0, skipped: 0 };

  if (!files.qp) {
    warn(`${tag}: no question paper, only a mark scheme: skipping`);
    return result;
  }

  const subject = (await getSubject(meta.subjectCode)) ?? (await ensureSubject(meta.subjectCode));

  // --- has this exact file already been ingested? --------------------------
  const hash = await sha256(files.qp);
  const { pages: qpPagesRaw, pageCount } = await extractPages(files.qp);
  const { paper, unchanged } = await upsertPaper(meta, {
    title: titleFor(meta, subject.name),
    sha256: hash,
    pages: pageCount,
  });
  if (unchanged) {
    result.skipped = 1;
    return result;
  }
  result.papers = 1;

  // --- extract, with OCR where the text layer is missing -------------------
  const qpPages = await maybeOcr(files.qp, qpPagesRaw, tag);
  const body = dropCoverPage(qpPages);

  // --- parse questions -----------------------------------------------------
  let questions = parseQuestionPaper(body);
  if (!looksParsed(questions)) {
    log(`  ${tag}: layout defeated the parser: retrying with the model`);
    const viaLlm = await llmParseQuestions(body, titleFor(meta, subject.name));
    if (viaLlm.length > questions.length) questions = viaLlm;
  }
  if (questions.length === 0) {
    warn(`${tag}: no questions extracted`);
    return result;
  }

  // --- parse and pair the mark scheme --------------------------------------
  //
  // The decision to spend a model call is made on the pairing rate itself,
  // not on how many rows were parsed. A flattened table can yield a row for
  // every question and still label the parts wrongly, which produces plenty of
  // rows and almost no usable pairs.
  let best = {
    paired: questions.map((q) => ({ ...q, msText: null, msMarks: null })),
    stats: { exact: 0, normalised: 0, root: 0, unmatched: questions.length },
    rate: 0,
  };

  if (files.ms) {
    const { pages: msRaw } = await extractPages(files.ms);
    const msPages = await maybeOcr(files.ms, msRaw, `${tag} ms`);

    best = attempt(questions, parseMarkScheme(msPages));

    if (best.rate < MS_PAIR_TARGET) {
      log(`  ${tag}: ${Math.round(best.rate * 100)}% of parts paired: re-reading the mark scheme with the model`);
      try {
        const viaLlm = attempt(questions, await llmParseMarkScheme(msPages, `${tag} mark scheme`));
        if (viaLlm.rate > best.rate) best = viaLlm;
      } catch (e) {
        warn(`${tag}: model re-read failed (${e.message}). Keeping the deterministic pairing`);
      }
    }
  }

  const { paired, stats } = best;
  result.paired = paired.filter((p) => p.msText).length;
  result.unpaired = paired.length - result.paired;

  // --- examiner report -----------------------------------------------------
  let enriched = paired;
  if (files.er) {
    const { pages: erPages } = await extractPages(files.er);
    enriched = attachExaminerReport(paired, erPages);
  }

  // --- classify ------------------------------------------------------------
  const topics = await topicVocabulary(db, meta.subjectCode);
  const labels = await classifyBatch(enriched, topics, subject.name);

  // --- embed ---------------------------------------------------------------
  const texts = enriched.map((q, i) => embedText(q, labels[i], subject.name));
  const vectors = await embedAll(texts);

  // --- write ---------------------------------------------------------------
  const rows = enriched.map((q, i) => ({
    paper_id: paper.id,
    subject_code: meta.subjectCode,
    kind: "question",
    paper_code: meta.code,
    year: meta.year,
    session: meta.session,
    paper_no: meta.paperNo,
    variant: meta.variant,
    question_no: q.questionNo,
    question_root: q.questionRoot,
    marks: q.marks ?? null,
    command_word: commandWord(q.text),
    topic: labels[i]?.topic ?? null,
    syllabus_refs: labels[i]?.refs ?? [],
    content: q.text,
    ms_content: q.msText ?? null,
    er_content: q.erText ?? null,
    page: q.page ?? null,
    embedding: vectors[i] ?? null,
  }));

  result.chunks = await insertChunks(rows);
  log(
    `  ${tag}: ${result.chunks} parts · ${result.paired} with mark scheme ` +
      `(exact ${stats.exact}, fuzzy ${stats.normalised}, root ${stats.root})`,
  );
  return result;
}

/**
 * The text that gets embedded is not the question alone. Retrieval has to find
 * a question from a paraphrase of its *answer* too ("why does a parachute slow
 * down") so the mark scheme's vocabulary is folded in, along with the topic and
 * the paper reference so identifier searches hit semantically as well.
 */
function embedText(q, label, subjectName) {
  return [
    `${subjectName} · ${label?.topic ?? "IGCSE"}`,
    `Question ${q.questionNo}${q.marks ? ` (${q.marks} marks)` : ""}`,
    q.text,
    q.msText ? `Marking points: ${q.msText}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 7000);
}

/* --------------------------------------------------------------- syllabus -- */

async function syllabus() {
  const file = flags.file;
  if (!file) throw new Error("--file is required.");

  const meta = parseFilename(basename(file));
  const code = String(flags.subject ?? meta?.subjectCode ?? "");
  if (!code) throw new Error("Could not tell which subject this is: pass --subject.");

  const subject = (await getSubject(code)) ?? (await ensureSubject(code));
  const hash = await sha256(file);
  const { pages, pageCount } = await extractPages(file);

  const { paper, unchanged } = await upsertPaper(
    { subjectCode: code, kind: "sy", year: meta?.year ?? null, session: null, paperNo: null, variant: null, code: meta?.code ?? basename(file, extname(file)) },
    { title: `${subject.name} syllabus${meta?.year ? ` ${meta.year}` : ""}`, sha256: hash, pages: pageCount },
  );
  if (unchanged) {
    log("Already ingested and unchanged.");
    return;
  }

  let sections = parseSyllabus(pages);
  if (sections.length < 5) {
    log("Structural parse was thin: using the model.");
    sections = await llmParseSyllabus(pages, subject.name);
  }
  if (!sections.length) throw new Error("No syllabus sections found.");

  const vectors = await embedAll(
    sections.map((s) => `${subject.name} syllabus · ${s.topic}\n${s.content}`),
  );

  const rows = sections.map((s, i) => ({
    paper_id: paper.id,
    subject_code: code,
    kind: "syllabus",
    paper_code: meta?.code ?? null,
    year: meta?.year ?? null,
    topic: s.topic,
    syllabus_refs: [s.ref],
    content: s.content,
    embedding: vectors[i] ?? null,
  }));

  const n = await insertChunks(rows);
  log(`${n} syllabus sections ingested for ${subject.name}.`);
  log(`Topic vocabulary is now: ${[...new Set(sections.map((s) => s.topic))].join(", ")}`);
  log(`\nIngest this subject's papers next. They will be classified against these topics.`);
}

/* ------------------------------------------------------------- boundaries -- */

async function boundaries() {
  const dir = flags.dir;
  if (!dir) throw new Error("--dir is required.");
  const files = (await listPdfs(dir)).filter((f) => {
    const m = parseFilename(basename(f));
    return m?.kind === "gt";
  });
  if (!files.length) {
    log("No grade-threshold PDFs found (expected names like 0625_s19_gt.pdf).");
    return;
  }

  let total = 0;
  for (const file of files) {
    const meta = parseFilename(basename(file));
    const { pages } = await extractPages(file);
    const rows = parseGradeThresholds(pages, meta);
    total += await upsertGradeBoundaries(rows);
    log(`  ${basename(file)}: ${rows.length} thresholds`);
  }
  log(`\n${total} grade boundaries stored: predicted grades are now available.`);
}

/* ---------------------------------------------------------------- reembed -- */

async function reembed() {
  const subject = flags.subject ? String(flags.subject) : null;
  let total = 0;
  for (;;) {
    const rows = await chunksMissingEmbedding(subject, 200);
    if (!rows.length) break;
    const vectors = await embedAll(
      rows.map((r) => [r.topic, r.question_no, r.content, r.ms_content].filter(Boolean).join("\n").slice(0, 7000)),
    );
    for (let i = 0; i < rows.length; i++) {
      if (vectors[i]) {
        await setEmbedding(rows[i].id, vectors[i]);
        total++;
      }
    }
    log(`  embedded ${total}…`);
  }
  log(`${total} chunk(s) embedded.`);
}

/* --------------------------------------------------------------- classify -- */

/**
 * Tag already-ingested questions with their syllabus topic.
 *
 * Separate from ingestion because the two fail independently. Classification
 * is the first step to hit a quota ceiling, and losing a paper's whole parse
 * because the labelling ran out of requests would be absurd. It is also worth
 * re-running after a syllabus lands, which changes the vocabulary questions
 * should have been classified against in the first place.
 */
async function classify() {
  const subject = flags.subject ? String(flags.subject) : null;

  let q = db.from("chunks").select("id,subject_code,content").eq("kind", "question");
  if (subject) q = q.eq("subject_code", subject);
  if (!flags.all) q = q.is("topic", null);
  const { data: rows, error } = await q.limit(5000);
  if (error) throw new Error(error.message);

  if (!rows.length) {
    log(flags.all ? "No questions found." : "Every question already has a topic. Pass --all to redo them.");
    return;
  }

  // The topic vocabulary is per subject and must never be mixed between them.
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject_code)) bySubject.set(r.subject_code, []);
    bySubject.get(r.subject_code).push(r);
  }

  let tagged = 0;
  for (const [code, items] of bySubject) {
    const info = await getSubject(code);
    const name = info?.name ?? code;
    const topics = await topicVocabulary(db, code);
    if (!topics.length) {
      warn(`${code}: no topic vocabulary: ingest the syllabus for this subject first`);
      continue;
    }
    log(`${name}: ${items.length} question(s) against ${topics.length} topics`);

    for (let i = 0; i < items.length; i += CLASSIFY_BATCH) {
      const slice = items.slice(i, i + CLASSIFY_BATCH);
      const labels = await classifyBatch(slice.map((r) => ({ text: r.content })), topics, name);
      let batchTagged = 0;
      for (let j = 0; j < slice.length; j++) {
        const label = labels[j];
        if (!label?.topic) continue;
        const { error: e } = await db.from("chunks")
          .update({ topic: label.topic, syllabus_refs: label.refs ?? [] })
          .eq("id", slice[j].id);
        if (!e) {
          tagged++;
          batchTagged++;
        }
      }
      log(`  ${Math.min(i + CLASSIFY_BATCH, items.length)}/${items.length}: ${batchTagged} tagged`);
    }
  }
  log(`\n${tagged} question(s) classified.`);
}

/* ----------------------------------------------------------------- status -- */

async function status() {
  const rows = await coverage();
  const withCorpus = rows.filter((r) => r.questions > 0);

  if (!withCorpus.length) {
    log("No corpus ingested yet. Start with:\n  node ingest.js syllabus --file <subject syllabus>.pdf");
    return;
  }

  const pad = (s, n) => String(s ?? "").padEnd(n);
  log(pad("SUBJECT", 30) + pad("QUESTIONS", 11) + pad("SYLLABUS", 10) + pad("PAPERS", 8) + "YEARS");
  log("-".repeat(72));
  for (const r of withCorpus) {
    log(
      pad(`${r.subject_name} (${r.subject_code})`, 30) +
        pad(r.questions, 11) +
        pad(r.syllabus_sections, 10) +
        pad(r.papers, 8) +
        (r.from_year ? `${r.from_year}–${r.to_year}` : ": "),
    );
  }

  const { count: unembedded } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  if (unembedded) warn(`${unembedded} chunk(s) have no embedding: run: node ingest.js reembed`);

  const { count: unpaired } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("kind", "question")
    .is("ms_content", null);
  if (unpaired) {
    log(`\n${unpaired} question(s) have no mark scheme attached. They are searchable but cannot be marked.`);
  }
}

/* ---------------------------------------------------------------- helpers -- */

async function listPdfs(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extname(entry.name).toLowerCase() === ".pdf") out.push(full);
    }
  };
  const s = await stat(dir).catch(() => null);
  if (!s) throw new Error(`No such folder: ${dir}`);
  await walk(dir);
  return out.sort();
}

/** OCR only the pages that need it, and only when --ocr is passed. */
async function maybeOcr(file, pages, tag) {
  const thin = pages.filter((p) => p.thin);
  if (!flags.ocr || thin.length === 0) return pages;
  if (thin.length > pages.length * 0.8) log(`  ${tag}: scanned paper: OCR'ing ${thin.length} pages`);

  for (const page of thin) {
    const png = await renderPagePng(file, page.n);
    if (!png) {
      warn("OCR needs the optional 'canvas' package: npm i canvas");
      return pages;
    }
    try {
      page.text = await ocrPage(png, tag);
      page.thin = false;
    } catch (e) {
      warn(`OCR failed on page ${page.n}: ${e.message}`);
    }
  }
  return pages;
}

async function embedAll(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH);
    try {
      out.push(...(await embedBatch(slice)));
    } catch (e) {
      warn(`embedding batch failed (${e.message}). Those chunks land unembedded; run 'reembed' later`);
      out.push(...slice.map(() => null));
    }
  }
  return out;
}
