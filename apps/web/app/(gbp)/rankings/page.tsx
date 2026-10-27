import { Pool } from "pg";
import { seedKeywordsAction, saveKeywordsAction } from "./actions";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

type Row = {
  keyword_id: string;
  keyword: string;
  city: string | null;
  captured_at: string | null;
  rank: number | null;
  found: boolean | null;
  delayed: boolean | null;
  prev_rank: number | null;
  prev_prev_rank: number | null;
};

function deltaLabel(rank: number | null, prev: number | null): string {
  if (rank == null || prev == null) return "—";
  const d = prev - rank;
  if (d > 0) return `▲${d}`;
  if (d < 0) return `▼${Math.abs(d)}`;
  return "—";
}

export default async function RankingsPage(): Promise<JSX.Element> {
  const locRes = await db.query<{ id: string; title: string }>(
    `SELECT id, COALESCE(title, 'Your location') AS title FROM gbp_locations ORDER BY linked_at ASC LIMIT 1`,
  );

  if (locRes.rowCount === 0) {
    return (
      <main>
        <h1>Rankings</h1>
        <p>Connect your Google Business Profile first to start local keyword tracking.</p>
        <div className="empty">No location found.</div>
      </main>
    );
  }

  const location = locRes.rows[0];
  const data = await db.query<Row>(
    `
    SELECT
      k.id AS keyword_id,
      k.keyword,
      s.city,
      s.captured_at::text,
      s.rank,
      s.found,
      s.delayed,
      (
        SELECT s2.rank
        FROM gbp_rank_snapshots s2
        WHERE s2.keyword_id = k.id
        ORDER BY s2.captured_at DESC
        OFFSET 1 LIMIT 1
      ) AS prev_rank,
      (
        SELECT s3.rank
        FROM gbp_rank_snapshots s3
        WHERE s3.keyword_id = k.id
        ORDER BY s3.captured_at DESC
        OFFSET 2 LIMIT 1
      ) AS prev_prev_rank
    FROM gbp_keywords k
    LEFT JOIN LATERAL (
      SELECT city, captured_at, rank, found, delayed
      FROM gbp_rank_snapshots s
      WHERE s.keyword_id = k.id
      ORDER BY s.captured_at DESC
      LIMIT 1
    ) s ON true
    WHERE k.location_id = $1
    ORDER BY k.created_at ASC
    `,
    [location.id],
  );

  const keywordsText = data.rows.map((r) => r.keyword).join("\n");
  const hasSnapshots = data.rows.some((r) => r.captured_at);

  return (
    <main>
      <h1>Local rankings</h1>
      <p>Track up to 20 service-area keywords from your target city centroid.</p>

      <section className="card">
        <h2>{location.title}</h2>
        <form action={seedKeywordsAction}>
          <input type="hidden" name="locationId" value={location.id} />
          <button type="submit">Seed keyword suggestions</button>
        </form>
        <form action={saveKeywordsAction}>
          <input type="hidden" name="locationId" value={location.id} />
          <label htmlFor="keywords">Keywords (one per line, max 20)</label>
          <textarea id="keywords" name="keywords" defaultValue={keywordsText} rows={8} />
          <button type="submit">Save keywords</button>
        </form>
      </section>

      {!hasSnapshots ? (
        <div className="empty">
          <p>First snapshot runs tonight.</p>
        </div>
      ) : (
        <section>
          {data.rows.map((r) => {
            const delta = deltaLabel(r.rank, r.prev_rank);
            return (
              <article className="card" key={r.keyword_id}>
                <h3>{r.keyword}</h3>
                <p className="muted">
                  Snapshot: {r.captured_at ? new Date(r.captured_at).toLocaleDateString() : "—"} · City:{" "}
                  {r.city ?? "—"} {r.delayed ? "· rankings delayed" : ""}
                </p>
                <p style={{ fontSize: "2rem", margin: 0 }}>{r.rank ?? "—"}</p>
                <p>{delta}</p>
                <p className="muted">
                  Trend: {r.prev_prev_rank ?? "—"} → {r.prev_rank ?? "—"} → {r.rank ?? "—"}
                </p>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
