const STOP_WORDS = new Set(["and", "&", "the", "in", "of", "for", "service", "services"]);

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(" ")
    .trim();
}

export function suggestKeywords(
  primaryCategory: string | null,
  additionalCategories: string[],
  serviceAreas: string[],
): string[] {
  const categories = [primaryCategory ?? "", ...additionalCategories]
    .map((c) => c.trim())
    .filter(Boolean);

  const cities = serviceAreas.map((c) => c.trim()).filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    for (const city of cities) {
      const phrase = `${category} ${city}`.replace(/\s+/g, " ").trim();
      const key = normalize(phrase);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(phrase);
      if (out.length >= 20) return out;
    }
  }

  return out.slice(0, 20);
}
