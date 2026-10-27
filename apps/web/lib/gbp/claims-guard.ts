import { query } from "@repo/db";
import { runClaimsRules, type ClaimsRuleMatch, type GbpContentKind } from "@/lib/gbp/claims-rules";

export type ClaimsGuardVerdict = "pass" | "rewrite_required" | "blocked";

export interface ClaimsGuardInput {
  locationId: string;
  contentKind: GbpContentKind;
  contentRef: string;
  text: string;
  competitorNames?: string[];
}

export interface ClaimsGuardResult {
  verdict: ClaimsGuardVerdict;
  strippedClaims: ClaimsRuleMatch[];
  rewrittenText: string;
  checkId: string;
}

interface LocationStateRow {
  state: string | null;
}

interface CheckInsertRow {
  id: string;
}

function scrubByRules(text: string, matches: ClaimsRuleMatch[]): string {
  if (matches.length === 0) return text.trim();

  let rewritten = text;
  const ordered = [...matches].sort((a, b) => b.start - a.start);
  for (const match of ordered) {
    rewritten = `${rewritten.slice(0, match.start)} ${rewritten.slice(match.end)}`;
  }

  return rewritten.replace(/\s+/g, " ").replace(/\s([,.!?;:])/g, "$1").trim();
}

async function getLocationState(locationId: string): Promise<string | null> {
  const rows = await query<LocationStateRow>(
    `
      SELECT (storefront_address ->> 'regionCode') AS state
      FROM gbp_locations
      WHERE id = $1
      LIMIT 1
    `,
    [locationId],
  );

  if (rows.length === 0) {
    throw new Error("GBP location not found for claims guard.");
  }

  return rows[0]?.state ?? null;
}

async function rewriteThroughGateway(
  originalText: string,
  strippedClaims: ClaimsRuleMatch[],
): Promise<string> {
  const deterministic = scrubByRules(originalText, strippedClaims);
  return deterministic;
}

async function insertContentCheck(params: {
  locationId: string;
  contentKind: GbpContentKind;
  contentRef: string;
  verdict: ClaimsGuardVerdict;
  strippedClaims: ClaimsRuleMatch[];
  rewrittenText: string;
}): Promise<string> {
  const rows = await query<CheckInsertRow>(
    `
      INSERT INTO gbp_content_checks (
        location_id,
        content_kind,
        content_ref,
        verdict,
        stripped_claims,
        rewritten_text
      )
      VALUES ($1, $2, $3::uuid, $4, $5::jsonb, $6)
      RETURNING id
    `,
    [
      params.locationId,
      params.contentKind,
      params.contentRef,
      params.verdict,
      JSON.stringify(params.strippedClaims),
      params.rewrittenText,
    ],
  );

  return rows[0]?.id ?? "";
}

export async function runClaimsGuard(input: ClaimsGuardInput): Promise<ClaimsGuardResult> {
  const state = await getLocationState(input.locationId);
  const strippedClaims = runClaimsRules({
    text: input.text,
    state,
    contentKind: input.contentKind,
    competitorNames: input.competitorNames,
  });

  const hasHighSeverity = strippedClaims.some((m) => m.severity === "high");
  const rewrittenText = await rewriteThroughGateway(input.text, strippedClaims);

  let verdict: ClaimsGuardVerdict = "pass";
  if (strippedClaims.length > 0) {
    verdict = hasHighSeverity ? "blocked" : "rewrite_required";
  }

  const checkId = await insertContentCheck({
    locationId: input.locationId,
    contentKind: input.contentKind,
    contentRef: input.contentRef,
    verdict,
    strippedClaims,
    rewrittenText,
  });

  return {
    verdict,
    strippedClaims,
    rewrittenText,
    checkId,
  };
}
