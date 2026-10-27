import { query } from "@/lib/db";
import { getAutomationPauseState } from "@/lib/gbp/automation-pause";

export interface EscalationQueueItem {
  escalationId: string;
  severity: string;
  category: string;
  action: string;
  agentRationale: string | null;
  draftedReply: string | null;
  editedReply: string | null;
  actionNote: string | null;
  createdAt: string;
  locationId: string;
  locationTitle: string | null;
  reviewId: string | null;
  reviewerName: string | null;
  reviewComment: string | null;
  starRating: number | null;
  tokenCostInput: number;
  tokenCostOutput: number;
  providerSpendUsd: string;
  quotaUnits: number;
}

export interface FleetHealthRow {
  locationId: string;
  title: string | null;
  timezone: string | null;
  paused: boolean;
  pauseReason: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  quotaEvents24h: number;
  authRevocations30d: number;
  suspensionSignals30d: number;
  tokenCost30d: number;
  providerSpend30d: string;
}

export async function listEscalations(filters: {
  severity?: string;
  action?: string;
  locationId?: string;
}): Promise<EscalationQueueItem[]> {
  const rows = await query<any>(
    `SELECT
      e.id AS escalation_id,
      e.severity,
      e.category,
      e.action,
      e.agent_rationale,
      e.drafted_reply,
      e.edited_reply,
      e.action_note,
      e.created_at,
      e.location_id,
      l.title AS location_title,
      r.id AS review_id,
      r.reviewer_name,
      r.comment AS review_comment,
      r.star_rating,
      e.token_cost_input,
      e.token_cost_output,
      e.provider_spend_usd,
      e.quota_units
     FROM gbp_escalations e
     LEFT JOIN gbp_locations l ON l.id = e.location_id
     LEFT JOIN gbp_reviews r ON r.id = e.review_id
     WHERE ($1::text IS NULL OR e.severity = $1)
       AND ($2::text IS NULL OR e.action = $2)
       AND ($3::uuid IS NULL OR e.location_id = $3::uuid)
     ORDER BY e.created_at DESC
     LIMIT 200`,
    [filters.severity ?? null, filters.action ?? null, filters.locationId ?? null],
  );

  return rows.map((r: any) => ({
    escalationId: r.escalation_id,
    severity: r.severity,
    category: r.category,
    action: r.action,
    agentRationale: r.agent_rationale,
    draftedReply: r.drafted_reply,
    editedReply: r.edited_reply,
    actionNote: r.action_note,
    createdAt: r.created_at,
    locationId: r.location_id,
    locationTitle: r.location_title,
    reviewId: r.review_id,
    reviewerName: r.reviewer_name,
    reviewComment: r.review_comment,
    starRating: r.star_rating,
    tokenCostInput: Number(r.token_cost_input ?? 0),
    tokenCostOutput: Number(r.token_cost_output ?? 0),
    providerSpendUsd: String(r.provider_spend_usd ?? "0"),
    quotaUnits: Number(r.quota_units ?? 0),
  }));
}

export async function getFleetHealth(): Promise<{ fleetPaused: boolean; rows: FleetHealthRow[] }> {
  const fleetPause = await getAutomationPauseState();

  const rows = await query<any>(
    `SELECT
      l.id AS location_id,
      l.title,
      l.timezone,
      COALESCE(p.is_paused, false) AS paused,
      p.reason AS pause_reason,
      s.finished_at AS last_sync_at,
      s.status AS last_sync_status,
      COALESCE((
        SELECT COUNT(*) FROM gbp_api_health_events hq
        WHERE hq.location_id = l.id
          AND hq.quota_exceeded = true
          AND hq.created_at >= now() - interval '24 hours'
      ), 0) AS quota_events_24h,
      COALESCE((
        SELECT COUNT(*) FROM gbp_api_health_events ha
        WHERE ha.location_id = l.id
          AND (ha.error_code = 'AUTH_REVOKED' OR ha.status_code = 401)
          AND ha.created_at >= now() - interval '30 days'
      ), 0) AS auth_revocations_30d,
      COALESCE((
        SELECT COUNT(*) FROM gbp_api_health_events hs
        WHERE hs.location_id = l.id
          AND (hs.error_code = 'SUSPENSION_SIGNAL' OR hs.status_code = 423)
          AND hs.created_at >= now() - interval '30 days'
      ), 0) AS suspension_signals_30d,
      COALESCE((
        SELECT SUM(e2.token_cost_input + e2.token_cost_output)::bigint
        FROM gbp_escalations e2
        WHERE e2.location_id = l.id
          AND e2.created_at >= now() - interval '30 days'
      ), 0) AS token_cost_30d,
      COALESCE((
        SELECT SUM(e3.provider_spend_usd)
        FROM gbp_escalations e3
        WHERE e3.location_id = l.id
          AND e3.created_at >= now() - interval '30 days'
      ), 0) AS provider_spend_30d
     FROM gbp_locations l
     LEFT JOIN LATERAL (
      SELECT finished_at, status
      FROM gbp_sync_runs ss
      WHERE ss.location_id = l.id
      ORDER BY ss.started_at DESC
      LIMIT 1
     ) s ON true
     LEFT JOIN gbp_automation_pauses p
       ON p.scope = 'location' AND p.location_id = l.id
     ORDER BY l.title NULLS LAST, l.linked_at DESC`,
    [],
  );

  return {
    fleetPaused: fleetPause.isPaused,
    rows: rows.map((r: any) => ({
      locationId: r.location_id,
      title: r.title,
      timezone: r.timezone,
      paused: r.paused,
      pauseReason: r.pause_reason,
      lastSyncAt: r.last_sync_at,
      lastSyncStatus: r.last_sync_status,
      quotaEvents24h: Number(r.quota_events_24h ?? 0),
      authRevocations30d: Number(r.auth_revocations_30d ?? 0),
      suspensionSignals30d: Number(r.suspension_signals_30d ?? 0),
      tokenCost30d: Number(r.token_cost_30d ?? 0),
      providerSpend30d: String(r.provider_spend_30d ?? "0"),
    })),
  };
}
