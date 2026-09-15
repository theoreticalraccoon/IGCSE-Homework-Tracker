# Markwise: setup

Four steps. The first two are required; the app runs as a planner after step 2 and gains its
AI features after step 3. Step 4 is the corpus, which is what makes the AI worth using.

---

## 1. Database

Open **SQL Editor → New query** in Supabase and run these five files **in order**:

| # | File | What it adds |
|---|---|---|
| 1 | `supabase/migrations/20260707000000_init.sql` | `tasks`, `profiles`, row-level security |
| 2 | `supabase/migrations/20260914000000_markwise.sql` | corpus tables, pgvector, retrieval functions, study record |
| 3 | `supabase/migrations/20260914000100_seed_subjects.sql` | the IGCSE subject catalogue |
| 4 | `supabase/migrations/20260914000200_ai_usage.sql` | per-user daily AI caps |
| 5 | `supabase/migrations/20260914000300_map_legacy_subjects.sql` | migrates old subject **names** → syllabus **codes**, adds `corpus_code` |

File 5 rewrites `tasks.subject` and `profiles.subjects` from `"Physics"` to `"0625"`, so
existing accounts keep their tasks and do not have to re-pick subjects. It prints a notice
saying whether anything was left unmapped. Skip it only on a brand-new project with no data.

Each is safe to re-run.

> **`extension "vector" is not available`**: enable it under **Database → Extensions →
> `vector`**, then run file 2 again.

Or with the CLI:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

### Make sign-up instant (recommended)

**Authentication → Sign In / Providers → Email** → turn **Confirm email** *off*.
The app works either way; with it on, new users must confirm before their first sign-in.

### Password reset links (only if you host it)

**Authentication → URL Configuration** → set **Site URL** to where you host `index.html`
and add the same URL under **Redirect URLs**.

---

## 2. Frontend

Nothing to build. Serve the folder statically:

```bash
python -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

If you are using your own Supabase project, change `SUPABASE_URL` and `SUPABASE_KEY` at the
top of [`src/js/config.js`](src/js/config.js). The publishable key is meant to be public
every table is protected by row-level security, so on its own it grants nothing.

Deploy by uploading the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages,
Vercel). There is no server component other than the edge functions below.

---

## 3. AI: edge functions

The Gemini key must never be in the browser. It lives as a Supabase function secret.

```bash
# 1. Get a free key (or several) from https://aistudio.google.com/apikey
#    Free-tier limits are PER KEY, so two keys double your throughput.
supabase secrets set GEMINI_API_KEYS="key1,key2"

# Optional. GEMINI_CHAT_MODEL is a FALLBACK CHAIN, tried left to right: free
# tier quota is per model as well as per key, so when one is exhausted the
# request continues on the next instead of failing.
supabase secrets set GEMINI_CHAT_MODEL="gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite"
supabase secrets set GEMINI_EMBED_MODEL="gemini-embedding-001"
supabase secrets set ALLOWED_ORIGINS="https://your-app-host"   # defaults to *

# 2. Deploy
supabase functions deploy ask
supabase functions deploy mark
supabase functions deploy mock
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
platform. You do not set those.

### Daily limits

Edit the `ai_limits` table to change them; no redeploy needed.

```sql
update public.ai_limits set per_day = 100 where route = 'ask';
```

Defaults: ask 60, mark 40, mock 8, similar 40 per user per day. Students see their remaining
allowance in **Settings**.

---

## 4. Corpus

Without this the planner works fully and the AI screens say plainly that they have nothing to
ground on. Which is the honest behaviour, and better than answering anyway.

```bash
cd ingest
npm install
cp .env.example .env
```

Fill in `.env`:

- `SUPABASE_URL`: same project
- `SUPABASE_SERVICE_ROLE_KEY`: **Project Settings → API → service_role**. This bypasses RLS.
  It belongs in this file and nowhere else. Never put it in `src/` or in a function that
  handles user input.
- `GEMINI_API_KEYS`. One or more, comma-separated

See **[docs/PAPERS.md](docs/PAPERS.md)** for file naming, folder layout, what to collect and
how long it takes.

Then, per subject:

```bash
# Syllabus first. Its section names become the topic vocabulary.
node ingest.js syllabus --file ./pdfs/0625_y25_sy.pdf

# Papers. Put question papers, mark schemes and examiner reports in one folder;
# they are grouped by filename.
node ingest.js papers --dir ./pdfs --subject 0625

# Optional
node ingest.js boundaries --dir ./pdfs   # unlocks predicted grades
node ingest.js classify                  # tag topics (run alone if quota ran out)
node ingest.js status                    # what is ingested
```

Classification is the first step to hit a quota ceiling, and it is a separate
command for exactly that reason: running out of requests should cost you the
topic labels, not the whole parse. Re-run `classify` later and it picks up the
questions that were left untagged.

Expect to see something like:

```
  0625_s19_qp_42: 41 parts · 38 with mark scheme (exact 31, fuzzy 6, root 1)
```

A low "with mark scheme" count means the mark scheme PDFs are missing from the folder, or
that paper's layout defeated the parser: try again with `INGEST_LLM_PARSE=1` (the default).

For scanned papers add `--ocr` and install the optional renderer:

```bash
npm install canvas
node ingest.js papers --dir ./pdfs --ocr
```

### Naming

Cambridge's own filenames carry everything needed:

```
0625_s19_qp_42.pdf   Physics, May/June 2019, question paper, paper 4 variant 2
0620_w21_ms_22.pdf   Chemistry, Oct/Nov 2021, mark scheme, paper 2 variant 2
0580_m23_qp_12.pdf   Maths, Feb/March 2023, question paper, paper 1 variant 2
0625_y25_sy.pdf      Physics syllabus for 2025
0625_s19_gt.pdf      Grade thresholds
```

Session letters: `s` = May/June, `w` = Oct/Nov, `m` = Feb/March.

---

## Checks

| Symptom | Cause |
|---|---|
| "No ingested subjects" everywhere | No corpus yet: step 4 |
| Ask returns "nothing matched" | Chunks have no embeddings: `node ingest.js reembed` |
| "Daily limit reached" | Expected: raise it in `ai_limits`, or wait for midnight UTC |
| Mark says "no mark scheme" | That question is unpaired. Normal for some papers; the question is still searchable |
| Functions return 401 | Signed-out session, or the function was deployed with `--no-verify-jwt` |
| Functions return 500 mentioning Gemini | `GEMINI_API_KEYS` not set as a secret |
| `model … is not found` or `no longer available` | Google retired it. Ask your key what it can use: `curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"` |
| Everything 429s on one model | That model's daily quota is spent. The chain covers it: add another model or another key |

Useful:

```sql
select * from public.corpus_coverage;
select count(*) from public.chunks where embedding is null;
select count(*) from public.chunks where kind='question' and ms_content is null;
```

---

## Copyright

Past papers, mark schemes and syllabuses are © Cambridge University Press & Assessment.
Ingest only material you are licensed to use, and keep your deployment private to yourself
or your school.
