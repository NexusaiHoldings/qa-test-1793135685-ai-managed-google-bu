import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";
import { getFleetHealth } from "@/lib/gbp/platform-health";

export default async function HealthPage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const data = await getFleetHealth();

  return (
    <main>
      <h1>Platform Health</h1>
      <p>Fleet automation status, sync health, quota pressure, auth revocations, and suspension signals.</p>
      <div className="card">
        <p>
          <strong>Fleet pause:</strong> {data.fleetPaused ? "Paused" : "Running"}
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>Status</th>
            <th>Last Sync</th>
            <th>Quota 24h</th>
            <th>Auth Revocations 30d</th>
            <th>Suspension Signals 30d</th>
            <th>Token Cost 30d</th>
            <th>Provider Spend 30d</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.locationId}>
              <td>{row.title ?? row.locationId}</td>
              <td title={row.pauseReason ?? ""}>{row.paused ? "● paused" : "● active"}</td>
              <td>{row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString() : "—"}</td>
              <td>{row.quotaEvents24h}</td>
              <td>{row.authRevocations30d}</td>
              <td>{row.suspensionSignals30d}</td>
              <td>{row.tokenCost30d}</td>
              <td>${row.providerSpend30d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
