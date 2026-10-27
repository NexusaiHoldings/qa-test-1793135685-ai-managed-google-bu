import { Pool } from "pg";
import { fetchLocalPackRanks } from "@/lib/gbp/rank-provider";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type LocationRow = {
  id: string;
  service_areas: unknown;
};

type KeywordRow = {
  id: string;
  keyword: string;
};

export async function GET(): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = (globalThis as unknown as { headers?: Headers }).headers?.get?.("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const client = await pool.connect();
  try {
    const locations = await client.query<LocationRow>(`SELECT id, service_areas FROM gbp_locations`);

    for (const location of locations.rows) {
      const city = Array.isArray(location.service_areas) && location.service_areas.length > 0 ? String(location.service_areas[0]) : "United States";
      const keywords = await client.query<KeywordRow>(
        `SELECT id, keyword FROM gbp_keywords WHERE location_id = $1 ORDER BY created_at ASC LIMIT 20`,
        [location.id],
      );
      if (keywords.rowCount === 0) continue;

      const rankResults = await fetchLocalPackRanks(
        keywords.rows.map((k) => ({ keyword: k.keyword, city })),
      );

      for (let i = 0; i < keywords.rows.length; i += 1) {
        const keyword = keywords.rows[i];
        const result = rankResults[i];
        await client.query(
          `INSERT INTO gbp_rank_snapshots
             (location_id, keyword_id, rank, found, provider, captured_at, city, snapshot_date, provider_status)
           VALUES ($1, $2, $3, $4, 'dataforseo', now(), $5, CURRENT_DATE, $6)`,
          [location.id, keyword.id, result.rank, result.found, city, result.providerStatus],
        );
      }
    }

    return Response.json({ ok: true });
  } finally {
    client.release();
  }
}
