# How to give Markwise the past papers

Everything the pipeline needs is carried in the **filename**. Get the names right and one
command ingests a whole subject. Get them wrong and files are skipped with a warning.

You do not send the papers to me. You put them in a folder on your machine and run the
ingestion CLI against it. The PDFs never leave your computer except as extracted text sent
to Gemini for parsing and embedding.

---

## The naming pattern

```
<subject>_<session><yy>_<kind>_<paper><variant>.pdf
```

| Part | Meaning | Examples |
|---|---|---|
| `subject` | Cambridge 4-digit code, or a board-prefixed code | `0625` Physics, `0580` Maths, `E-4MA1` Edexcel Maths A |
| `session` | **`s`** = May/June · **`w`** = Oct/Nov · **`m`** = Feb/March | `s19`, `w21`, `m23` |
| `yy` | two-digit year | `19` = 2019 |
| `kind` | `qp` question paper · `ms` mark scheme · `er` examiner report · `sy` syllabus · `gt` grade thresholds | |
| `paper` | paper number | `4` |
| `variant` | variant number | `2` |

Worked examples:

```
0625_s19_qp_42.pdf    Physics, May/June 2019, question paper, paper 4 variant 2
0625_s19_ms_42.pdf    …its mark scheme            ← REQUIRED for marking
0625_s19_er_4.pdf     …its examiner report        ← optional, adds "what most candidates got wrong"
0625_y25_sy.pdf       Physics syllabus for 2025   ← ingest this FIRST
0625_s19_gt.pdf       Grade thresholds            ← optional, enables predicted grades
```

This is the exact scheme Cambridge and every past-paper mirror already use, so **downloaded
Cambridge files usually need no renaming at all.** Other boards need the board
prefix added: see *Non-Cambridge* below.

---

## Folder layout

One flat folder per subject is simplest. Nested folders work too. The CLI walks
subdirectories.

```
ingest/pdfs/
  0625_y25_sy.pdf
  0625_s19_qp_42.pdf
  0625_s19_ms_42.pdf
  0625_s19_er_4.pdf
  0625_s19_gt.pdf
  0625_w19_qp_42.pdf
  0625_w19_ms_42.pdf
  ...
```

**The question paper and its mark scheme must be in the same run.** They are matched by
subject + session + year + paper + variant. A question paper ingested without its mark scheme
is searchable but can never be marked. And re-running later with the mark scheme present
will not retroactively pair it unless the question paper is re-ingested (change or re-add the
file so its hash differs, or delete its rows).

---

## What to collect, in priority order

1. **The syllabus** for each subject (`_sy`). One file. Highest value per megabyte in the
   whole corpus: its section headings become the topic vocabulary that every question is
   classified against, which is what makes the weakness profile and topic-targeted mocks
   work. **Ingest it before the papers.**
2. **Question paper + mark scheme pairs** (`_qp` and `_ms`). Always together. Without the
   mark scheme, marking is impossible and that is the flagship feature.
3. **Examiner reports** (`_er`). Optional but valuable. They are the source of "most
   candidates lost marks here by…", which no general chatbot has.
4. **Grade thresholds** (`_gt`). Optional. Only needed for predicted grades.

### How much to start with

Do **one subject, two sessions** first: about 8 files. That proves the parser works on your
actual PDFs before you spend hours collecting. Then scale.

| Scope | Files | Rough ingestion time |
|---|---|---|
| Proof run: 1 subject, 2 sessions | ~8 | 2–5 min |
| 1 subject, 5 years | ~60 | 20–40 min |
| 1 subject, 10 years, all variants | ~250 | 1.5–3 hours |
| 6 subjects, 10 years | ~1,500 | most of a day |

Times assume two Gemini keys. Rate limits, not CPU, are the bottleneck. A second free key
roughly halves the wall clock.

### Which papers are worth having

- **Recent years first.** Syllabuses change; a 2011 question may be off-syllabus now. The last
  5–8 years is the sweet spot.
- **All variants.** Variants 1/2/3 are different papers with different questions: all useful.
- **Extended tier** if the student sits Extended (papers 2, 4, 6 for sciences).
- Skip `_in` (inserts) and `_ci` (confidential instructions); they carry no markable questions.

---

## Running it

```bash
cd ingest
npm install                 # first time only
cp .env.example .env        # fill in service-role key + Gemini key(s)

# 1. Syllabus first
node ingest.js syllabus --file ./pdfs/0625_y25_sy.pdf

# 2. Papers
node ingest.js papers --dir ./pdfs --subject 0625

# 3. Optional
node ingest.js boundaries --dir ./pdfs
node ingest.js classify        # tags topics; safe to re-run if quota ran out
node ingest.js status
```

Drop `--subject` to ingest everything in the folder at once.

### What good output looks like

```
Found 8 PDFs in ./pdfs
4 paper group(s) to process.

  0625_s19_qp_42: 41 parts · 38 with mark scheme (exact 31, fuzzy 6, root 1)
  0625_w19_qp_42: 39 parts · 39 with mark scheme (exact 35, fuzzy 4, root 0)

Done.
  papers ingested : 4 (0 unchanged, skipped)
  question chunks : 156
  with mark scheme: 149
  without         : 7
```

**The number that matters is "with mark scheme".** Above ~85% means the pipeline is working.
Below ~50% means something is wrong: see below.

---

## If it goes wrong

| Output | Cause | Fix |
|---|---|---|
| `N file(s) had unrecognisable names` | Filenames don't match the pattern | Rename them, or accept best-effort parsing |
| `no question paper, only a mark scheme` | The `_qp` file is missing or misnamed | Add it |
| `layout defeated the parser, retrying with the model` | Normal on some papers. Not an error |, |
| `no questions extracted` | Scanned PDF with no text layer | `npm install canvas`, re-run with `--ocr` |
| Very low "with mark scheme" | Mark scheme PDFs missing, or MS layout unparsed | Check both files are present; ensure `INGEST_LLM_PARSE=1` |
| `embedding batch failed` | Gemini rate limit | Harmless: run `node ingest.js reembed` afterwards |

Send me the console output of a run and I can tell you which of these it is, and tune
[`ingest/lib/parse.js`](../ingest/lib/parse.js) against the specific layout if needed.

---

## Non-Cambridge and school subjects

Courses with no syllabus of their own: Extra Maths, Single Science Physics, Further Pure
Maths: are set up to **borrow another subject's corpus** via `subjects.corpus_code`
(see migration `20260914000300`). Ingest `0580` and Extra Maths students get 0580's questions;
you do not ingest anything separately for them.

Edexcel, AQA and OCR are supported. Prefix the code with the board: `E-`
Edexcel, `A-` AQA, `O-` OCR, `X-` a school course. So it can never collide
with a Cambridge four-digit code:

```
E-4MA1_s24_qp_13.pdf    Edexcel International GCSE Maths A, May/June 2024, paper 1 variant 3
E-4MA1_s24_ms_13.pdf    …its mark scheme
E-4MA1_y26_sy.pdf       …the specification
```

The subject row is created automatically on first ingest, named after its code.
Give it a real name once:

```sql
update public.subjects set name = 'Mathematics A' where code = 'E-4MA1';
```

Both layouts are read deterministically: Cambridge marks a part `[3]`, Edexcel
puts `(3)` on its own line and closes with
`(Total for Question 1 is 3 marks)`. Where a layout still defeats the parser,
the model re-reads that paper alone rather than the whole run.

---

## Copyright

Past papers, mark schemes, examiner reports and syllabuses are © Cambridge University Press &
Assessment. Ingest only material you are licensed to use, and keep the deployment private to
yourself or your school. Do not publish a Markwise instance containing this content.
