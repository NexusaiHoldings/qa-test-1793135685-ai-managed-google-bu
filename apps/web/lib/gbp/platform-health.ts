/**
 * Fleet platform-health aggregation (Feature F1-010).
 *
 * Powers /admin/health: per-location automation status, last successful sync,
 * GBP API quota events, auth revocations, and suspension signals pulled from
 * `gbp_api_health_events` + `gbp_sync_runs`, joined with the operator pause
 * state. Also surfaces the internal-only cost figures (LLM token cost and
 * third-party SERP provider spend) that the objective says must appear ONLY on
 * this operator page and never on customer surfaces.
 *
 * Cost is estimated from real activity counts — drafts generated
 * (`gbp_reviews.draft_generated_at`) priced at the LLM per-draft rate, and
 * DataForSEO queries (`gbp_rank_snapshots`) priced at the per-query rate — both
 * configurable via env so the figure tracks whatever the current contracts are.
 */

import { buildDb } from "@/lib/db";
import { getAutomationPauseMap } from "@/lib/gbp/automation-pause";

type LocationHealthRow = {
  location_id: string;
  title: string | null;
  timezone: string | null;
  state: string | null;
  last_sync_at: Date | string | null;
  last_sync_status: string | null;
  quota_events_24h: number;
  auth_revocations_30d: number;
  suspension_signals_30d: number;
  drafts_30d: number;
  serp_queries_30d: number;
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
  paused: boolean;
  pauseReason: string | null;
  degraded: boolean;
  draftsGenerated30d: number;
  serpQueries30d: number;
  tokenCost30d: number;
  providerSpend30d: number;
};

export type FleetHealth = {
  fleetPaused: boolean;
  fleetPauseReason: string | null;
  totalLocations: number;
  pausedLocations: number;
  healthyLocations: number;
  degradedLocations: number;
  tokenCost30d: number;
  providerSpend30d: number;
  locations: LocationHealth[];
};

/** USD charged per generated LLM reply draft (gateway blended rate). */
function llmDraftCostUsd(): number {
  const raw = Number(process.env.GBP_LLM_DRAFT_COST_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.01;
}

/** USD charged per DataForSEO local-pack query. */
function serpQueryCostUsd(): number {
  const raw = Number(process.env.GBP_SERP_QUERY_COST_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.0006;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getFleetHealth(): Promise<FleetHealth> {
  const db = buildDb();
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
    ),
    drafts AS (
      SELECT location_id, COUNT(*)::int AS c
      FROM gbp_reviews
      WHERE draft_generated_at >= now() - interval '30 days'
      GROUP BY location_id
    ),
    serp AS (
      SELECT location_id, COUNT(*)::int AS c
      FROM gbp_rank_snapshots
      WHERE captured_at >= now() - interval '30 days'
      GROUP BY location_id
    )
    SELECT
      l.id AS location_id,
      l.title,
      l.timezone,
      l.state,
      s.started_at AS last_sync_at,
      s.status AS last_sync_status,
      COALESCE(q.c, 0) AS quota_events_24h,
      COALESCE(a.c, 0) AS auth_revocations_30d,
      COALESCE(ss.c, 0) AS suspension_signals_30d,
      COALESCE(d.c, 0) AS drafts_30d,
      COALESCE(sp.c, 0) AS serp_queries_30d
    FROM gbp_locations l
    LEFT JOIN latest_sync s ON s.location_id = l.id
    LEFT JOIN quota_events q ON q.location_id = l.id
    LEFT JOIN auth_revocations a ON a.location_id = l.id
    LEFT JOIN suspension_signals ss ON ss.location_id = l.id
    LEFT JOIN drafts d ON d.location_id = l.id
    LEFT JOIN serp sp ON sp.location_id = l.id
    ORDER BY l.linked_at DESC
  `;
  const rows = await db.query<LocationHealthRow>(sql);

  const draftCost = llmDraftCostUsd();
  const serpCost = serpQueryCostUsd();

  let healthyLocations = 0;
  let degradedLocations = 0;
  let pausedLocations = 0;
  let tokenCostTotal = 0;
  let providerSpendTotal = 0;

  const locations: LocationHealth[] = rows.map((row) => {
    const ownPause = pauseMap.byLocationId[row.location_id];
    const paused = pauseMap.fleetPaused || Boolean(ownPause?.paused);
    const quota = Number(row.quota_events_24h);
    const revocations = Number(row.auth_revocations_30d);
    const suspensions = Number(row.suspension_signals_30d);
    const drafts = Number(row.drafts_30d);
    const serpQueries = Number(row.serp_queries_30d);
    const tokenCost = round2(drafts * draftCost);
    const providerSpend = round2(serpQueries * serpCost);

    const degraded =
      quota > 0 ||
      revocations > 0 ||
      suspensions > 0 ||
      row.last_sync_status === "failed" ||
      row.last_sync_status === "error";

    if (paused) pausedLocations += 1;
    if (degraded) degradedLocations += 1;
    else healthyLocations += 1;
    tokenCostTotal += tokenCost;
    providerSpendTotal += providerSpend;

    return {
      locationId: row.location_id,
      title: row.title ?? "Untitled location",
      timezone: row.timezone,
      state: row.state,
      lastSyncAt: toIso(row.last_sync_at),
      lastSyncStatus: row.last_sync_status,
      quotaEvents24h: quota,
      authRevocations30d: revocations,
      suspensionSignals30d: suspensions,
      paused,
      pauseReason: pauseMap.fleetPaused
        ? pauseMap.fleet?.reason ?? null
        : ownPause?.reason ?? null,
      degraded,
      draftsGenerated30d: drafts,
      serpQueries30d: serpQueries,
      tokenCost30d: tokenCost,
      providerSpend30d: providerSpend,
    };
  });

  return {
    fleetPaused: pauseMap.fleetPaused,
    fleetPauseReason: pauseMap.fleet?.reason ?? null,
    totalLocations: locations.length,
    pausedLocations,
    healthyLocations,
    degradedLocations,
    tokenCost30d: round2(tokenCostTotal),
    providerSpend30d: round2(providerSpendTotal),
    locations,
  };
}
