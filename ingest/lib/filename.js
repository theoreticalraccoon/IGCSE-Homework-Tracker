/**
 * Cambridge encodes everything you need in the filename, which is far more
 * reliable than reading it off the cover page:
 *
 *   0625_s19_qp_42.pdf  →  Physics, Jun 2019, question paper, paper 4 variant 2
 *   0620_w21_ms_22.pdf  →  Chemistry, Nov 2021, mark scheme, paper 2 variant 2
 *   0580_m23_qp_12.pdf  →  Maths, Mar 2023, question paper, paper 1 variant 2
 *   0625_y20_sy.pdf     →  Physics syllabus for 2020
 *
 * Session letters are the confusing part and are wrong in most scrapers:
 * s = May/June (summer), w = Oct/Nov (winter), m = Feb/March.
 */

const SESSION = { m: "Mar", s: "Jun", w: "Nov" };
const KINDS = new Set(["qp", "ms", "sy", "er", "gt", "in", "ci"]);

/**
 * @returns {{subjectCode,kind,year,session,paperNo,variant,code}|null}
 */
export function parseFilename(name) {
  const base = name.replace(/\.pdf$/i, "").trim().toLowerCase();

  // 0625_s19_qp_42  |  0625_s19_qp_4  |  0625_y20_sy  |  E-4MA1_s24_qp_13
  //
  // The subject token is a Cambridge 4-digit code, or a board-prefixed code
  // for anything else: E-4MA1 (Edexcel), X-PSY (a school course). Cambridge is
  // not the only board, and other boards' codes contain letters.
  const m = base.match(
    /^(\d{4}|[a-z]{1,3}-[a-z0-9]{2,12})[_-]([mswy])(\d{2})[_-]([a-z]{2})(?:[_-](\d)(\d)?)?$/,
  );
  if (!m) return looseParse(base);

  const [, rawCode, letter, yy, kind, paper, variant] = m;
  if (!KINDS.has(kind)) return null;

  const subjectCode = normaliseCode(rawCode);
  const year = 2000 + Number(yy);
  return {
    subjectCode,
    kind: normaliseKind(kind),
    year,
    session: SESSION[letter] ?? null, // 'y' (syllabus) has no session
    paperNo: paper ? Number(paper) : null,
    variant: variant ? Number(variant) : null,
    code: `${subjectCode}_${letter}${yy}_${kind}${paper ? `_${paper}${variant ?? ""}` : ""}`,
  };
}

/**
 * Tolerate the hand-renamed files people actually have on disk.
 *
 * Word boundaries are useless here. Underscores are word characters, so
 * `\b(\d{4})\b` never matches the code in `0625_june_2019_ms.pdf` and happily
 * matches the *year* in `physics 2019 june.pdf`. Digit-run boundaries are used
 * instead, and any 4-digit run that looks like a year is rejected as a code.
 */
function looseParse(base) {
  const prefixed = base.match(/(?:^|[^a-z0-9])([a-z]{1,3}-[a-z0-9]{2,12})(?=[^a-z0-9]|$)/)?.[1];
  const runs = [...base.matchAll(/(?:^|[^0-9])(\d{4})(?=[^0-9]|$)/g)].map((m) => m[1]);
  const subject = prefixed ?? runs.find((n) => !/^(19|20)\d{2}$/.test(n));
  if (!subject) return null;

  const explicitYear = runs.find((n) => /^20\d{2}$/.test(n));
  const shortYear = base.match(/(?:^|[^a-z0-9])[msw](\d{2})(?:[^0-9]|$)/)?.[1];
  const year = Number(explicitYear ?? (shortYear ? `20${shortYear}` : 0)) || null;

  // Same trap as above: `\b` does not fire around underscores, so "_ms_" would
  // never be recognised and every mark scheme would be filed as a question
  // paper. Separator classes are used throughout instead.
  const has = (alt) => new RegExp(`(?:^|[^a-z0-9])(?:${alt})(?:[^a-z0-9]|$)`).test(base);

  let session = null;
  if (has("june|summer|may")) session = "Jun";
  else if (has("nov|november|winter|oct|october")) session = "Nov";
  else if (has("mar|march|feb|february")) session = "Mar";
  else if (/[^a-z0-9]s\d{2}(?:[^0-9]|$)/.test(base)) session = "Jun";
  else if (/[^a-z0-9]w\d{2}(?:[^0-9]|$)/.test(base)) session = "Nov";
  else if (/[^a-z0-9]m\d{2}(?:[^0-9]|$)/.test(base)) session = "Mar";

  let kind = "qp";
  if (has("ms|mark[ _-]?scheme|markscheme")) kind = "ms";
  else if (has("sy|syllabus")) kind = "sy";
  else if (has("er|examiner[ _-]?report")) kind = "er";
  else if (has("gt|grade[ _-]?thresholds?") || /boundar/.test(base)) kind = "gt";

  const pv = base.match(/(?:^|[^a-z0-9])p(?:aper)?[ _-]?(\d)(\d)?(?:[^0-9]|$)/);

  return {
    subjectCode: normaliseCode(subject),
    kind,
    year,
    session,
    paperNo: pv ? Number(pv[1]) : null,
    variant: pv && pv[2] ? Number(pv[2]) : null,
    code: base,
  };
}

/** Cambridge codes are digits; every other board's carry letters and are upper-cased. */
function normaliseCode(code) {
  return /[a-z]/i.test(code) ? code.toUpperCase() : code;
}

function normaliseKind(k) {
  if (k === "in" || k === "ci") return "qp"; // insert / confidential instructions
  return k;
}

/** Human title for a paper row. */
export function titleFor(meta, subjectName) {
  const bits = [subjectName || meta.subjectCode];
  if (meta.session && meta.year) bits.push(`${meta.session} ${meta.year}`);
  else if (meta.year) bits.push(String(meta.year));
  if (meta.paperNo) bits.push(`Paper ${meta.paperNo}${meta.variant ?? ""}`);
  bits.push(
    { qp: "Question Paper", ms: "Mark Scheme", sy: "Syllabus", er: "Examiner Report", gt: "Grade Thresholds" }[
      meta.kind
    ] ?? meta.kind,
  );
  return bits.join(" · ");
}

/** The qp filename that a ms filename should pair with, and vice versa. */
export function siblingCode(meta, kind) {
  return `${meta.subjectCode}_${sessionLetter(meta.session)}${String(meta.year).slice(2)}_${kind}${
    meta.paperNo ? `_${meta.paperNo}${meta.variant ?? ""}` : ""
  }`;
}

function sessionLetter(session) {
  return { Mar: "m", Jun: "s", Nov: "w" }[session] ?? "y";
}
