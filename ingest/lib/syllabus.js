/**
 * Syllabus and grade-threshold ingestion.
 *
 * The syllabus is the smallest and highest-value document in the corpus: it is
 * what answers "is this examinable?", and its section headings become the
 * controlled topic vocabulary that every question is classified against. Get
 * this in first for a subject and every later ingestion is better.
 */

import { generateJSON } from "./gemini.js";
import { cleanLines } from "./parse.js";

/* ---------------------------------------------------------------- syllabus -- */

// "1 Numbers and the number system" / "3 Waves" / "B4 Enzymes" — a top-level
// topic. Must not end in a digit, which is what distinguishes a real heading
// from a contents-page entry ("1 About this specification 1").
const TOPIC = /^([A-Z]?\d{1,2})\s+([A-Z][A-Za-z][A-Za-z ,&'’\-()/]{3,70})$/;

// "1.1 Integers" / "2.3" — a numbered subsection beneath a topic. Edexcel puts
// the subsection's name in a separate table column, so it often arrives on the
// following line and the title here is empty.
const SUBSECTION = /^([A-Z]?\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s*(.*)$/;

// Where the real content begins, strongest signal first. These must be
// anchored to the start of the line: the phrase "subject content" also occurs
// in prose about the assessment ("Questions will assume knowledge from the
// Foundation Tier subject content"), eighty lines before the content itself.
const CONTENT_START = [
  /^students should be taught to/i,
  /^(subject|syllabus|specification) content\b/i,
  /^section \d+:? (subject|syllabus) content/i,
];

const CONTENT_END = /^(assessment objectives|grade descriptions?|grade descriptors|appendix|glossary of command words|what else|assessment information)\b/i;

/** Index of the first line that genuinely opens the content section. */
function findContentStart(lines) {
  for (const marker of CONTENT_START) {
    const i = lines.findIndex((l) => marker.test(l));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Split a syllabus PDF into one chunk per numbered subsection.
 *
 * `topic` is deliberately the TOP-LEVEL heading, not the subsection name. It
 * becomes the controlled vocabulary every exam question is classified against,
 * and the mastery table is only meaningful if that vocabulary is a handful of
 * buckets a student would recognise — "Algebra and graphs", not "1.4 Use of
 * symbols". Subsection numbers are kept as `ref` so citations stay precise.
 *
 * @returns {{ref,topic,content}[]}
 */
export function parseSyllabus(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  // Begin a few lines before the marker: the marker ("Students should be
  // taught to") sits under the first topic heading, not above it.
  const marker = findContentStart(lines);
  if (marker < 0) return [];
  const start = Math.max(0, marker - 3);

  const sections = [];
  let topic = null;
  let current = null;

  const flush = () => {
    if (current && current.lines.length) {
      const body = current.lines.join("\n").trim();
      if (body) {
        sections.push({
          ref: current.ref,
          topic: current.topic,
          content: `${current.topic} — ${current.ref}${current.title ? ` ${current.title}` : ""}\n${body}`,
        });
      }
    }
    current = null;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // The end marker only counts once we are well inside the content: these
    // headings also appear in the front matter and contents pages.
    if (i > start + 20 && CONTENT_END.test(line)) break;
    if (CONTENT_START.some((re) => re.test(line))) continue;

    const t = line.match(TOPIC);
    if (t) {
      flush();
      topic = t[2].trim();
      continue;
    }

    const s = line.match(SUBSECTION);
    if (s && topic) {
      flush();
      // The subsection name is often the next line, in its own column.
      const inlineTitle = s[2].trim();
      const nextLine = (lines[i + 1] ?? "").trim();
      const title = inlineTitle || (/^[A-Z][A-Za-z ,'’\-()]{2,40}$/.test(nextLine) ? nextLine : "");
      current = { ref: s[1], topic, title, lines: inlineTitle ? [inlineTitle] : [] };
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush();

  // Fragments are not retrievable units.
  return sections.filter((s) => s.content.length > 80);
}

const SY_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Section number, e.g. 2.1" },
          topic: { type: "string", description: "Top-level topic this belongs to." },
          content: { type: "string", description: "The learning outcomes, verbatim." },
        },
        required: ["ref", "topic", "content"],
      },
    },
  },
  required: ["sections"],
};

const SY_SYSTEM = `
You convert an IGCSE syllabus into retrievable sections.

Rules:
- One section per numbered subsection of the SUBJECT CONTENT.
- 'topic' must be the TOP-LEVEL topic name the subsection sits under, repeated
  identically for every subsection of that topic. These become the app's topic
  vocabulary, so consistency matters more than precision.
- 'content' is the learning outcomes VERBATIM. Do not summarise; the exact
  wording ("describe qualitatively…") is what determines examinability.
- Ignore assessment logistics, grade descriptors, and appendices.
`.trim();

export async function llmParseSyllabus(pages, subjectName) {
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 90000);
  const { sections } = await generateJSON(
    `SUBJECT: ${subjectName}\n\nSYLLABUS:\n${text}`,
    SY_SCHEMA,
    { system: SY_SYSTEM, maxOutputTokens: 8192 },
  );
  return (sections ?? []).filter((s) => s.content?.length > 40);
}

/* -------------------------------------------------------- grade thresholds -- */

/**
 * Grade threshold tables are small and rigidly laid out:
 *
 *   Component 42   A*  B  C ...
 *                  55  48 41 ...
 *
 * Parsed deterministically — there is no ambiguity worth spending a model call
 * on, and a wrong grade boundary silently corrupts every predicted grade.
 */
const GRADES = ["A*", "A", "B", "C", "D", "E", "F", "G"];

export function parseGradeThresholds(pages, meta) {
  const rows = [];
  const lines = pages.flatMap((p) => cleanLines(p.text));

  let component = null;
  let maxMark = null;

  for (const line of lines) {
    const comp = line.match(/component\s+(\d{2})/i);
    if (comp) {
      component = Number(comp[1][0]); // '42' → paper 4
      continue;
    }
    const max = line.match(/maximum (?:raw )?mark\D{0,12}(\d{1,3})/i);
    if (max) {
      maxMark = Number(max[1]);
      continue;
    }
    if (!component) continue;

    // A row of 6-8 descending numbers is the threshold row.
    const nums = line.match(/\b\d{1,3}\b/g);
    if (!nums || nums.length < 5 || nums.length > 9) continue;
    const values = nums.map(Number);
    const descending = values.every((v, i) => i === 0 || v <= values[i - 1]);
    if (!descending) continue;

    values.forEach((v, i) => {
      if (i >= GRADES.length) return;
      rows.push({
        subject_code: meta.subjectCode,
        year: meta.year,
        session: meta.session,
        paper_no: component,
        grade: GRADES[i],
        min_marks: v,
        max_marks: maxMark,
      });
    });
    component = null;
  }
  return rows;
}
