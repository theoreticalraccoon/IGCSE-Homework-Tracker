/**
 * Supabase access inside edge functions.
 *
 * Two clients, deliberately:
 *
 *  - userClient() forwards the caller's JWT, so every read and write it makes
 *    is still subject to row-level security. All user data goes through it.
 *  - adminClient() uses the service-role key and bypasses RLS. It is used only
 *    for reading the shared corpus in the retrieval path, never for user rows.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  email: string | null;
  db: SupabaseClient;
}

/** Resolve the signed-in user, or throw. Every AI route requires one. */
export async function requireUser(req: Request): Promise<Caller> {
  const db = userClient(req);
  const { data, error } = await db.auth.getUser();
  if (error || !data?.user) throw new Error("Not signed in.");
  return { id: data.user.id, email: data.user.email ?? null, db };
}
