# Markwise

**The IGCSE assistant that has actually read the papers.**

Markwise does two things. It tracks your homework, assignments, tuition and deadlines.
And it answers, marks and quizzes you **from the real Cambridge past papers, mark schemes,
examiner reports and syllabus documents**. Not from a language model's recollection of them.

That distinction is the whole project. Ask ChatGPT or Gemini to mark a 6-mark Biology answer
and it will produce a confident breakdown assembled from Reddit, Quora and revision forums.
It has never seen the mark scheme. It invents mark allocations, hallucinates syllabus scope,
and makes up "examiner tips". Markwise retrieves the actual question and the actual marking
points first, and every answer carries the paper code and question number so you can check it.

---

## What it does

**Planner**
- Homework, assessments and revision tasks across school, tuition and self-study
- Due dates, times, estimates and priorities; board, week and list views
- Month calendar with a **workload heatmap**, so a week with three assessments is visible in advance
- Recurring tuition timetable
- Exam-series countdown

**Grounded AI** (the corpus half)
- **Ask**: syllabus scope, content, and technique, answered from real documents with citations
- **Mark my answer**: finds the exact question, marks point-by-point against the real mark
  scheme, shows what you missed, and prints the mark scheme underneath so you can audit it
- **Mock exams**: assembled from real past questions, sat under timer, marked automatically
- **Library**: browse and search the whole corpus; practise any question
- **Similar questions**: vector neighbours of any question, free of charge
- **Progress**: topic mastery built only from marks awarded against real schemes, weak-topic
  ranking, predicted grade from published grade thresholds
- Weak topics feed straight back into mock generation and revision tasks

---

## Architecture

```
Browser (static, no build step)
  │  ES modules · Supabase JS from CDN
  │
  ├─────────► Supabase Postgres ── RLS on every user table
  │             • tasks, profiles, tuition_sessions
  │             • attempts, mocks, chat_*, topic_mastery
  │             • papers, chunks (pgvector), grade_boundaries   ← the corpus
  │             • match_chunks()  hybrid vector + full-text retrieval, RRF-fused
  │
  └─────────► Supabase Edge Functions (Deno) ──► Gemini API
                • ask   streamed, grounded chat (SSE)
                • mark  structured marking against the retrieved scheme
                • mock  paper assembly from real questions
                The Gemini key lives here and only here.

Offline:  ingest/  Node CLI  ──►  PDFs → question parts → paired mark schemes
                                  → classified → embedded → Postgres
```

### Why these choices

| Decision | Reason |
|---|---|
| **No build step** | The frontend is plain ES modules and one stylesheet. It deploys to any static host, opens from disk, and has no toolchain to rot. |
| **Supabase Postgres + pgvector** | One free service gives auth, relational data, row-level security *and* the vector index. A separate vector DB would add a second system with its own auth story for no benefit at this scale. |
| **Hybrid retrieval, RRF-fused** | Pure vector search cannot find `0625_s19_qp_42 Q4(b)`; pure keyword search cannot find "why does the parachute slow down" → terminal velocity. RRF fuses both ranks without needing to normalise cosine distance against `ts_rank`. |
| **HNSW, not IVFFlat** | The corpus grows continuously during ingestion. IVFFlat needs retraining as rows land; HNSW does not. |
| **Mark scheme denormalised onto the question row** | One retrieval hit answers both "what was asked" and "what earns the marks". A second lookup per hit would double latency on the hottest path. |
| **Edge functions for all AI** | The Gemini key never reaches the browser, and per-user daily quotas are enforced server-side where they cannot be bypassed. |
| **The model never writes mock questions** | It returns an *ordering of ids*; the server reconstitutes each question verbatim from the database. A model that can rewrite a question can rewrite it wrong. |
| **Verbatim everything** | Parsers copy; they never paraphrase. A paraphrased mark scheme cannot be marked against. |

---

## Setup

Full instructions: **[SETUP.md](SETUP.md)**, and **[docs/PAPERS.md](docs/PAPERS.md)** for how to
name and organise the PDFs. In short:

1. **Database**: run the five files in `supabase/migrations/` in the Supabase SQL editor, in
   filename order (or `supabase db push`). The last one migrates the original tracker's
   subject names onto syllabus codes, so existing accounts keep their tasks.
2. **Edge functions**: `supabase functions deploy ask mark mock`, then set
   `GEMINI_API_KEYS` as a function secret.
3. **Frontend**: point `SUPABASE_URL` / `SUPABASE_KEY` in `src/js/config.js` at your project
   and serve `index.html` from any static host.
4. **Corpus**: see below. Without it the planner works fully and the AI features tell you
   honestly that they have nothing to ground on.

---

## Ingestion. The hard part

The app is only as good as its corpus, and building that corpus is the real engineering
problem. Cambridge IGCSE alone is ~30 subjects × 3 sessions a year × multiple papers and
variants × a decade: tens of thousands of PDFs and hundreds of thousands of question parts.

```bash
cd ingest
npm install
cp .env.example .env        # service-role key + one or more Gemini keys

# Syllabus first: its section headings become the topic vocabulary that every
# question in that subject is classified against.
node ingest.js syllabus --file ./pdfs/0625_y25_sy.pdf

# Then the papers. Question papers, mark schemes and examiner reports for the
# same paper are grouped automatically by filename.
node ingest.js papers --dir ./pdfs --subject 0625

# Optional extras
node ingest.js boundaries --dir ./pdfs     # enables predicted grades
node ingest.js classify                    # tag topics (separate: it hits quota first)
node ingest.js reembed                     # retry any chunk that failed to embed
node ingest.js status                      # coverage report
```

Name files the way the boards do: `0625_s19_qp_42.pdf` (Cambridge),
`E-4MA1_s24_qp_13.pdf` (Edexcel). And subject, session, year, paper and variant
are all parsed from the filename. See **[docs/PAPERS.md](docs/PAPERS.md)**.

### What makes it difficult

- **Layout.** Exam PDFs put mark allocations in a right-hand column and mark schemes in tables.
  Naive text extraction scrambles both. `lib/pdf.js` reconstructs visual lines from pdf.js text
  item coordinates before any parsing happens.
- **Question ↔ mark scheme alignment.** No public dataset gives you this join. `lib/pair.js`
  matches in three passes, strictest first, and leaves anything ambiguous unpaired. A question
  marked against the *wrong* scheme is the worst failure this app can have, far worse than one
  that simply cannot be marked.
- **Scans.** Older papers have no text layer. Pages with a thin text layer are detected and can
  be OCR'd through Gemini's vision model (`--ocr`, needs the optional `canvas` package).
- **Topic consistency.** "Forces" and "Forces and motion" as separate topics would shatter the
  mastery table into noise, so classification is constrained to the syllabus's own section
  names and every label is snapped back onto that vocabulary.
- **Model churn.** Google retires models and meters quota per model as well as per key, so
  both Gemini clients take a fallback chain and walk it on 429/503 instead of failing.
- **Free-tier quota.** Embedding is the expensive half. Keys rotate round-robin, 429s park a key
  for a minute rather than failing the run, embeddings batch 96 at a time, and runs are
  resumable by file hash: re-running after a crash costs almost nothing.

Set `INGEST_LLM_PARSE=0` to run the deterministic parsers only: free, faster, and adequate for
well-laid-out modern papers.

### Copyright

Past papers are © Cambridge University Press & Assessment. Ingest only material you are
licensed to use, and keep a Markwise deployment private to yourself or your school.

---

## Layout

```
index.html                     app shell
src/css/app.css                one stylesheet, light + dark
src/js/
  app.js                       bootstrap, auth gate
  router.js                    hash router
  store.js                     observable app state
  theme.js
  config.js                    Supabase URL + publishable key
  api/  client.js              Supabase client, SSE transport
        data.js                every table read/write
        ai.js                  the three AI routes
  ui/   dom.js  feedback.js    escaping, markdown, modals, toasts
  lib/  dates.js
  views/ today planner calendar ask mark mock library progress settings auth
supabase/
  migrations/                  schema, seed, AI usage caps
  functions/
    _shared/  gemini.ts retrieve.ts prompts.ts db.ts quota.ts http.ts
    ask/ mark/ mock/
ingest/
  ingest.js                    CLI
  lib/  pdf parse pair classify syllabus filename gemini db config
```

---

## Tests

```bash
npm install   # esbuild, for the one block that compiles a TS module
npm test
```

[`test/logic.test.mjs`](test/logic.test.mjs): 70 assertions, no database or network. It covers
the places where a silent bug is expensive: filename parsing, question segmentation, the
question-to-mark-scheme pairing rules, retrieval query parsing, dates, and HTML escaping.

```bash
npm run test:functions
```

[`ingest/smoke-functions.mjs`](ingest/smoke-functions.mjs): hits the **deployed** edge functions
over HTTP as a throwaway user, then deletes them. Run it after every deploy; unit tests cannot
catch a missing secret, a model Google has retired, or a policy that blocks the service.

---

## Keyboard

`T` today · `P` planner · `C` calendar · `A` ask · `M` mark · `K` mocks · `L` library · `G` progress
