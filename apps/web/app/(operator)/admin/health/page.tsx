/**
 * Platform-health console (Feature F1-010).
 *
 * Per-location automation status, last successful sync, GBP API quota events,
 * auth revocations, and suspension signals, plus the kill switch: a per-location
 * AND fleet-wide pause control backed by automation-pause.ts. Quota, token-cost,
 * and provider-spend figures appear ONLY here — never on customer pages.
 *
 * Server component — redirects non-admins. Pause toggles run through inline
 * server actions that re-authenticate and audit-log every flip.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";
import { getFleetHealth, type LocationHealth } from "@/lib/gbp/platform-health";
import { setAutomationPause } from "@/lib/gbp/automation-pause";

export const dynamic = "force-dynamic";

const AUDIT_FALLBACK_ACTOR = "00000000-0000-0000-0000-000000000000";

type DotTone = { color: string; label: string };

function locationTone(loc: LocationHealth): DotTone {
  if (loc.paused) return { color: "#6b7280", label: "Paused" };
  if (loc.suspensionSignals30d > 0) return { color: "#b91c1c", label: "Suspension signal" };
  if (loc.authRevocations30d > 0) return { color: "#b91c1c", label: "Auth revoked" };
  if (loc.quotaEvents24h > 0) return { color: "#b45309", label: "Quota pressure" };
  if (loc.degraded) return { color: "#b45309", label: "Degraded" };
  return { color: "#16a34a", label: "Healthy" };
}

function toDateLabel(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Re-auth, flip the automation kill switch, and audit it. */
async function togglePause(formData: FormData): Promise<void> {
  "use server";
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const scope = String(formData.get("scope") ?? "");
  const locationId = String(formData.get("locationId") ?? "").trim();
  const paused = String(formData.get("paused") ?? "") === "true";
  const reason = String(formData.get("reason") ?? "").trim();

  if (scope !== "fleet" && scope !== "location") return;
  if (scope === "location" && !locationId) return;

  const state = await setAutomationPause({
    scope,
    locationId: scope === "location" ? locationId : null,
    paused,
    reason: reason || null,
    actorUserId: admin.id || null,
    actorEmail: admin.email ?? null,
    source: "operator_health_console",
  });

  const db = buildDb();
  await db.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    admin.id || AUDIT_FALLBACK_ACTOR,
    state.paused ? "gbp.automation.pause" : "gbp.automation.resume",
    state.scope === "fleet" ? "gbp_fleet" : "gbp_location",
    state.scope === "fleet" ? "fleet" : state.locationId,
    JSON.stringify({
      actorEmail: admin.email,
      scope: state.scope,
      locationId: state.locationId,
      reason: state.reason,
      source: state.source,
    }),
  );

  revalidatePath("/admin/health");
}

export default async function HealthPage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const data = await getFleetHealth();

  return (
    <main>
      <h1>Platform Health</h1>
      <p>
        Fleet automation status, sync health, GBP API quota pressure, auth revocations, and suspension
        signals. Cost figures (token &amp; provider spend) are operator-only and never shown to customers.
      </p>

      <div className="card" style={{ display: "grid", gap: "0.75rem" }}>
        <div className="toolbar" style={{ alignItems: "center" }}>
          <strong>Fleet automation: {data.fleetPaused ? "⏸ PAUSED" : "▶ running"}</strong>
          <span className="muted">
            {data.healthyLocations} healthy · {data.degradedLocations} degraded · {data.pausedLocations}{" "}
            paused · {data.totalLocations} total
          </span>
          <span className="muted">
            LLM token cost 30d {usd(data.tokenCost30d)} · provider spend 30d {usd(data.providerSpend30d)}
          </span>
        </div>
        {data.fleetPaused && data.fleetPauseReason ? (
          <p className="muted" style={{ margin: 0 }}>
            Fleet paused: {data.fleetPauseReason}
          </p>
        ) : null}
        <form action={togglePause} className="toolbar">
          <input type="hidden" name="scope" value="fleet" />
          <input type="hidden" name="paused" value={data.fleetPaused ? "false" : "true"} />
          {data.fleetPaused ? null : (
            <input type="text" name="reason" placeholder="Reason for fleet-wide pause" />
          )}
          <button type="submit">
            {data.fleetPaused ? "Resume whole fleet" : "Pause whole fleet (kill switch)"}
          </button>
        </form>
      </div>

      {data.locations.length === 0 ? (
        <div className="empty">No linked locations yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Location</th>
              <th>Last sync</th>
              <th>Quota 24h</th>
              <th>Auth revoked 30d</th>
              <th>Suspension 30d</th>
              <th>Token cost 30d</th>
              <th>Provider spend 30d</th>
              <th>Automation</th>
            </tr>
          </thead>
          <tbody>
            {data.locations.map((loc) => {
              const tone = locationTone(loc);
              const tip = `${tone.label}${loc.pauseReason ? ` — ${loc.pauseReason}` : ""}${
                loc.lastSyncStatus ? ` · last sync ${loc.lastSyncStatus}` : ""
              }`;
              return (
                <tr key={loc.locationId}>
                  <td>
                    <span
                      title={tip}
                      aria-label={tone.label}
                      style={{
                        display: "inline-block",
                        width: "0.8rem",
                        height: "0.8rem",
                        borderRadius: "50%",
                        background: tone.color,
                      }}
                    />
                  </td>
                  <td title={loc.locationId}>{loc.title}</td>
                  <td>{toDateLabel(loc.lastSyncAt)}</td>
                  <td>{loc.quotaEvents24h}</td>
                  <td>{loc.authRevocations30d}</td>
                  <td>{loc.suspensionSignals30d}</td>
                  <td>{usd(loc.tokenCost30d)}</td>
                  <td>{usd(loc.providerSpend30d)}</td>
                  <td>
                    <form action={togglePause} className="toolbar" style={{ gap: "0.4rem" }}>
                      <input type="hidden" name="scope" value="location" />
                      <input type="hidden" name="locationId" value={loc.locationId} />
                      <input type="hidden" name="paused" value={loc.paused ? "false" : "true"} />
                      <button type="submit" className="secondary" disabled={data.fleetPaused && !loc.paused}>
                        {loc.paused ? "Resume" : "Pause"}
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
