/**
 * Per-user daily budget for AI routes.
 *
 * Checked before the Gemini call, not after, so a user who is out of quota
 * costs the project nothing. The counter lives in Postgres rather than in
 * function memory because edge functions are stateless and scale to many
 * isolates — an in-process counter would be trivially bypassed.
 */

import { adminClient } from "./db.ts";

export class QuotaExceeded extends Error {
  constructor(route: string) {
    super(`Daily limit for "${route}" reached. It resets at midnight UTC.`);
    this.name = "QuotaExceeded";
  }
}

/** Reserve one call. Throws QuotaExceeded when the cap is spent. */
export async function claim(userId: string, route: string): Promise<number> {
  const admin = adminClient();
  const { data, error } = await admin.rpc("claim_ai_call", {
    p_user: userId,
    p_route: route,
  });
  if (error) {
    // Accounting must never take the feature down; log and let the call run.
    console.error("claim_ai_call failed:", error.message);
    return 0;
  }
  if (typeof data === "number" && data < 0) throw new QuotaExceeded(route);
  return typeof data === "number" ? data : 0;
}
