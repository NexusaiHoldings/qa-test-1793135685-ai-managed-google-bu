import { Pool } from "pg";
import { getAutomationPauseMap } from "@/lib/gbp/automation-pause";

type LocationHealthRow = {
  location_id: string;
  title: string | null;
  timezone: string | null;
  state: string | null;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  quota_events_24h: string;
  auth_revocations_30d: string;
  suspension_signals_30d: string;
};

export type LocationHealth = {
  locationId: string;
  title: string;
  timezone: string | null;
  state: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  quotaEvents24h: number;
  authRevocations30d: number;
  suspensionSignals30d: number;
  automationPaused: boolean;
};

export type FleetHealth = {
  fleetPaused: boolean;
  totalLocations: number;
  pausedLocations: number;
  healthyLocations: number;
  degradedLocations: number;
  locations: LocationHealth[];
};

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString: string | undefined = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  pool = new Pool({ connectionString });
  return pool;
}

export async function getFleetHealth(): Promise<FleetHealth> {
  const db = getPool();
  const pauseMap = await getAutomationPauseMap();

  const sql = `
    WITH latest_sync AS (
      SELECT DISTINCT ON (location_id)
        location_id, started_at, status
      FROM gbp_sync_runs
      WHERE location_id IS NOT NULL
      ORDER BY location_id, started_at DESC
    ),
    quota_events AS (
      SELECT location_id, COUNT(*)::int AS c
      FROM gbp_api_health_events
      WHERE quota_exceeded = true
        AND created_at >= now() - interval '24 hours'
      GROUP BY location_id
    ),
    auth_revocations AS (
      SELECT location_id, COUNT(*)::int AS c
      FROM gbp_api_health_events
      WHERE (error_code = 'auth_revoked' OR status_code = 401)
        AND created_at >= now() - interval '30 days'
      GROUP BY location_id
    ),
    suspension_signals AS (
      SELECT location_id, COUNT(*)::int AS c
      FROM gbp_api_health_events
      WHERE (error_code = 'suspended' OR status_code = 403)
        AND created_at >= now() - interval '30 days'
      GROUP BY location_id
    )
    SELECT
      l.id AS location_id,
      l.title,
      l.timezone,
      l.state,
      s.started_at AS last_sync_at,
      s.status AS last_sync_status,
      COALESCE(q.c, 0)::text AS quota_events_24h,
      COALESCE(a.c, 0)::text AS auth_revocations_30d,
      COALESCE(ss.c, 0)::text AS suspension_signals_30d
    FROM gbp_locations l
    LEFT JOIN latest_sync s ON s.location_id = l.id
    LEFT JOIN quota_events q ON q.location_id = l.id
    LEFT JOIN auth_revocations a ON a.location_id = l.id
    LEFT JOIN suspension_signals ss ON ss.location_id = l.id
    ORDER BY l.linked_at DESC
  `;
  const result = await db.query<LocationHealthRow>(sql);

  const locations: LocationHealth[] = result.rows.map((row) => {
    const pausedByLocation = Boolean(pauseMap.byLocationId[row.location_id]?.paused);
    return {
      locationId: row.location_id,
      title: row.title ?? "Untitled location",
      timezone: row.timezone,
      state: row.state,
      lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
      lastSyncStatus: row.last_sync_status,
      quotaEvents24h: Number(row.quota_events_24h),
      authRevocations30d: Number(row.auth_revocations_30d),
      suspensionSignals30d: Number(row.suspension_signals_30d),
      automationPaused: pauseMap.fleetPaused || pausedByLocation,
    };
  });

  let healthyLocations = 0;
  let degradedLocations = 0;
  let pausedLocations = 0;

  for (const location of locations) {
    if (location.automationPaused) pausedLocations += 1;
    const degraded =
      location.quotaEvents24h > 0 ||
      location.authRevocations30d > 0 ||
      location.suspensionSignals30d > 0 ||
      location.lastSyncStatus === "failed";
    if (degraded) degradedLocations += 1;
    else healthyLocations += 1;
  }

  return {
    fleetPaused: pauseMap.fleetPaused,
    totalLocations: locations.length,
    pausedLocations,
    healthyLocations,
    degradedLocations,
    locations,
  };
}
