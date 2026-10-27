/**
 * DataForSEO local-pack rank provider — Feature F1-008.
 *
 * Wraps the DataForSEO Google Maps (local-pack) SERP endpoint behind a small
 * provider interface so the rest of the app depends on {@link RankResult}, not
 * on DataForSEO's payload shape (feasibility key_technical_risks[2] — we pay a
 * stable API rather than scrape). Any provider failure (missing credentials,
 * non-2xx, network error) degrades to `providerStatus: "delayed"` with a null
 * rank so the /rankings page can show the last good snapshot with a "rankings
 * delayed" badge rather than blank cells.
 */

export type RankProviderStatus = "ok" | "delayed";

export interface RankQuery {
  keyword: string;
  city: string;
  latitude?: number;
  longitude?: number;
}

export interface RankResult {
  keyword: string;
  found: boolean;
  rank: number | null;
  providerStatus: RankProviderStatus;
}

/** Build a uniform "delayed" batch for a provider outage / missing config. */
function delayedBatch(queries: RankQuery[]): RankResult[] {
  return queries.map((q) => ({
    keyword: q.keyword,
    found: false,
    rank: null,
    providerStatus: "delayed" as const,
  }));
}

interface DataForSeoTaskResult {
  keyword: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  items?: Array<{ rank_group?: number | null; rank_absolute?: number | null }>;
}

interface DataForSeoResponse {
  tasks?: Array<{
    status_code?: number;
    result?: DataForSeoTaskResult[];
  }>;
}

function pickRank(result: DataForSeoTaskResult): number | null {
  if (typeof result.rank_group === "number" && result.rank_group > 0) return result.rank_group;
  if (typeof result.rank_absolute === "number" && result.rank_absolute > 0) return result.rank_absolute;
  if (Array.isArray(result.items) && result.items.length > 0) {
    for (const item of result.items) {
      if (typeof item.rank_group === "number" && item.rank_group > 0) return item.rank_group;
      if (typeof item.rank_absolute === "number" && item.rank_absolute > 0) return item.rank_absolute;
    }
  }
  return null;
}

export async function fetchLocalPackRanks(queries: RankQuery[]): Promise<RankResult[]> {
  if (queries.length === 0) return [];

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    return delayedBatch(queries);
  }

  try {
    const auth = Buffer.from(`${login}:${password}`).toString("base64");
    const payload = queries.map((q) => ({
      keyword: q.keyword,
      language_code: "en",
      location_name: q.city,
      latitude: q.latitude,
      longitude: q.longitude,
      device: "desktop",
      os: "windows",
      depth: 20,
    }));

    const response = await fetch("https://api.dataforseo.com/v3/serp/google/maps/live/advanced", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!response.ok) {
      return delayedBatch(queries);
    }

    const json = (await response.json()) as DataForSeoResponse;
    const rawResults = json.tasks?.flatMap((t) => t.result ?? []) ?? [];

    const byKeyword = new Map<string, DataForSeoTaskResult>();
    for (const item of rawResults) {
      if (item.keyword) byKeyword.set(item.keyword.toLowerCase(), item);
    }

    return queries.map((q) => {
      const hit = byKeyword.get(q.keyword.toLowerCase());
      if (!hit) {
        return { keyword: q.keyword, found: false, rank: null, providerStatus: "ok" as const };
      }
      const rank = pickRank(hit);
      return {
        keyword: q.keyword,
        found: rank !== null,
        rank,
        providerStatus: "ok" as const,
      };
    });
  } catch {
    return delayedBatch(queries);
  }
}
