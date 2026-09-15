/**
 * Topic and command-word classification.
 *
 * Topics are what make everything personal: the weakness profile, the
 * "generate a mock on what I'm bad at" feature, and topic drilling all key off
 * this field. They must therefore come from a controlled vocabulary: the
 * subject's own syllabus sections: rather than whatever phrase the model
 * feels like producing, or "Forces" and "Forces and motion" become different
 * topics and the mastery table fragments into noise.
 *
 * Command words are pure regex. Cambridge publishes a fixed list of them and
 * they always open the imperative clause, so there is nothing for a model to
 * add here.
 */

import { generateJSON } from "./gemini.js";
import { LLM_CLASSIFY } from "./config.js";

/** Cambridge's published command words, longest first so "state" does not
 *  shadow "state and explain". */
const COMMAND_WORDS = [
  "compare and contrast", "describe and explain", "state and explain",
  "give a reason", "suggest why", "suggest how", "work out", "write down",
  "calculate", "describe", "determine", "evaluate", "explain", "identify",
  "justify", "predict", "sketch", "suggest", "compare", "complete", "define",
  "discuss", "estimate", "outline", "analyse", "assess", "deduce", "derive",
  "label", "prove", "show", "solve", "state", "give", "draw", "list", "name",
  "plot", "find",
];

export function commandWord(text) {
  const t = String(text ?? "").toLowerCase();
  for (const w of COMMAND_WORDS) {
    // Must open a clause, not appear mid-sentence ("the state of the gas").
    // A clause opens at the start, after sentence punctuation, after a newline,
    // or after a part label: "(i) Calculate the acceleration."
    if (new RegExp(`(^|[.;:)]\\s*|\\n\\s*)${w}\\b`).test(t)) return w;
  }
  return null;
}

/* ------------------------------------------------------------- topic sets -- */

/**
 * Fallback vocabularies for the common subjects, used when no syllabus PDF has
 * been ingested for that subject yet. Deliberately coarse. A dozen buckets a
 * student would recognise, matching how revision guides are organised.
 */
const FALLBACK_TOPICS = {
  "0625": ["Motion, forces and energy", "Thermal physics", "Waves", "Electricity and magnetism",
           "Nuclear physics", "Space physics"],
  "0620": ["States of matter", "Atoms, elements and compounds", "Stoichiometry", "Electrochemistry",
           "Chemical energetics", "Chemical reactions", "Acids, bases and salts",
           "The Periodic Table", "Metals", "Chemistry of the environment", "Organic chemistry",
           "Experimental techniques and chemical analysis"],
  "0610": ["Characteristics of living organisms", "Organisation of the organism", "Movement in and out of cells",
           "Biological molecules", "Enzymes", "Plant nutrition", "Human nutrition", "Transport in plants",
           "Transport in animals", "Diseases and immunity", "Gas exchange", "Respiration", "Excretion",
           "Coordination and response", "Drugs", "Reproduction", "Inheritance", "Variation and selection",
           "Organisms and their environment", "Human influences on ecosystems", "Biotechnology"],
  "0580": ["Number", "Algebra and graphs", "Coordinate geometry", "Geometry", "Mensuration",
           "Trigonometry", "Transformations and vectors", "Probability", "Statistics"],
  "0455": ["The basic economic problem", "The allocation of resources", "Microeconomic decision makers",
           "Government and the macroeconomy", "Economic development", "International trade and globalisation"],
  "0450": ["Understanding business activity", "People in business", "Marketing", "Operations management",
           "Financial information and decisions", "External influences on business activity"],
  "0478": ["Data representation", "Data transmission", "Hardware", "Software", "The internet and its uses",
           "Automated and emerging technologies", "Algorithm design and problem-solving",
           "Programming", "Databases", "Boolean logic"],
  "0460": ["Population and settlement", "The natural environment", "Economic development",
           "Geographical skills"],
};

/** Topics for a subject: real syllabus sections if ingested, else the fallback. */
export async function topicVocabulary(db, subjectCode) {
  const { data } = await db
    .from("chunks")
    .select("topic")
    .eq("subject_code", subjectCode)
    .eq("kind", "syllabus")
    .not("topic", "is", null)
    .limit(500);

  const fromSyllabus = [...new Set((data ?? []).map((r) => r.topic).filter(Boolean))];
  if (fromSyllabus.length >= 4) return fromSyllabus;
  return FALLBACK_TOPICS[subjectCode] ?? [];
}

/* ----------------------------------------------------------- classifying -- */

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "number", description: "Index from the input list." },
          topic: { type: "string", description: "Exactly one label from TOPICS." },
          refs: { type: "array", items: { type: "string" }, description: "Syllabus reference codes if visible." },
        },
        required: ["i", "topic"],
      },
    },
  },
  required: ["items"],
};

const SYSTEM = `
You label IGCSE exam questions with the syllabus topic they test.

Rules:
- Choose EXACTLY ONE label, copied character-for-character from the TOPICS
  list. Never invent a label, never merge two, never return a variation.
- Judge by what the question actually assesses, not by surface vocabulary. A
  question mentioning a car that is really about energy conservation is energy.
- If nothing in TOPICS fits, use the closest one. Do not return an empty topic.
`.trim();

/**
 * Label a batch of question parts in one call. Batching matters: classification
 * is per-question and the free tier is per-request, so 40 questions in one
 * request is 40x cheaper in quota than 40 requests.
 */
export async function classifyBatch(parts, topics, subjectName) {
  if (!LLM_CLASSIFY || topics.length === 0 || parts.length === 0) {
    return parts.map(() => ({ topic: null, refs: [] }));
  }

  const list = parts.map((p, i) => ({
    i,
    q: String(p.text).replace(/\s+/g, " ").slice(0, 320),
  }));

  let items = [];
  try {
    ({ items } = await generateJSON(
      [
        `SUBJECT: ${subjectName}`,
        `TOPICS:\n${topics.map((t) => `- ${t}`).join("\n")}`,
        `QUESTIONS:\n${JSON.stringify(list)}`,
      ].join("\n\n"),
      SCHEMA,
      { system: SYSTEM, maxOutputTokens: 4096 },
    ));
  } catch (e) {
    console.warn(`  classification failed (${e.message}): questions stay untagged`);
    return parts.map(() => ({ topic: null, refs: [] }));
  }

  // Snap every returned label back onto the vocabulary. The model is told to
  // copy exactly; this makes it true.
  const canon = new Map(topics.map((t) => [normalise(t), t]));
  const out = parts.map(() => ({ topic: null, refs: [] }));
  for (const it of items ?? []) {
    if (typeof it.i !== "number" || !out[it.i]) continue;
    out[it.i] = {
      topic: canon.get(normalise(it.topic)) ?? nearest(it.topic, topics),
      refs: Array.isArray(it.refs) ? it.refs.slice(0, 6) : [],
    };
  }
  return out;
}

function normalise(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Cheap nearest-label match for the occasional near-miss. */
function nearest(label, topics) {
  const n = normalise(label);
  if (!n) return null;
  let best = null, bestScore = 0;
  for (const t of topics) {
    const score = overlap(n, normalise(t));
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function overlap(a, b) {
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (long.includes(short)) return short.length / long.length;
  let hits = 0;
  for (let i = 0; i < short.length - 2; i++) {
    if (long.includes(short.slice(i, i + 3))) hits++;
  }
  return hits / Math.max(1, short.length - 2);
}
