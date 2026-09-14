/**
 * CORS + response helpers shared by every Markwise edge function.
 *
 * The frontend is a static page that can be hosted anywhere (file://, GitHub
 * Pages, Netlify), so the allow-list is driven by an env var rather than
 * hard-coded, with "*" as the development default.
 */

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = ALLOWED.includes("*")
    ? "*"
    : (origin && ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(req.headers.get("origin")) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req.headers.get("origin")),
      "Content-Type": "application/json",
    },
  });
}

export function fail(req: Request, message: string, status = 400, extra?: unknown): Response {
  console.error(`[${status}] ${message}`, extra ?? "");
  return json(req, { error: message }, status);
}

/** Server-sent-event stream with the CORS headers already applied. */
export function sseHeaders(req: Request): Record<string, string> {
  return {
    ...corsHeaders(req.headers.get("origin")),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  };
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
