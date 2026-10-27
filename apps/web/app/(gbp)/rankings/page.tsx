import type { JSX } from "react";
import { Pool } from "pg";
import { getSessionUser } from "@/lib/admin-auth";
import { seedKeywordsAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Row = {
  keyword_id: string;
  keyword: string;
  city: string | null;
  snapshot_date: string | null;
  rank: number | null;
  provider_status: string | null;
  history: Array<number | null>;
};

function deltaChip(curr: number | null, prev: number | null): { label: string; color: string } {
  // Lower rank number = better position, so prev - curr > 0 means we moved up.
  if (curr === null || prev === null) return { label: "—", color: "var(--muted, #888)" };
  const delta = prev - curr;
  if (delta > 0) return { label: `▲${delta}`, color: "var(--success, #16a34a)" };
  if (delta < 0) return { label: `▼${Math.abs(delta)}`, color: "var(--warning, #d97706)" };
  return { label: "—", color: "var(--muted, #888)" };
}

// A tiny inline-SVG sparkline of the last snapshots (oldest → newest). Lower
// rank sits higher on the chart, matching how owners read "position 1 is best".
function sparkline(ranks: Array<number | null>): JSX.Element | null {
  const points = ranks.filter((r): r is number => typeof r === "number");
  if (points.length < 2) return null;
  const width = 72;
  const height = 24;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points
    .map((r, i) => {
      const x = i * step;
      const y = ((r - min) / span) * (height - 4) + 2; // lower rank → higher line
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label="Last snapshots trend">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.7} />
    </svg>
  );
}

export default async function RankingsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  const userId = user?.id;

  if (!userId) {
    return (
      <main>
        <h1>Rankings</h1>
        <p>Please sign in to view local keyword rankings.</p>
      </main>
    );
  }

  const client = await pool.connect();
  try {
    const locationRes = await client.query(
      `SELECT id, title FROM gbp_locations WHERE user_id = $1 ORDER BY linked_at DESC LIMIT 1`,
      [userId],
    );

    if (locationRes.rowCount === 0) {
      return (
        <main>
          <h1>Rankings</h1>
          <p>Connect a Google Business Profile location first.</p>
        </main>
      );
    }

    const locationId = locationRes.rows[0].id as string;
    const locationTitle = (locationRes.rows[0].title as string | null) ?? "Your location";

    const rowsRes = await client.query(
      `WITH ranked AS (
         SELECT s.keyword_id, s.rank, s.city, s.snapshot_date, s.provider_status, s.captured_at,
                ROW_NUMBER() OVER (PARTITION BY s.keyword_id ORDER BY s.captured_at DESC) AS rn
         FROM gbp_rank_snapshots s
         JOIN gbp_keywords k ON k.id = s.keyword_id
         WHERE k.location_id = $1
       ),
       latest AS (
         SELECT keyword_id, provider_status FROM ranked WHERE rn = 1
       ),
       good AS (
         SELECT keyword_id, rank, city, snapshot_date, captured_at,
                ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY captured_at DESC) AS grn
         FROM ranked
         WHERE rank IS NOT NULL
       ),
       history AS (
         SELECT keyword_id, array_agg(rank ORDER BY captured_at DESC) AS ranks
         FROM ranked
         WHERE rn <= 3
         GROUP BY keyword_id
       )
       SELECT k.id AS keyword_id, k.keyword,
              g1.city, g1.snapshot_date::text AS snapshot_date, g1.rank,
              l.provider_status,
              COALESCE(h.ranks, ARRAY[]::integer[]) AS history,
              g2.rank AS prev_rank
       FROM gbp_keywords k
       LEFT JOIN latest l ON l.keyword_id = k.id
       LEFT JOIN good g1 ON g1.keyword_id = k.id AND g1.grn = 1
       LEFT JOIN good g2 ON g2.keyword_id = k.id AND g2.grn = 2
       LEFT JOIN history h ON h.keyword_id = k.id
       WHERE k.location_id = $1
       ORDER BY k.created_at ASC
       LIMIT 20`,
      [locationId],
    );

    const hasKeywords = rowsRes.rows.length > 0;

    return (
      <main>
        <h1>Rankings</h1>
        <p>{locationTitle}: local-pack keyword tracking for service-area cities.</p>

        {!hasKeywords ? (
          <div className="empty">
            <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
              📍
            </p>
            <p>
              First snapshot runs tonight. Seed up to 20 suggested keywords from your
              categories and service-area cities — confirm or swap them, and we&apos;ll
              track their local-pack position from your service area.
            </p>
            <form action={async () => { "use server"; await seedKeywordsAction(locationId); }}>
              <button type="submit">Seed suggested keywords</button>
            </form>
          </div>
        ) : (
          <section>
            {rowsRes.rows.map((r) => {
              const row = r as Row & { prev_rank: number | null };
              const prev = row.prev_rank;
              const delta = deltaChip(row.rank, prev);
              const delayed = row.provider_status === "delayed";
              // history is newest-first from SQL; reverse for an oldest→newest sparkline.
              const trend = [...row.history].reverse();
              return (
                <article key={row.keyword_id} className="card">
                  <h3>{row.keyword}</h3>
                  <p className="muted">
                    Snapshot {row.snapshot_date ?? "pending"} · {row.city ?? "local area"}
                    {delayed ? " · rankings delayed" : ""}
                  </p>
                  <p style={{ fontSize: "2.5rem", fontWeight: 700, margin: "0.25rem 0" }}>
                    {row.rank ?? "—"}
                  </p>
                  <p style={{ margin: "0.25rem 0", color: delta.color, fontWeight: 600 }}>
                    {delta.label}
                  </p>
                  {sparkline(trend) ?? (
                    <p className="muted">Last 3: {row.history.map((x) => x ?? "—").join(" · ")}</p>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </main>
    );
  } finally {
    client.release();
  }
}
