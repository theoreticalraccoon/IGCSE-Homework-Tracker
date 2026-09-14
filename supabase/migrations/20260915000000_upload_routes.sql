-- ============================================================================
-- Markwise — daily caps for the two upload routes.
--
-- Both send whole documents to Gemini, so they are far more expensive per call
-- than a chat message and are capped much lower.
--
--   ingest     one past-paper PDF added to the corpus
--   markpaper  a set of photos of handwritten answers, marked
--
-- Safe to run more than once.
-- ============================================================================

insert into public.ai_limits (route, per_day) values
  ('ingest', 25),
  ('markpaper', 10)
on conflict (route) do nothing;
