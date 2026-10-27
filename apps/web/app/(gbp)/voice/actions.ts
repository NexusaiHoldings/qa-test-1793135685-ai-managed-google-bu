"use server";

import { Pool } from "pg";
import { getSessionUser } from "@/lib/admin-auth";
import { upsertVoiceProfileForUser } from "@/lib/gbp/voice-profile";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const GREETING_COPY: Record<string, string> = {
  thanks: "Open with a simple thanks.",
  name: "Open with the customer's name followed by thanks.",
  direct: "Open directly and briefly, no preamble.",
};

const SIGNOFF_COPY: Record<string, string> = {
  team: "Close with a warm sign-off from the team.",
  owner: "Close with the owner's first name.",
  none: "No explicit sign-off.",
};

export async function calibrateVoiceAction(
  formData?: FormData,
): Promise<{ ok: boolean; reason?: string }> {
  const user = await getSessionUser();
  const userId = user?.id;
  if (!userId) return { ok: false, reason: "unauthorized" };

  const result = await upsertVoiceProfileForUser(userId);
  if (!result) return { ok: false, reason: "no_location" };

  // Fewer-than-5-review owners submit the four-question tone picker; persist
  // their explicit answers over the seeded profile so the row reflects intent.
  if (formData) {
    const greeting = String(formData.get("greeting") ?? "");
    const signoff = String(formData.get("signoff") ?? "");
    const rawFormality = String(formData.get("formality") ?? "balanced");
    const formality: "casual" | "balanced" | "formal" =
      rawFormality === "casual" || rawFormality === "formal" ? rawFormality : "balanced";
    const never = String(formData.get("never") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (greeting || signoff || never.length > 0) {
      const profile = {
        ...result.profile,
        formality,
        greetingStyle: GREETING_COPY[greeting] ?? result.profile.greetingStyle,
        signOffStyle: SIGNOFF_COPY[signoff] ?? result.profile.signOffStyle,
        thingsNeverSaid:
          never.length > 0
            ? Array.from(new Set([...never, ...result.profile.thingsNeverSaid]))
            : result.profile.thingsNeverSaid,
      };
      await pool.query(
        `UPDATE gbp_voice_profiles vp
           SET profile = $1::jsonb, updated_at = now()
           FROM gbp_locations l
          WHERE vp.location_id = $2
            AND vp.location_id = l.id
            AND l.user_id = $3`,
        [JSON.stringify(profile), result.locationId, userId],
      );
    }
  }

  return { ok: true };
}

export async function approveVoiceAction(locationId: string): Promise<{ ok: boolean; reason?: string }> {
  const user = await getSessionUser();
  const userId = user?.id;
  if (!userId) return { ok: false, reason: "unauthorized" };

  const query = `
    UPDATE gbp_voice_profiles vp
    SET approved = true,
        approved_at = now(),
        updated_at = now()
    FROM gbp_locations l
    WHERE vp.location_id = $1
      AND vp.location_id = l.id
      AND l.user_id = $2
    RETURNING vp.id
  `;
  const res = await pool.query<{ id: string }>(query, [locationId, userId]);
  if (res.rowCount === 0) return { ok: false, reason: "not_found" };
  return { ok: true };
}
