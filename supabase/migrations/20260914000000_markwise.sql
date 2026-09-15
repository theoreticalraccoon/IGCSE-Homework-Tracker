-- ============================================================================
-- Markwise: retrieval-grounded iGCSE assistant.
-- Adds the exam corpus (papers, mark schemes, syllabuses), the vector index
-- used for RAG, and the per-user study record built on top of it.
--
-- Safe to run more than once. Run AFTER 20260707000000_init.sql.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 0. Planner upgrades. The original tracker only knew school/tuition homework.
-- ---------------------------------------------------------------------------

alter table public.tasks add column if not exists notes         text;
alter table public.tasks add column if not exists due_time      time;
alter table public.tasks add column if not exists priority      smallint not null default 1;  -- 0 low, 1 normal, 2 high
alter table public.tasks add column if not exists topic         text;
alter table public.tasks add column if not exists estimate_min  integer;
alter table public.tasks add column if not exists done_at       timestamptz;
alter table public.tasks add column if not exists remind_at     timestamptz;
alter table public.tasks add column if not exists origin        text not null default 'manual';  -- manual | ai | mock
alter table public.tasks add column if not exists origin_ref    uuid;

-- Widen the type/source vocabularies (revision tasks, self-study).
alter table public.tasks drop constraint if exists tasks_type_check;
alter table public.tasks add  constraint tasks_type_check
  check (type in ('homework','assessment','revision'));

alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add  constraint tasks_source_check
  check (source in ('school','tuition','self'));

create index if not exists tasks_due_idx on public.tasks (user_id, due) where done = false;

-- Profile additions: which exam series they are sitting, and their board.
alter table public.profiles add column if not exists exam_session  text;    -- e.g. 'Jun 2027'
alter table public.profiles add column if not exists display_name  text;
alter table public.profiles add column if not exists board         text not null default 'Cambridge';


-- ---------------------------------------------------------------------------
-- 1. Recurring tuition timetable
-- ---------------------------------------------------------------------------

create table if not exists public.tuition_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject    text not null,
  tutor      text,
  weekday    smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_time time not null,
  end_time   time,
  location   text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists tuition_sessions_user_idx on public.tuition_sessions (user_id, weekday);
alter table public.tuition_sessions enable row level security;

drop policy if exists "tuition_own" on public.tuition_sessions;
create policy "tuition_own" on public.tuition_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 2. The corpus: public exam content, readable by any signed-in user,
--    writable only by the ingestion pipeline (service-role key).
-- ---------------------------------------------------------------------------

create table if not exists public.subjects (
  code   text primary key,              -- '0625'
  board  text not null default 'Cambridge',
  name   text not null,                 -- 'Physics'
  level  text not null default 'IGCSE',
  active boolean not null default true
);

create table if not exists public.papers (
  id           uuid primary key default gen_random_uuid(),
  subject_code text not null references public.subjects (code) on delete cascade,
  kind         text not null check (kind in ('qp','ms','sy','er','gt')),
  -- qp question paper · ms mark scheme · sy syllabus · er examiner report · gt grade thresholds
  year         integer,
  session      text check (session in ('Mar','Jun','Nov')),
  paper_no     integer,
  variant      integer,
  title        text not null,
  code         text,                          -- '0625_s19_qp_42'
  source_url   text,
  pages        integer,
  sha256       text,
  ingested_at  timestamptz not null default now(),
  unique (subject_code, kind, year, session, paper_no, variant)
);

create index if not exists papers_subject_idx on public.papers (subject_code, kind, year desc);

-- The retrievable unit. One row per question part (or syllabus section), with
-- its mark scheme denormalised alongside so a single hit answers "what was
-- asked" AND "what earns the marks" without a second lookup.
create table if not exists public.chunks (
  id            uuid primary key default gen_random_uuid(),
  paper_id      uuid not null references public.papers (id) on delete cascade,
  subject_code  text not null,
  kind          text not null check (kind in ('question','markscheme','syllabus','examiner_report')),
  paper_code    text,                 -- '0625_s19_qp_42': what citations show
  year          integer,
  session       text,
  paper_no      integer,
  variant       integer,
  question_no   text,                 -- '4(b)(ii)'
  question_root text,                 -- '4': groups parts of one question
  marks         integer,
  command_word  text,                 -- explain | calculate | describe …
  topic         text,
  syllabus_refs text[] not null default '{}',
  content       text not null,        -- the question / syllabus text
  ms_content    text,                 -- paired marking points, verbatim
  er_content    text,                 -- examiner-report commentary on this question
  page          integer,
  embedding     vector(768),
  fts           tsvector generated always as (
                  to_tsvector('english',
                    coalesce(content, '') || ' ' ||
                    coalesce(ms_content, '') || ' ' ||
                    coalesce(topic, '') || ' ' ||
                    coalesce(question_no, ''))
                ) stored,
  created_at    timestamptz not null default now()
);

create index if not exists chunks_subject_idx on public.chunks (subject_code, kind);
create index if not exists chunks_paper_idx   on public.chunks (paper_id);
create index if not exists chunks_topic_idx   on public.chunks (subject_code, topic);
create index if not exists chunks_fts_idx     on public.chunks using gin (fts);

-- HNSW beats IVFFlat here: the corpus grows continuously during ingestion and
-- HNSW needs no retraining as rows land.
do $idx$
begin
  if not exists (select 1 from pg_class where relname = 'chunks_embedding_idx') then
    execute 'create index chunks_embedding_idx on public.chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)';
  end if;
end
$idx$;

-- Grade boundaries, for turning a raw mark into a predicted grade.
create table if not exists public.grade_boundaries (
  id           uuid primary key default gen_random_uuid(),
  subject_code text not null,
  year         integer not null,
  session      text not null,
  paper_no     integer not null,
  grade        text not null,
  min_marks    integer not null,
  max_marks    integer,
  unique (subject_code, year, session, paper_no, grade)
);

alter table public.subjects         enable row level security;
alter table public.papers           enable row level security;
alter table public.chunks           enable row level security;
alter table public.grade_boundaries enable row level security;

-- Exam content is public knowledge: any signed-in user may read it, nobody
-- may write it through the anon/authenticated key.
drop policy if exists "subjects_read" on public.subjects;
create policy "subjects_read" on public.subjects for select to authenticated using (true);

drop policy if exists "papers_read" on public.papers;
create policy "papers_read" on public.papers for select to authenticated using (true);

drop policy if exists "chunks_read" on public.chunks;
create policy "chunks_read" on public.chunks for select to authenticated using (true);

drop policy if exists "gb_read" on public.grade_boundaries;
create policy "gb_read" on public.grade_boundaries for select to authenticated using (true);


-- ---------------------------------------------------------------------------
-- 3. Retrieval: hybrid (vector + full-text) fused with Reciprocal Rank Fusion.
--
-- Pure vector search misses exact identifiers ("0625_s19_qp_42", "Q4(b)");
-- pure keyword search misses paraphrase ("why does it slow down" → friction).
-- RRF needs no score normalisation between the two, which is why it is used
-- instead of a weighted sum of cosine distance and ts_rank.
-- ---------------------------------------------------------------------------

create or replace function public.match_chunks(
  query_embedding vector(768),
  query_text      text    default '',
  p_subject       text    default null,
  p_kinds         text[]  default null,
  p_years         int[]   default null,
  p_paper_code    text    default null,
  p_topic         text    default null,
  match_count     int     default 8,
  pool            int     default 60,
  rrf_k           int     default 60
)
returns table (
  id            uuid,
  subject_code  text,
  kind          text,
  paper_code    text,
  year          integer,
  session       text,
  paper_no      integer,
  variant       integer,
  question_no   text,
  marks         integer,
  command_word  text,
  topic         text,
  syllabus_refs text[],
  content       text,
  ms_content    text,
  er_content    text,
  page          integer,
  score         double precision
)
language sql
stable
security definer
set search_path = public
as $fn$
  with filtered as (
    select c.*
    from public.chunks c
    where (p_subject    is null or c.subject_code = p_subject)
      and (p_kinds      is null or c.kind = any(p_kinds))
      and (p_years      is null or c.year = any(p_years))
      and (p_paper_code is null or c.paper_code ilike '%' || p_paper_code || '%')
      and (p_topic      is null or c.topic = p_topic)
  ),
  semantic as (
    select f.id, row_number() over (order by f.embedding <=> query_embedding) as rnk
    from filtered f
    where query_embedding is not null and f.embedding is not null
    order by f.embedding <=> query_embedding
    limit pool
  ),
  keyword as (
    select f.id,
           row_number() over (
             order by ts_rank_cd(f.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rnk
    from filtered f
    where coalesce(query_text, '') <> ''
      and f.fts @@ websearch_to_tsquery('english', query_text)
    limit pool
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (rrf_k + s.rnk), 0.0) +
           coalesce(1.0 / (rrf_k + k.rnk), 0.0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
  )
  select c.id, c.subject_code, c.kind, c.paper_code, c.year, c.session,
         c.paper_no, c.variant, c.question_no, c.marks, c.command_word,
         c.topic, c.syllabus_refs, c.content, c.ms_content, c.er_content,
         c.page, f.score
  from fused f
  join public.chunks c on c.id = f.id
  order by f.score desc
  limit match_count;
$fn$;

-- The shape every retrieval function returns. Deliberately excludes the
-- embedding column: a 768-float vector per row would dominate the response
-- payload and none of the callers need it back.
do $ct$
begin
  if not exists (select 1 from pg_type where typname = 'chunk_result') then
    create type public.chunk_result as (
  id            uuid,
  subject_code  text,
  kind          text,
  paper_code    text,
  year          integer,
  session       text,
  paper_no      integer,
  variant       integer,
  question_no   text,
  question_root text,
  marks         integer,
  command_word  text,
  topic         text,
  syllabus_refs text[],
  content       text,
  ms_content    text,
  er_content    text,
  page          integer
);
  end if;
end
$ct$;

-- Every other part of the same question, so "mark Q4(b)" can see Q4(a)'s stem.
create or replace function public.question_siblings(p_chunk_id uuid)
returns setof public.chunk_result
language sql stable security definer set search_path = public as $fn$
  select sib.id, sib.subject_code, sib.kind, sib.paper_code, sib.year, sib.session,
         sib.paper_no, sib.variant, sib.question_no, sib.question_root, sib.marks,
         sib.command_word, sib.topic, sib.syllabus_refs, sib.content, sib.ms_content,
         sib.er_content, sib.page
  from public.chunks me
  join public.chunks sib
    on sib.paper_id = me.paper_id
   and sib.question_root is not distinct from me.question_root
  where me.id = p_chunk_id
  order by sib.question_no;
$fn$;

-- Distinct topics for a subject: powers the drill/mock topic pickers.
create or replace function public.subject_topics(p_subject text)
returns table (topic text, questions bigint, marks bigint)
language sql stable security definer set search_path = public as $fn$
  select c.topic, count(*)::bigint, coalesce(sum(c.marks), 0)::bigint
  from public.chunks c
  where c.subject_code = p_subject and c.kind = 'question' and c.topic is not null
  group by c.topic
  order by 2 desc;
$fn$;

-- Random real questions matching a spec. The raw material for a mock paper.
create or replace function public.sample_questions(
  p_subject text,
  p_topics  text[] default null,
  p_limit   int    default 12,
  p_min_marks int  default 1,
  p_max_marks int  default 99,
  p_exclude uuid[] default null
)
returns setof public.chunk_result
language sql stable security definer set search_path = public as $fn$
  select c.id, c.subject_code, c.kind, c.paper_code, c.year, c.session,
         c.paper_no, c.variant, c.question_no, c.question_root, c.marks,
         c.command_word, c.topic, c.syllabus_refs, c.content, c.ms_content,
         c.er_content, c.page
  from public.chunks c
  where c.subject_code = p_subject
    and c.kind = 'question'
    and c.ms_content is not null
    and coalesce(c.marks, 0) between p_min_marks and p_max_marks
    and (p_topics  is null or c.topic = any(p_topics))
    and (p_exclude is null or not (c.id = any(p_exclude)))
  order by random()
  limit p_limit;
$fn$;

-- "Give me more questions like this one." Pure vector neighbours of an
-- existing chunk. No embedding call needed, so this route costs no quota.
create or replace function public.similar_chunks(
  p_chunk_id uuid,
  p_limit    int default 6,
  p_same_subject boolean default true
)
returns table (
  id uuid, subject_code text, paper_code text, question_no text, marks integer,
  topic text, content text, ms_content text, year integer, session text,
  paper_no integer, distance double precision
)
language sql stable security definer set search_path = public as $fn$
  select c.id, c.subject_code, c.paper_code, c.question_no, c.marks,
         c.topic, c.content, c.ms_content, c.year, c.session, c.paper_no,
         (c.embedding <=> me.embedding)::double precision as distance
  from public.chunks me
  join public.chunks c
    on c.id <> me.id
   and c.kind = 'question'
   and c.embedding is not null
   and (not p_same_subject or c.subject_code = me.subject_code)
  where me.id = p_chunk_id and me.embedding is not null
  order by c.embedding <=> me.embedding
  limit p_limit;
$fn$;

grant execute on function public.match_chunks      to authenticated, service_role;
grant execute on function public.similar_chunks    to authenticated, service_role;
grant execute on function public.question_siblings to authenticated, service_role;
grant execute on function public.subject_topics    to authenticated, service_role;
grant execute on function public.sample_questions  to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. The study record. Everything the app learns about one student.
-- ---------------------------------------------------------------------------

-- One marked answer.
create table if not exists public.attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chunk_id      uuid references public.chunks (id) on delete set null,
  mock_id       uuid,
  subject_code  text not null,
  question_ref  text,                    -- '0625_s19_qp_42 Q4(b)'
  question_text text,
  answer_text   text not null,
  awarded       numeric(5,2) not null default 0,
  total         integer not null default 0,
  breakdown     jsonb not null default '[]'::jsonb,   -- [{point, earned, why}]
  missed        text[] not null default '{}',
  strengths     text[] not null default '{}',
  topic         text,
  syllabus_refs text[] not null default '{}',
  model_answer  text,
  created_at    timestamptz not null default now()
);

create index if not exists attempts_user_idx  on public.attempts (user_id, created_at desc);
create index if not exists attempts_topic_idx on public.attempts (user_id, subject_code, topic);

-- A generated mock exam and, once taken, its result.
create table if not exists public.mocks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_code text not null,
  title        text not null,
  spec         jsonb not null default '{}'::jsonb,      -- {topics, marks, paperNo, difficulty}
  questions    jsonb not null default '[]'::jsonb,      -- [{chunkId, questionNo, paperCode, marks, text, ms}]
  total_marks  integer not null default 0,
  duration_min integer,
  status       text not null default 'ready' check (status in ('ready','in_progress','marked')),
  started_at   timestamptz,
  submitted_at timestamptz,
  awarded      numeric(6,2),
  grade        text,
  created_at   timestamptz not null default now()
);

create index if not exists mocks_user_idx on public.mocks (user_id, created_at desc);

-- Chat, kept server-side so threads follow the account.
create table if not exists public.chat_threads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null default 'New chat',
  mode         text not null default 'ask',
  subject_code text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.chat_threads (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role       text not null check (role in ('user','model')),
  content    text not null,
  citations  jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_threads_user_idx   on public.chat_threads (user_id, updated_at desc);
create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, created_at);

-- Rolling mastery per syllabus topic. The thing that drives revision
-- suggestions and the "weak topics" mock generator.
create table if not exists public.topic_mastery (
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_code  text not null,
  topic         text not null,
  attempts      integer not null default 0,
  marks_awarded numeric(8,2) not null default 0,
  marks_total   integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, subject_code, topic)
);

alter table public.attempts      enable row level security;
alter table public.mocks         enable row level security;
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;
alter table public.topic_mastery enable row level security;

drop policy if exists "attempts_own" on public.attempts;
create policy "attempts_own" on public.attempts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mocks_own" on public.mocks;
create policy "mocks_own" on public.mocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "threads_own" on public.chat_threads;
create policy "threads_own" on public.chat_threads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "messages_own" on public.chat_messages;
create policy "messages_own" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mastery_own" on public.topic_mastery;
create policy "mastery_own" on public.topic_mastery
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- Every marked answer folds straight into the mastery table, so the weakness
-- profile is always current without the client having to maintain it.
create or replace function public.fold_attempt_into_mastery()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.topic is null or new.total = 0 then
    return new;
  end if;
  insert into public.topic_mastery (user_id, subject_code, topic, attempts, marks_awarded, marks_total, updated_at)
  values (new.user_id, new.subject_code, new.topic, 1, new.awarded, new.total, now())
  on conflict (user_id, subject_code, topic) do update
    set attempts      = public.topic_mastery.attempts + 1,
        marks_awarded = public.topic_mastery.marks_awarded + excluded.marks_awarded,
        marks_total   = public.topic_mastery.marks_total + excluded.marks_total,
        updated_at    = now();
  return new;
end
$fn$;

drop trigger if exists attempts_fold_mastery on public.attempts;
create trigger attempts_fold_mastery
  after insert on public.attempts
  for each row execute function public.fold_attempt_into_mastery();


-- Weakest topics first, with enough evidence behind them to be meaningful.
create or replace function public.weak_topics(p_subject text default null, p_limit int default 8)
returns table (subject_code text, topic text, pct numeric, attempts integer, marks_total integer)
language sql stable security definer set search_path = public as $fn$
  select m.subject_code,
         m.topic,
         round(100.0 * m.marks_awarded / nullif(m.marks_total, 0), 1) as pct,
         m.attempts,
         m.marks_total
  from public.topic_mastery m
  where m.user_id = auth.uid()
    and (p_subject is null or m.subject_code = p_subject)
    and m.marks_total >= 3
  order by pct asc nulls last, m.marks_total desc
  limit p_limit;
$fn$;

-- Predicted grade for a percentage, using the most recent published thresholds
-- for that paper. Returns null when no boundaries have been ingested.
create or replace function public.predict_grade(
  p_subject text, p_paper_no integer, p_pct numeric
) returns text
language sql stable security definer set search_path = public as $fn$
  with latest as (
    select max(year) as year
    from public.grade_boundaries
    where subject_code = p_subject and paper_no = p_paper_no
  ),
  scaled as (
    select gb.grade,
           gb.min_marks,
           max(gb.max_marks) over () as paper_total
    from public.grade_boundaries gb, latest l
    where gb.subject_code = p_subject
      and gb.paper_no = p_paper_no
      and gb.year = l.year
  )
  select grade
  from scaled
  where paper_total > 0
    and p_pct >= (min_marks::numeric / paper_total) * 100
  order by min_marks desc
  limit 1;
$fn$;

grant execute on function public.weak_topics   to authenticated;
grant execute on function public.predict_grade to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Corpus coverage: what the library screen shows, and what tells a user
--    honestly which subjects the AI can actually ground answers in.
-- ---------------------------------------------------------------------------

-- Dropped and rebuilt rather than replaced: a later migration widens this
-- view, and `create or replace view` cannot add or remove a column anywhere
-- but the end of the list, so re-running the pair in either order would fail.
drop view if exists public.corpus_coverage;

create view public.corpus_coverage
with (security_invoker = true) as
  select s.code  as subject_code,
         s.name  as subject_name,
         s.board,
         count(distinct p.id) filter (where p.kind = 'qp') as papers,
         count(distinct p.id) filter (where p.kind = 'ms') as markschemes,
         count(c.id) filter (where c.kind = 'question')    as questions,
         count(c.id) filter (where c.kind = 'syllabus')    as syllabus_sections,
         min(p.year)                                       as from_year,
         max(p.year)                                       as to_year
  from public.subjects s
  left join public.papers p on p.subject_code = s.code
  left join public.chunks c on c.paper_id = p.id
  group by s.code, s.name, s.board;

grant select on public.corpus_coverage to authenticated;
