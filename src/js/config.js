/**
 * Client configuration.
 *
 * The publishable key is meant to be public: every table is protected by
 * row-level security, so it grants nothing on its own. The Gemini key is NOT
 * here and never will be — AI calls go through edge functions, which is the
 * whole reason the app has a server side at all.
 */

export const SUPABASE_URL = "https://yfzlypcxsmlakpxkrtbu.supabase.co";
export const SUPABASE_KEY = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const APP_NAME = "Markwise";
export const APP_TAGLINE = "The IGCSE assistant that has actually read the papers.";

export const STORAGE = {
  theme: "markwise-theme",
  prefs: "markwise-prefs-v1",
  auth: "markwise-auth",
};

/** Subject tabs in the planner. */
/** Where the work came from. The planner has always had exactly these two. */
export const SOURCES = [
  { id: "school", label: "School" },
  { id: "tuition", label: "Tuition" },
];

/**
 * Blue pen for your own homework, red pen for anything an examiner sees.
 * Tuition has no assessments, which the add-task form reflects.
 */
export const TASK_TYPES = [
  { id: "homework", label: "Homework" },
  { id: "assessment", label: "Assessment" },
];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
