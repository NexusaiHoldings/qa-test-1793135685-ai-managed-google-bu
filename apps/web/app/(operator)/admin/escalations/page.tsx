import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";

type Escalation = {
  id: string;
  reviewId: string | null;
  locationId: string;
  locationTitle: string;
  reason: string | null;
  riskLevel: string;
  status: string;
  createdAt: string;
  agentRationale: string | null;
  draftedReply: string | null;
  editedReply: string | null;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
};

async function fetchEscalations(): Promise<Escalation[]> {
  const res = await fetch(`${process.env.NEXTAUTH_URL ?? ""}/admin/api/escalations`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { escalations: Escalation[] };
  return data.escalations ?? [];
}

function severityColor(level: string): string {
  if (level === "high") return "#b91c1c";
  if (level === "medium") return "#b45309";
  return "#1f2937";
}

export default async function EscalationsPage(): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) redirect("/");

  const escalations = await fetchEscalations();

  return (
    <main>
      <h1>Escalations</h1>
      <p>Human-in-the-loop queue for sensitive GBP review situations and operator actions.</p>

      {escalations.length === 0 ? (
        <div className="empty">No escalations — the agent is handling everything</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1rem" }}>
          <aside className="card">
            <h3>Filters</h3>
            <ul>
              <li>Open first</li>
              <li>Risk tier</li>
              <li>Location</li>
            </ul>
            <p className="muted">Use API actions from internal tooling for now.</p>
          </aside>

          <section style={{ display: "grid", gap: "0.75rem" }}>
            {escalations.map((e) => (
              <article
                key={e.id}
                className="card"
                style={{ borderLeft: `6px solid ${severityColor(e.riskLevel)}` }}
              >
                <h3>
                  {e.locationTitle} · {e.riskLevel.toUpperCase()} · {e.status}
                </h3>
                <p className="muted">
                  Reviewer: {e.reviewerName ?? "Unknown"} {e.starRating ? `· ${e.starRating}★` : ""} ·{" "}
                  {new Date(e.createdAt).toLocaleString()}
                </p>
                <p>{e.comment ?? "No review body."}</p>
                <p>
                  <strong>Reason:</strong> {e.reason ?? "—"}
                </p>
                <p>
                  <strong>Agent rationale:</strong> {e.agentRationale ?? "—"}
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <h4>Drafted reply</h4>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{e.draftedReply ?? "—"}</pre>
                  </div>
                  <div>
                    <h4>Edited reply (diff view)</h4>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{e.editedReply ?? "(no edits yet)"}</pre>
                  </div>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
