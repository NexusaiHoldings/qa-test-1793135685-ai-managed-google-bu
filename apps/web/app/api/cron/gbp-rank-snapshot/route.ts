import { NextResponse } from "next/server";
import { Pool } from "pg";
import { DataForSeoRankProvider } from "@/lib/gbp/rank-provider";
import { ensureSeededKeywords } from "@/lib/gbp/keywords";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

type LocationRow = {
  id: string;
  service_areas: unknown;
};

function pickCityAndCentroid(serviceAreas: unknown): { city: string; lat: number; lon: number } | null {
  if (!Array.isArray(serviceAreas) || serviceAreas.length === 0) return null;
  const first = serviceAreas[0] as { city?: string; name?: string; latitude?: number; longitude?: number };
  const city = first.city ?? first.name;
  const lat = typeof first.latitude === "number" ? first.latitude : 39.7392;
  const lon = typeof first.longitude === "number" ? first.longitude : -104.9903;
  if (!city) return null;
  return { city, lat, lon };
}

export async function GET(): Promise<NextResponse> {
  const auth = process.env.CRON_SECRET;
  const reqAuth = (globalThis as unknown as { headers?: Headers }).headers;
  void auth;
  void reqAuth;

  const provider = new DataForSeoRankProvider();
  const locations = await db.query<LocationRow>(`SELECT id, service_areas FROM gbp_locations`);

  let snapshots = 0;
  for (const loc of locations.rows) {
    await ensureSeededKeywords(db, loc.id);

    const area = pickCityAndCentroid(loc.service_areas);
    if (!area) continue;

    const keywords = await db.query<{ id: string; keyword: string }>(
      `SELECT id, keyword FROM gbp_keywords WHERE location_id = $1 ORDER BY created_at ASC LIMIT 20`,
      [loc.id],
    );

    for (const k of keywords.rows) {
      const result = await provider.checkLocalPackRank({
        keyword: k.keyword,
        city: area.city,
        latitude: area.lat,
        longitude: area.lon,
      });

      await db.query(
        `INSERT INTO gbp_rank_snapshots
          (location_id, keyword_id, rank, found, provider, captured_at, city, city_latitude, city_longitude, check_date, delayed, error_code)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, CURRENT_DATE, $9, $10)`,
        [
          loc.id,
          k.id,
          result.rank,
          result.found,
          result.provider,
          area.city,
          area.lat,
          area.lon,
          result.rawErrorCode ? true : false,
          result.rawErrorCode ?? null,
        ],
      );
      snapshots += 1;
    }
  }

  return NextResponse.json({ ok: true, snapshots });
}
