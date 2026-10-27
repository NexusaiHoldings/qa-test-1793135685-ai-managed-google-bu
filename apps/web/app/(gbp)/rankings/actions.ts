"use server";

import { revalidatePath } from "next/cache";
import { Pool } from "pg";
import { getSessionUser } from "@/lib/admin-auth";
import { suggestKeywords } from "@/lib/gbp/keywords";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function seedKeywordsAction(locationId: string): Promise<{ seeded: number }> {
  const user = await getSessionUser();
  const userId = user?.id;
  if (!userId) return { seeded: 0 };

  const client = await pool.connect();
  try {
    const locationRes = await client.query(
      `SELECT primary_category, additional_categories, service_areas
       FROM gbp_locations
       WHERE id = $1 AND user_id = $2`,
      [locationId, userId],
    );

    if (locationRes.rowCount === 0) return { seeded: 0 };

    const row = locationRes.rows[0] as {
      primary_category: string | null;
      additional_categories: unknown;
      service_areas: unknown;
    };

    const additional = Array.isArray(row.additional_categories) ? row.additional_categories.map(String) : [];
    const areas = Array.isArray(row.service_areas) ? row.service_areas.map(String) : [];
    const keywords = suggestKeywords(row.primary_category, additional, areas);

    let seeded = 0;
    for (const keyword of keywords) {
      const result = await client.query(
        `INSERT INTO gbp_keywords (location_id, keyword, locale)
         VALUES ($1, $2, $3)
         ON CONFLICT (location_id, keyword) DO NOTHING`,
        [locationId, keyword, "en-US"],
      );
      seeded += result.rowCount ?? 0;
    }

    revalidatePath("/rankings");
    return { seeded };
  } finally {
    client.release();
  }
}
