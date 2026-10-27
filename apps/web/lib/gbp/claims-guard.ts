import { Pool } from "pg";
import {
  type ClaimsContentKind,
  type FlaggedClaim,
  detectFlaggedClaims,
  getClaimsRulesForState,
} from "@/lib/gbp/claims-rules";

// Shared pooled connection — matches the pg convention used across lib/gbp/*
// (voice-profile.ts, review-sync.ts). Raw parameterized SQL, no ORM.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type ClaimsVerdict = "pass" | "blocked";

export interface ClaimsGuardInput {
  locationId: string;
  contentKind: ClaimsContentKind;
  contentRef: string | null;
  originalText: string;
  competitorNames?: string[];
}

export interface ClaimsGuardResult {
  verdict: ClaimsVerdict;
  strippedClaims: FlaggedClaim[];
  rewrittenText: string;
  contentCheckId: string;
}

interface RewriterResponse {
  rewrittenText: string;
}

function sanitizeTextByRemovingFindings(text: string, findings: FlaggedClaim[]): string {
  if (findings.length === 0) return text.trim();

  const sorted = [...findings].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = "";

  for (const finding of sorted) {
    const start = Math.max(0, finding.start);
    const end = Math.min(text.length, finding.end);
    if (end <= cursor) continue;
    if (start > cursor) {
      output += text.slice(cursor, start);
    }
    cursor = end;
  }

  if (cursor < text.length) {
    output += text.slice(cursor);
  }

  return output
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

async function gatewayRewrite(
  originalText: string,
  findings: FlaggedClaim[],
): Promise<RewriterResponse> {
  const deterministic = sanitizeTextByRemovingFindings(originalText, findings);
  return { rewrittenText: deterministic };
}

interface LocationStateRow {
  state: string | null;
  storefront_address: Record<string, unknown> | null;
  service_areas: unknown;
}

/**
 * Resolve the location's state code so the per-state rule set applies
 * (ceo_briefing: state trade-licensing advertising requirements can be
 * tightened per state without code changes). Prefers the denormalized
 * gbp_locations.state column, falling back to the structured address /
 * service-area region code when state has not been backfilled yet.
 */
async function getLocationState(locationId: string): Promise<string | null> {
  const rows = await pool.query<LocationStateRow>(
    `SELECT state, storefront_address, service_areas
       FROM gbp_locations
      WHERE id = $1::uuid
      LIMIT 1`,
    [locationId],
  );

  const row = rows.rows[0];
  if (!row) return null;

  if (typeof row.state === "string" && row.state.trim()) {
    return row.state;
  }

  const address = row.storefront_address ?? null;
  if (address && typeof address.administrativeArea === "string") {
    return address.administrativeArea;
  }

  const serviceAreas = Array.isArray(row.service_areas) ? row.service_areas : [];
  for (const item of serviceAreas) {
    if (item && typeof item === "object" && "regionCode" in item) {
      const regionCode = (item as Record<string, unknown>).regionCode;
      if (typeof regionCode === "string" && regionCode.trim()) return regionCode;
    }
  }

  return null;
}

export async function runClaimsGuard(input: ClaimsGuardInput): Promise<ClaimsGuardResult> {
  const state = await getLocationState(input.locationId);
  const rules = getClaimsRulesForState(state);
  const strippedClaims = detectFlaggedClaims(
    input.originalText,
    rules,
    input.competitorNames ?? [],
  );

  const rewritten = await gatewayRewrite(input.originalText, strippedClaims);
  const hasResidualFindings = detectFlaggedClaims(
    rewritten.rewrittenText,
    rules,
    input.competitorNames ?? [],
  ).length > 0;

  const verdict: ClaimsVerdict =
    strippedClaims.length === 0 || (!hasResidualFindings && rewritten.rewrittenText.length > 0)
      ? "pass"
      : "blocked";

  const strippedJson = JSON.stringify(strippedClaims);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO gbp_content_checks (
       location_id,
       subject_type,
       subject_id,
       verdict,
       findings,
       content_kind,
       content_ref,
       stripped_claims,
       rewritten_text
     )
     VALUES (
       $1::uuid,
       'claims_guard',
       $2::uuid,
       $3,
       $4::jsonb,
       $5,
       $2::uuid,
       $4::jsonb,
       $6
     )
     RETURNING id`,
    [
      input.locationId,
      input.contentRef,
      verdict,
      strippedJson,
      input.contentKind,
      rewritten.rewrittenText,
    ],
  );

  return {
    verdict,
    strippedClaims,
    rewrittenText: rewritten.rewrittenText,
    contentCheckId: inserted.rows[0].id,
  };
}
