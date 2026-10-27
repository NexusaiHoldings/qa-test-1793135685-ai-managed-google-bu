export type GbpContentKind = "review_reply" | "post";

export interface ClaimsRuleMatch {
  code:
    | "superlative"
    | "number_one"
    | "guarantee"
    | "price_claim"
    | "warranty_claim"
    | "license_number_claim"
    | "competitor_name"
    | "medical_advice"
    | "legal_advice";
  label: string;
  severity: "low" | "medium" | "high";
  span: string;
  start: number;
  end: number;
  state: string;
}

export interface ClaimsRuleInput {
  text: string;
  state: string | null | undefined;
  contentKind: GbpContentKind;
  competitorNames?: string[];
}

interface RuleDefinition {
  code: ClaimsRuleMatch["code"];
  label: string;
  severity: ClaimsRuleMatch["severity"];
  pattern: RegExp;
  stateAllowlist?: string[];
  stateBlocklist?: string[];
}

const BASE_RULES: RuleDefinition[] = [
  {
    code: "superlative",
    label: "Superlative claim",
    severity: "medium",
    pattern: /\b(best|top[-\s]?rated|leading|premier|unmatched)\b/gi,
  },
  {
    code: "number_one",
    label: "Ranking claim (#1)",
    severity: "high",
    pattern: /\b(#\s?1|number\s+one|no\.\s?1)\b/gi,
  },
  {
    code: "guarantee",
    label: "Guarantee claim",
    severity: "high",
    pattern: /\b(guaranteed?|100%\s*(satisfaction|guarantee)|we\s+promise)\b/gi,
  },
  {
    code: "price_claim",
    label: "Price/discount claim",
    severity: "medium",
    pattern: /(\$\s?\d[\d,]*(\.\d{1,2})?|\b\d{1,3}%\s*(off|discount)\b)/gi,
  },
  {
    code: "warranty_claim",
    label: "Warranty term claim",
    severity: "medium",
    pattern: /\b(\d+\s*(day|month|year)s?\s*warranty|lifetime\s+warranty|warranty)\b/gi,
  },
  {
    code: "license_number_claim",
    label: "License number claim",
    severity: "high",
    pattern: /\b(licen[cs]e?\s*(#|number|no\.)\s*[a-z0-9-]+|licensed\s+and\s+insured)\b/gi,
  },
  {
    code: "medical_advice",
    label: "Medical advice language",
    severity: "high",
    pattern:
      /\b(diagnose|diagnosis|treat|treatment|cure|prescribe|medical advice|you should take)\b/gi,
  },
  {
    code: "legal_advice",
    label: "Legal advice language",
    severity: "high",
    pattern:
      /\b(legal advice|you should sue|we guarantee you will win|attorney[-\s]?client)\b/gi,
  },
];

const STATE_RULE_OVERRIDES: Record<
  string,
  Partial<Record<ClaimsRuleMatch["code"], Pick<RuleDefinition, "severity">>>
> = {
  CA: {
    superlative: { severity: "high" },
    guarantee: { severity: "high" },
  },
  TX: {
    license_number_claim: { severity: "high" },
  },
  FL: {
    price_claim: { severity: "high" },
  },
};

function normalizeState(state: string | null | undefined): string {
  if (!state) return "US";
  return state.trim().toUpperCase();
}

function pushMatchesForPattern(
  text: string,
  state: string,
  definition: RuleDefinition,
  out: ClaimsRuleMatch[],
): void {
  const regex = new RegExp(definition.pattern.source, definition.pattern.flags);
  let match: RegExpExecArray | null = regex.exec(text);

  while (match) {
    const span = match[0];
    const start = match.index;
    const end = start + span.length;
    out.push({
      code: definition.code,
      label: definition.label,
      severity: definition.severity,
      span,
      start,
      end,
      state,
    });
    match = regex.exec(text);
  }
}

function buildCompetitorRule(competitorName: string): RuleDefinition | null {
  const trimmed = competitorName.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    code: "competitor_name",
    label: "Competitor mention",
    severity: "medium",
    pattern: new RegExp(`\\b${escaped}\\b`, "gi"),
  };
}

export function runClaimsRules(input: ClaimsRuleInput): ClaimsRuleMatch[] {
  const state = normalizeState(input.state);
  const text = input.text ?? "";
  const matches: ClaimsRuleMatch[] = [];

  for (const baseRule of BASE_RULES) {
    const stateOverride = STATE_RULE_OVERRIDES[state]?.[baseRule.code];
    const mergedRule: RuleDefinition = {
      ...baseRule,
      severity: stateOverride?.severity ?? baseRule.severity,
    };

    if (mergedRule.stateAllowlist && !mergedRule.stateAllowlist.includes(state)) continue;
    if (mergedRule.stateBlocklist && mergedRule.stateBlocklist.includes(state)) continue;

    pushMatchesForPattern(text, state, mergedRule, matches);
  }

  if (input.competitorNames && input.competitorNames.length > 0) {
    for (const competitor of input.competitorNames) {
      const competitorRule = buildCompetitorRule(competitor);
      if (!competitorRule) continue;
      pushMatchesForPattern(text, state, competitorRule, matches);
    }
  }

  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  return matches;
}
