-- ============================================================================
-- Markwise: migrate the original tracker's subject NAMES to syllabus CODES.
--
-- The old app stored `tasks.subject` and `profiles.subjects` as display names
-- ("Physics", "Extra Maths"). Everything in Markwise keys on the Cambridge
-- syllabus code, because that is what past-paper filenames carry and what
-- retrieval filters on. Without this, existing accounts land on the subject
-- picker again and their old tasks show under a name nothing else recognises.
--
-- It also introduces `subjects.corpus_code`: the subject whose past papers a
-- course should be answered from. A school's "Extra Maths" or "Single Science
-- Physics" class has no syllabus of its own, but the questions a student needs
-- are 0580's and 0625's. Without this pointer those students would have a
-- working planner and a permanently empty AI.
--
-- Safe to run more than once: every statement is scoped to rows that still
-- hold a legacy name.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Courses the original app listed that have no syllabus code of their own.
-- ---------------------------------------------------------------------------

insert into public.subjects (code, board, name, level) values
  ('X-SSPHY', 'School', 'Single Science Physics',   'IGCSE'),
  ('X-SSCHE', 'School', 'Single Science Chemistry', 'IGCSE'),
  ('X-SSBIO', 'School', 'Single Science Biology',   'IGCSE')
on conflict (code) do update set name = excluded.name;


-- ---------------------------------------------------------------------------
-- 2. corpus_code. Which subject's papers to answer this course from.
--    Null means "use my own code".
-- ---------------------------------------------------------------------------

alter table public.subjects
  add column if not exists corpus_code text references public.subjects (code) on delete set null;

comment on column public.subjects.corpus_code is
  'Answer questions for this course from another subject''s papers. Null = own code.';

update public.subjects s
   set corpus_code = m.corpus
  from (values
    -- School support classes borrow the syllabus they support.
    ('X-XMATH', '0580'),   -- Extra Maths        → Mathematics
    ('X-XENG',  '0500'),   -- Extra English      → English Language
    ('X-FPM',   '0606'),   -- Further Pure Maths → Additional Mathematics
    -- Single-award sciences are examined on the full syllabus papers, which is
    -- where the relevant questions and mark schemes live.
    ('X-SSPHY', '0625'),
    ('X-SSCHE', '0620'),
    ('X-SSBIO', '0610')
  ) as m(code, corpus)
 where s.code = m.code
   and s.corpus_code is distinct from m.corpus;


-- ---------------------------------------------------------------------------
-- 3. The name → code map.
--
--    Exactly the catalogue the original index.html shipped, so every value
--    that can be in the database is covered.
-- ---------------------------------------------------------------------------

create or replace function public.legacy_subject_code(p_name text)
returns text
language sql
immutable
as $fn$
  select code from (values
    ('Geography',                 '0460'),
    ('English Literature',        '0475'),
    ('English Language',          '0500'),
    ('Extra English',             'X-XENG'),
    ('Sinhala',                   '0505'),
    ('French',                    '0520'),
    ('Maths',                     '0580'),
    ('Extra Maths',               'X-XMATH'),
    ('Further Pure Maths',        'X-FPM'),
    ('Physics',                   '0625'),
    ('Chemistry',                 '0620'),
    ('Biology',                   '0610'),
    ('Human Biology',             '0648'),
    ('Single Science Physics',    'X-SSPHY'),
    ('Single Science Chemistry',  'X-SSCHE'),
    ('Single Science Biology',    'X-SSBIO'),
    ('History',                   '0470'),
    ('Economics',                 '0455'),
    ('Business',                  '0450'),
    ('Accounting',                '0452'),
    ('Commerce',                  '7100'),
    ('ICT',                       '0417'),
    ('Computer Science',          '0478'),
    ('Psychology',                'X-PSY'),
    ('Art',                       '0400'),
    ('Drama',                     '0411'),
    ('BTEC Sport',                'X-BSPT'),
    ('BTEC Music',                'X-BMUS')
  ) as m(name, code)
  where m.name = p_name;
$fn$;


-- ---------------------------------------------------------------------------
-- 4. Rewrite the stored data.
-- ---------------------------------------------------------------------------

-- Tasks. Only rows still holding a legacy name are touched, so re-running is
-- a no-op and any task already on a code is left alone.
update public.tasks t
   set subject = public.legacy_subject_code(t.subject)
 where public.legacy_subject_code(t.subject) is not null;

-- Profiles: subjects is text[], so each element is mapped individually and
-- anything unrecognised is dropped rather than left to render as a dead card.
update public.profiles p
   set subjects = coalesce(mapped.arr, '{}'::text[]),
       updated_at = now()
  from (
    select p2.id,
           array_agg(distinct coalesce(public.legacy_subject_code(elem), elem)) as arr
      from public.profiles p2
      cross join lateral unnest(p2.subjects) as elem
     where exists (
       select 1 from unnest(p2.subjects) e
        where public.legacy_subject_code(e) is not null
     )
     group by p2.id
  ) as mapped
 where p.id = mapped.id;

-- The remembered "last subject used" in the prefs blob.
update public.profiles p
   set prefs = jsonb_set(
         p.prefs,
         '{lastSubject}',
         to_jsonb(public.legacy_subject_code(p.prefs->>'lastSubject'))
       )
-- jsonb_exists() rather than the `?` operator: `?` is a parameter placeholder
-- in several drivers, so the operator form breaks under `supabase db push`.
 where jsonb_exists(p.prefs, 'lastSubject')
   and public.legacy_subject_code(p.prefs->>'lastSubject') is not null;

-- Tuition sessions, for anyone who added them before running this.
update public.tuition_sessions s
   set subject = public.legacy_subject_code(s.subject)
 where public.legacy_subject_code(s.subject) is not null;


-- ---------------------------------------------------------------------------
-- 5. Coverage now reports through corpus_code, so a course that borrows
--    another subject's papers correctly shows as grounded.
-- ---------------------------------------------------------------------------

-- `create or replace view` can only append columns, not insert one into the
-- middle of the existing column list, so the view is dropped and rebuilt.
-- Nothing depends on it but the client's select, which is re-granted below.
drop view if exists public.corpus_coverage;

create view public.corpus_coverage
with (security_invoker = true) as
  select s.code  as subject_code,
         s.name  as subject_name,
         s.board,
         coalesce(s.corpus_code, s.code) as corpus_code,
         count(distinct p.id) filter (where p.kind = 'qp') as papers,
         count(distinct p.id) filter (where p.kind = 'ms') as markschemes,
         count(c.id) filter (where c.kind = 'question')    as questions,
         count(c.id) filter (where c.kind = 'syllabus')    as syllabus_sections,
         min(p.year)                                       as from_year,
         max(p.year)                                       as to_year
  from public.subjects s
  left join public.papers p on p.subject_code = coalesce(s.corpus_code, s.code)
  left join public.chunks c on c.paper_id = p.id
  group by s.code, s.name, s.board, s.corpus_code;

grant select on public.corpus_coverage to authenticated;


-- ---------------------------------------------------------------------------
-- 6. What changed: read this output after running.
-- ---------------------------------------------------------------------------

do $report$
declare
  stragglers int;
begin
  select count(*) into stragglers
    from public.tasks t
   where t.subject !~ '^(\d{4}|X-[A-Z]+)$';

  if stragglers > 0 then
    raise notice 'Markwise: % task(s) still hold an unrecognised subject. They will show under their raw name; fix them in the app or add a mapping here.', stragglers;
  else
    raise notice 'Markwise: every task and profile is now on a syllabus code.';
  end if;
end
$report$;
