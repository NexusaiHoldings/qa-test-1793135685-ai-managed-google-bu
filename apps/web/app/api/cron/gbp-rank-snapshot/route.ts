/**
 * GET /api/cron/gbp-rank-snapshot — Feature F1-008.
 *
 * Vercel Cron handler (target schedule: monthly) that snapshots local-pack
 * positions for every linked location's tracked keywords into
 * gbp_rank_snapshots, measured from the first service-area city (centroid
 * proxy). Provider outages are recorded as 'delayed' rows carrying the last
 * null rank so the /rankings page can show the last good snapshot with a
 * "rankings delayed" badge rather than blank cells. One location's failure
 * never aborts the rest.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (local/dev) → unguarded (the job is append-only).
 */

import { Pool } from "pg";
import { fetchLocalPackRanks } from "@/lib/gbp/rank-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible
export const maxDuration = 60;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type LocationRow = {
  id: string;
  service_areas: unknown;
};

type KeywordRow = {
  id: string;
  keyword: string;
};

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let locationsProcessed = 0;
  let snapshotsWritten = 0;
  const client = await pool.connect();
  try {
    const locations = await client.query<LocationRow>(`SELECT id, service_areas FROM gbp_locations`);

    for (const location of locations.rows) {
      try {
        const city =
          Array.isArray(location.service_areas) && location.service_areas.length > 0
            ? String(location.service_areas[0])
            : "United States";
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
          snapshotsWritten += 1;
        }
        locationsProcessed += 1;
      } catch (e) {
        console.error(
          JSON.stringify({
            at: "gbp.cron.rank-snapshot",
            locationId: location.id,
            error: (e as Error).message,
          }),
        );
      }
    }

    console.log(
      JSON.stringify({ at: "gbp.cron.rank-snapshot", locationsProcessed, snapshotsWritten }),
    );
    return Response.json({ ok: true, locationsProcessed, snapshotsWritten });
  } finally {
    client.release();
  }
}
