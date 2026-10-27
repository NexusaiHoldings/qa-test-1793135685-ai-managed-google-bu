export type ClaimsContentKind = "review_reply" | "local_post";

export type ClaimRuleKind =
  | "superlative"
  | "guarantee"
  | "price_figure"
  | "warranty_term"
  | "license_number_claim"
  | "competitor_name"
  | "medical_legal_advice"
  | "generic_claim";

export interface ClaimRule {
  id: string;
  kind: ClaimRuleKind;
  description: string;
  pattern: RegExp;
}

export interface FlaggedClaim {
  ruleId: string;
  ruleKind: ClaimRuleKind;
  description: string;
  span: string;
  start: number;
  end: number;
}

const BASE_RULES: ClaimRule[] = [
  {
    id: "superlative-best-in-city",
    kind: "superlative",
    description: "Unverifiable superlative claim",
    pattern: /\b(best|top|leading|premier)\s+(plumber|hvac|contractor|service|company|team)\s+in\s+[A-Za-z][A-Za-z\s'-]{1,60}\b/gi,
  },
  {
    id: "superlative-number-one",
    kind: "superlative",
    description: "Numeric top-rank claim",
    pattern: /(?:^|[^\w])(#\s?1|number\s+one)(?:[^\w]|$)/gi,
  },
  {
    id: "guaranteed-outcome",
    kind: "guarantee",
    description: "Guaranteed outcome language",
    pattern: /\b(guaranteed|we\s+guarantee|100%\s+satisfaction|always\s+fixed|never\s+fails)\b/gi,
  },
  {
    id: "price-figure",
    kind: "price_figure",
    description: "Specific price figure in generated copy",
    pattern: /\$\s?\d{1,4}(?:[.,]\d{2})?(?:\s?(?:\/|per)\s?(?:hour|hr|service|visit))?/gi,
  },
  {
    id: "warranty-term",
    kind: "warranty_term",
    description: "Warranty term claim",
    pattern: /\b(\d+\s*(?:day|month|year|yr)s?\s+warranty|lifetime\s+warranty|warranty\s+included)\b/gi,
  },
  {
    id: "license-number",
    kind: "license_number_claim",
    description: "License number claim",
    pattern: /\b(license(?:\s*(?:no|number|#))?\s*[:#-]?\s*[A-Za-z0-9-]{4,})\b/gi,
  },
  {
    id: "medical-legal-advice",
    kind: "medical_legal_advice",
    description: "Potential medical/legal advice",
    pattern: /\b(legal\s+advice|you\s+should\s+sue|diagnose|prescribe|medical\s+advice|treatment\s+plan)\b/gi,
  },
];

const STATE_EXTRA_RULES: Record<string, ClaimRule[]> = {
  CA: [
    {
      id: "ca-contractor-ad-claim",
      kind: "generic_claim",
      description: "California-tightened unverifiable contractor ad claim",
      pattern: /\b(fully\s+licensed\s+and\s+insured|state-certified\s+specialists?)\b/gi,
    },
  ],
  TX: [
    {
      id: "tx-emergency-time-guarantee",
      kind: "guarantee",
      description: "Texas-tightened guaranteed response-time claim",
      pattern: /\b(we\s+will\s+arrive\s+in\s+\d+\s*(?:min|minutes)\s+guaranteed)\b/gi,
    },
  ],
  FL: [
    {
      id: "fl-absolute-claim",
      kind: "generic_claim",
      description: "Florida-tightened absolute quality claim",
      pattern: /\b(always\s+the\s+right\s+fix|perfect\s+repair\s+every\s+time)\b/gi,
    },
  ],
};

export function normalizeStateCode(state: string | null | undefined): string {
  return (state ?? "").trim().toUpperCase();
}

export function getClaimsRulesForState(state: string | null | undefined): ClaimRule[] {
  const normalizedState: string = normalizeStateCode(state);
  const extra: ClaimRule[] = STATE_EXTRA_RULES[normalizedState] ?? [];
  return [...BASE_RULES, ...extra];
}

export function detectFlaggedClaims(
  text: string,
  rules: ClaimRule[],
  competitorNames: string[] = [],
): FlaggedClaim[] {
  const normalizedText: string = text ?? "";
  const findings: FlaggedClaim[] = [];

  for (const rule of rules) {
    const clonedPattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of normalizedText.matchAll(clonedPattern)) {
      const span: string = (match[0] ?? "").trim();
      if (!span) continue;
      const start: number = match.index ?? -1;
      if (start < 0) continue;
      const end: number = start + match[0].length;
      findings.push({
        ruleId: rule.id,
        ruleKind: rule.kind,
        description: rule.description,
        span,
        start,
        end,
      });
    }
  }

  for (const competitor of competitorNames) {
    const name: string = competitor.trim();
    if (!name) continue;
    const escaped: string = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const competitorPattern = new RegExp(`\\b${escaped}\\b`, "gi");
    for (const match of normalizedText.matchAll(competitorPattern)) {
      const span: string = (match[0] ?? "").trim();
      if (!span) continue;
      const start: number = match.index ?? -1;
      if (start < 0) continue;
      const end: number = start + match[0].length;
      findings.push({
        ruleId: `competitor-${name.toLowerCase().replace(/\s+/g, "-")}`,
        ruleKind: "competitor_name",
        description: "Competitor mention in marketing copy",
        span,
        start,
        end,
      });
    }
  }

  const dedup = new Map<string, FlaggedClaim>();
  for (const finding of findings) {
    const key = `${finding.ruleId}:${finding.start}:${finding.end}:${finding.span.toLowerCase()}`;
    if (!dedup.has(key)) dedup.set(key, finding);
  }

  return [...dedup.values()].sort((a, b) => a.start - b.start);
}
