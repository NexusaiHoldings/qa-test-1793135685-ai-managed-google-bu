import { sql } from "@repo/db";
import {
  ClaimsContentKind,
  FlaggedClaim,
  detectFlaggedClaims,
  getClaimsRulesForState,
} from "@/lib/gbp/claims-rules";

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

async function getLocationState(locationId: string): Promise<string | null> {
  const rows = await sql<{ storefront_address: unknown; service_areas: unknown }[]>`
    SELECT storefront_address, service_areas
    FROM gbp_locations
    WHERE id = ${locationId}::uuid
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  const address = (row.storefront_address as Record<string, unknown> | null) ?? null;
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

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO gbp_content_checks (
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
      ${input.locationId}::uuid,
      'claims_guard',
      ${input.contentRef ? sql`${input.contentRef}::uuid` : sql`NULL`},
      ${verdict},
      ${JSON.stringify(strippedClaims)}::jsonb,
      ${input.contentKind},
      ${input.contentRef ? sql`${input.contentRef}::uuid` : sql`NULL`},
      ${JSON.stringify(strippedClaims)}::jsonb,
      ${rewritten.rewrittenText}
    )
    RETURNING id
  `;

  return {
    verdict,
    strippedClaims,
    rewrittenText: rewritten.rewrittenText,
    contentCheckId: inserted[0].id,
  };
}
