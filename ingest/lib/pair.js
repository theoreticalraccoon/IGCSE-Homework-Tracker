/**
 * Pairing question parts with their marking points.
 *
 * This is the join no public dataset gives you, and it is what makes "mark my
 * answer" possible. Both sides are parsed independently from two different
 * PDFs whose numbering agrees in principle and disagrees in practice —
 * "4(b)(ii)" in the paper can appear as "4(b)(ii)", "4 b ii", "4(b)ii" or
 * "4bii" in the scheme.
 *
 * Matching therefore runs in three passes, strictest first, and anything left
 * unmatched is left unmatched. An unpaired question is still useful for
 * retrieval and mock generation; a *wrongly* paired one would have the marking
 * route grading an answer against a different question's mark scheme, which is
 * the single worst failure this app can have.
 */

/** '4(b)(ii)' → '4bii' */
function key(no) {
  return String(no ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** '4(b)(ii)' → ['4','b','ii'] */
function segments(no) {
  const k = key(no);
  const m = k.match(/^(\d+)([a-h])?((?:i|v|x)+)?$/);
  return m ? [m[1], m[2] ?? "", m[3] ?? ""] : [k];
}

export function pairQuestions(questions, msRows) {
  const byKey = new Map();
  for (const r of msRows) {
    const k = key(r.questionNo);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }

  const stats = { exact: 0, normalised: 0, root: 0, unmatched: 0 };

  const paired = questions.map((q) => {
    const qk = key(q.questionNo);

    // 1. Exact key match.
    let ms = byKey.get(qk);
    if (ms) {
      stats.exact++;
      return merge(q, ms);
    }

    // 2. Same question and same part, tolerating only a missing SUB-part level
    //    (schemes often fold "(a)(i)" into one row when (a) has a single part).
    //
    //    The part level is matched strictly. Letting "4(b)" match a row for
    //    "4" would mark a student's answer against the whole question's
    //    scheme, which is worse than not marking it at all.
    const [qn, qp, qs] = segments(q.questionNo);
    for (const [k, row] of byKey) {
      const [rn, rp, rs] = segments(k);
      if (rn !== qn) continue;
      if ((qp || "") !== (rp || "")) continue;
      if (qs && rs && qs !== rs) continue;
      stats.normalised++;
      return merge(q, row);
    }

    // 3. Whole-question fallback: attach the root row, but only when the
    //    question has no parts — otherwise every part would get the same
    //    scheme and marking would be nonsense.
    if (!qp && !qs) {
      const rootRow = byKey.get(qn);
      if (rootRow) {
        stats.root++;
        return merge(q, rootRow);
      }
    }

    stats.unmatched++;
    return { ...q, msText: null, msMarks: null };
  });

  return { paired, stats };
}

function merge(q, ms) {
  return {
    ...q,
    msText: ms.text,
    msMarks: ms.marks ?? null,
    // The paper's own [n] is authoritative; the scheme's count is the fallback.
    marks: q.marks ?? ms.marks ?? null,
  };
}

/**
 * Attach examiner-report commentary. Reports discuss questions loosely
 * ("Question 4(b) was poorly answered…"), so matching is by root question only
 * and the text is attached as context, never as a marking authority.
 */
export function attachExaminerReport(paired, reportPages) {
  if (!reportPages?.length) return paired;
  const text = reportPages.map((p) => p.text).join("\n");
  const sections = new Map();

  const re = /question\s*(\d{1,2})\s*(?:\(([a-h])\))?/gi;
  const marks = [...text.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const root = marks[i][1];
    const body = text.slice(start, end).trim();
    if (body.length < 40) continue;
    sections.set(root, (sections.get(root) ?? "") + "\n" + body);
  }

  return paired.map((q) => ({
    ...q,
    erText: sections.get(String(q.questionRoot))?.trim().slice(0, 2000) ?? null,
  }));
}
