-- ============================================================================
-- Markwise: subject catalogue.
--
-- Codes are the real Cambridge IGCSE syllabus codes, because they are what
-- paper filenames use (0625_s19_qp_42) and what the ingestion pipeline parses.
-- Non-Cambridge entries (BTEC, school-specific "Extra Maths") get a synthetic
-- code so the planner can still track them; they simply have no corpus.
--
-- Safe to run more than once.
-- ============================================================================

insert into public.subjects (code, board, name, level) values
  ('0580', 'Cambridge', 'Mathematics',               'IGCSE'),
  ('0606', 'Cambridge', 'Additional Mathematics',    'IGCSE'),
  ('0607', 'Cambridge', 'International Mathematics', 'IGCSE'),
  ('0625', 'Cambridge', 'Physics',                   'IGCSE'),
  ('0620', 'Cambridge', 'Chemistry',                 'IGCSE'),
  ('0610', 'Cambridge', 'Biology',                   'IGCSE'),
  ('0654', 'Cambridge', 'Co-ordinated Sciences',     'IGCSE'),
  ('0653', 'Cambridge', 'Combined Science',          'IGCSE'),
  ('0648', 'Cambridge', 'Human Biology',             'IGCSE'),
  ('0500', 'Cambridge', 'English Language',          'IGCSE'),
  ('0475', 'Cambridge', 'English Literature',        'IGCSE'),
  ('0990', 'Cambridge', 'English Language (9-1)',    'IGCSE'),
  ('0460', 'Cambridge', 'Geography',                 'IGCSE'),
  ('0470', 'Cambridge', 'History',                   'IGCSE'),
  ('0455', 'Cambridge', 'Economics',                 'IGCSE'),
  ('0450', 'Cambridge', 'Business Studies',          'IGCSE'),
  ('0452', 'Cambridge', 'Accounting',                'IGCSE'),
  ('7100', 'Cambridge', 'Commerce',                  'IGCSE'),
  ('0417', 'Cambridge', 'Information & Communication Technology', 'IGCSE'),
  ('0478', 'Cambridge', 'Computer Science',          'IGCSE'),
  ('0495', 'Cambridge', 'Sociology',                 'IGCSE'),
  ('0490', 'Cambridge', 'Religious Studies',         'IGCSE'),
  ('0400', 'Cambridge', 'Art & Design',              'IGCSE'),
  ('0411', 'Cambridge', 'Drama',                     'IGCSE'),
  ('0410', 'Cambridge', 'Music',                     'IGCSE'),
  ('0413', 'Cambridge', 'Physical Education',        'IGCSE'),
  ('0520', 'Cambridge', 'French',                    'IGCSE'),
  ('0505', 'Cambridge', 'Sinhala',                   'IGCSE'),
  ('X-PSY',  'School',  'Psychology',                'IGCSE'),
  ('X-FPM',  'School',  'Further Pure Maths',        'IGCSE'),
  ('X-XMATH','School',  'Extra Maths',               'Support'),
  ('X-XENG', 'School',  'Extra English',             'Support'),
  ('X-BSPT', 'BTEC',    'BTEC Sport',                'Level 2'),
  ('X-BMUS', 'BTEC',    'BTEC Music',                'Level 2')
on conflict (code) do update
  set board = excluded.board,
      name  = excluded.name,
      level = excluded.level;
