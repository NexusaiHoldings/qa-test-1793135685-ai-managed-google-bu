import { Pool } from "pg";
import { getServerSession } from "@nexus/identity-and-access";
import { seedKeywordsAction } from "./actions";

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

function deltaChip(curr: number | null, prev: number | null): string {
  if (curr === null || prev === null) return "—";
  const delta = prev - curr;
  if (delta > 0) return `▲${delta}`;
  if (delta < 0) return `▼${Math.abs(delta)}`;
  return "—";
}

export default async function RankingsPage(): Promise<JSX.Element> {
  const session = await getServerSession();
  const userId = session?.user?.id;

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
      `WITH latest AS (
         SELECT DISTINCT ON (s.keyword_id)
           s.keyword_id, s.rank, s.city, s.snapshot_date, s.provider_status, s.captured_at
         FROM gbp_rank_snapshots s
         JOIN gbp_keywords k ON k.id = s.keyword_id
         WHERE k.location_id = $1
         ORDER BY s.keyword_id, s.captured_at DESC
       ),
       prev AS (
         SELECT x.keyword_id, x.rank
         FROM (
           SELECT s.keyword_id, s.rank,
             ROW_NUMBER() OVER (PARTITION BY s.keyword_id ORDER BY s.captured_at DESC) AS rn
           FROM gbp_rank_snapshots s
           JOIN gbp_keywords k ON k.id = s.keyword_id
           WHERE k.location_id = $1
         ) x
         WHERE x.rn = 2
       ),
       history AS (
         SELECT y.keyword_id,
                array_agg(y.rank ORDER BY y.captured_at DESC) AS ranks
         FROM (
           SELECT s.keyword_id, s.rank, s.captured_at,
             ROW_NUMBER() OVER (PARTITION BY s.keyword_id ORDER BY s.captured_at DESC) AS rn
           FROM gbp_rank_snapshots s
           JOIN gbp_keywords k ON k.id = s.keyword_id
           WHERE k.location_id = $1
         ) y
         WHERE y.rn <= 3
         GROUP BY y.keyword_id
       )
       SELECT k.id AS keyword_id, k.keyword,
              l.city, l.snapshot_date::text, l.rank, l.provider_status,
              COALESCE(h.ranks, ARRAY[]::integer[]) AS history,
              p.rank AS prev_rank
       FROM gbp_keywords k
       LEFT JOIN latest l ON l.keyword_id = k.id
       LEFT JOIN prev p ON p.keyword_id = k.id
       LEFT JOIN history h ON h.keyword_id = k.id
       WHERE k.location_id = $1
       ORDER BY k.created_at ASC
       LIMIT 20`,
      [locationId],
    );

    const hasKeywords = rowsRes.rowCount > 0;

    return (
      <main>
        <h1>Rankings</h1>
        <p>{locationTitle}: local-pack keyword tracking for service-area cities.</p>

        {!hasKeywords ? (
          <div className="empty">
            <p>First snapshot runs tonight. Start by seeding suggested keywords.</p>
            <form action={async () => { "use server"; await seedKeywordsAction(locationId); }}>
              <button type="submit">Seed keywords</button>
            </form>
          </div>
        ) : (
          <section>
            {rowsRes.rows.map((r) => {
              const row = r as Row & { prev_rank: number | null };
              const prev = row.prev_rank;
              const delta = deltaChip(row.rank, prev);
              const delayed = row.provider_status === "delayed";
              return (
                <article key={row.keyword_id} className="card">
                  <h3>{row.keyword}</h3>
                  <p className="muted">
                    Snapshot {row.snapshot_date ?? "pending"} · {row.city ?? "local area"}{" "}
                    {delayed ? "· rankings delayed" : ""}
                  </p>
                  <p style={{ fontSize: "2rem", margin: 0 }}>{row.rank ?? "—"}</p>
                  <p className="muted">{delta}</p>
                  <p className="muted">Last 3: {row.history.map((x) => (x ?? "—")).join(" · ")}</p>
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
