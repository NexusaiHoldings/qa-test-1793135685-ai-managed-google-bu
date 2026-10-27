import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";
import { listEscalations } from "@/lib/gbp/platform-health";

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function EscalationsPage({ searchParams }: PageProps): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const severity = typeof searchParams?.severity === "string" ? searchParams.severity : undefined;
  const action = typeof searchParams?.action === "string" ? searchParams.action : undefined;
  const items = await listEscalations({ severity, action });

  return (
    <main>
      <h1>Escalations</h1>
      <p>Operator queue for sensitive GBP review replies and manual intervention.</p>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1rem" }}>
        <aside className="card">
          <form method="get">
            <label>Severity</label>
            <select name="severity" defaultValue={severity ?? ""}>
              <option value="">All</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
            <label>Action</label>
            <select name="action" defaultValue={action ?? ""}>
              <option value="">All</option>
              <option value="open">open</option>
              <option value="approved">approved</option>
              <option value="edited_published">edited_published</option>
              <option value="manual_offline">manual_offline</option>
              <option value="dismissed">dismissed</option>
            </select>
            <button type="submit">Apply filters</button>
          </form>
        </aside>
        <section>
          {items.length === 0 ? (
            <div className="empty">No escalations — the agent is handling everything.</div>
          ) : (
            items.map((item) => (
              <article key={item.escalationId} className="card" style={{ borderLeft: "6px solid #6b7280", marginBottom: "0.75rem" }}>
                <p className="muted">
                  {item.severity.toUpperCase()} · {item.category} · {new Date(item.createdAt).toLocaleString()}
                </p>
                <h3>{item.locationTitle ?? item.locationId}</h3>
                <p><strong>Review:</strong> {item.reviewComment ?? "No review text"}</p>
                <p><strong>Agent rationale:</strong> {item.agentRationale ?? "—"}</p>
                <p><strong>Draft:</strong> {item.draftedReply ?? "—"}</p>
                {item.editedReply ? (
                  <pre>{`- ${item.draftedReply ?? ""}
+ ${item.editedReply}`}</pre>
                ) : null}
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
