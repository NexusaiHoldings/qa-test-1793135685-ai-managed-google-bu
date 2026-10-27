"use server";

import { Pool } from "pg";
import { getServerSession } from "@nexus/identity-and-access";
import { upsertVoiceProfileForUser } from "@/lib/gbp/voice-profile";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function calibrateVoiceAction(): Promise<{ ok: boolean; reason?: string }> {
  const session = await getServerSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, reason: "unauthorized" };

  const result = await upsertVoiceProfileForUser(userId);
  if (!result) return { ok: false, reason: "no_location" };
  return { ok: true };
}

export async function approveVoiceAction(locationId: string): Promise<{ ok: boolean; reason?: string }> {
  const session = await getServerSession();
  const userId = session?.user?.id;
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
