import { Pool } from "pg";

export type GbpKeywordSeed = {
  keyword: string;
  locale: string;
};

type ServiceArea = { city?: string; name?: string; locality?: string };

const DEFAULT_LOCALE = "en-US";
const MAX_KEYWORDS = 20;

function normalizeToken(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(" ");
}

function extractCities(serviceAreas: unknown): string[] {
  if (!Array.isArray(serviceAreas)) return [];
  const cities = new Set<string>();
  for (const area of serviceAreas as ServiceArea[]) {
    const raw = area?.city ?? area?.name ?? area?.locality;
    if (typeof raw === "string" && raw.trim()) {
      cities.add(titleCase(normalizeToken(raw)));
    }
  }
  return [...cities];
}

function extractCategories(primary: unknown, additional: unknown): string[] {
  const cats = new Set<string>();
  if (typeof primary === "string" && primary.trim()) {
    cats.add(normalizeToken(primary));
  }
  if (Array.isArray(additional)) {
    for (const val of additional) {
      if (typeof val === "string" && val.trim()) {
        cats.add(normalizeToken(val));
      }
    }
  }
  return [...cats];
}

function categoryToQueryFragments(category: string): string[] {
  const lower = category.toLowerCase();
  const cleaned = lower.replace(/[^\w\s&/-]/g, "").trim();
  const variants = new Set<string>([cleaned]);

  if (cleaned.includes("plumber")) {
    variants.add("plumbing service");
    variants.add("emergency plumber");
  }
  if (cleaned.includes("hvac") || cleaned.includes("air conditioning")) {
    variants.add("hvac repair");
    variants.add("ac repair");
  }
  if (cleaned.includes("water heater")) {
    variants.add("water heater replacement");
    variants.add("water heater repair");
  }

  return [...variants].filter(Boolean);
}

export function buildKeywordSuggestions(
  categories: string[],
  cities: string[],
  locale: string = DEFAULT_LOCALE,
): GbpKeywordSeed[] {
  const out = new Set<string>();
  for (const cat of categories) {
    const fragments = categoryToQueryFragments(cat);
    for (const fragment of fragments) {
      for (const city of cities) {
        out.add(`${fragment} ${city}`.trim());
        if (out.size >= MAX_KEYWORDS) break;
      }
      if (out.size >= MAX_KEYWORDS) break;
    }
    if (out.size >= MAX_KEYWORDS) break;
  }
  return [...out].slice(0, MAX_KEYWORDS).map((keyword) => ({ keyword, locale }));
}

export async function ensureSeededKeywords(
  db: Pool,
  locationId: string,
): Promise<{ inserted: number; keywords: GbpKeywordSeed[] }> {
  const existing = await db.query<{ keyword: string; locale: string | null }>(
    `SELECT keyword, locale FROM gbp_keywords WHERE location_id = $1 ORDER BY created_at ASC LIMIT 20`,
    [locationId],
  );
  if (existing.rows.length > 0) {
    return {
      inserted: 0,
      keywords: existing.rows.map((r) => ({ keyword: r.keyword, locale: r.locale ?? DEFAULT_LOCALE })),
    };
  }

  const location = await db.query<{
    primary_category: string | null;
    additional_categories: unknown;
    service_areas: unknown;
  }>(
    `SELECT primary_category, additional_categories, service_areas FROM gbp_locations WHERE id = $1`,
    [locationId],
  );

  if (location.rowCount === 0) {
    return { inserted: 0, keywords: [] };
  }

  const row = location.rows[0];
  const categories = extractCategories(row.primary_category, row.additional_categories);
  const cities = extractCities(row.service_areas);
  const suggestions = buildKeywordSuggestions(categories, cities);

  let inserted = 0;
  for (const s of suggestions) {
    const res = await db.query(
      `INSERT INTO gbp_keywords (location_id, keyword, locale)
       VALUES ($1, $2, $3)
       ON CONFLICT (location_id, keyword) DO NOTHING`,
      [locationId, s.keyword, s.locale],
    );
    inserted += res.rowCount ?? 0;
  }

  return { inserted, keywords: suggestions };
}
