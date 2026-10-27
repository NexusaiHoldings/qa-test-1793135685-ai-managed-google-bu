"use server";

import { Pool } from "pg";
import { ensureSeededKeywords } from "@/lib/gbp/keywords";
import { revalidatePath } from "next/cache";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function saveKeywordsAction(formData: FormData): Promise<void> {
  const locationId = String(formData.get("locationId") ?? "");
  const raw = String(formData.get("keywords") ?? "");
  if (!locationId) return;

  const keywords = raw
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 20);

  await db.query(`DELETE FROM gbp_keywords WHERE location_id = $1`, [locationId]);
  for (const keyword of keywords) {
    await db.query(
      `INSERT INTO gbp_keywords (location_id, keyword, locale) VALUES ($1, $2, $3)
       ON CONFLICT (location_id, keyword) DO NOTHING`,
      [locationId, keyword, "en-US"],
    );
  }

  revalidatePath("/rankings");
}

export async function seedKeywordsAction(formData: FormData): Promise<void> {
  const locationId = String(formData.get("locationId") ?? "");
  if (!locationId) return;
  await ensureSeededKeywords(db, locationId);
  revalidatePath("/rankings");
}
