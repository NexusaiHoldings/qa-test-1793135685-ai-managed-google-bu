import { z } from "zod";

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

const rankResultSchema = z.object({
  keyword: z.string().min(1),
  found: z.boolean(),
  rank: z.number().int().positive().nullable(),
  providerStatus: z.enum(["ok", "delayed"]),
});

const batchSchema = z.array(rankResultSchema);

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
    return batchSchema.parse(
      queries.map((q) => ({
        keyword: q.keyword,
        found: false,
        rank: null,
        providerStatus: "delayed",
      })),
    );
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
      return batchSchema.parse(
        queries.map((q) => ({
          keyword: q.keyword,
          found: false,
          rank: null,
          providerStatus: "delayed",
        })),
      );
    }

    const json = (await response.json()) as DataForSeoResponse;
    const rawResults = json.tasks?.flatMap((t) => t.result ?? []) ?? [];

    const byKeyword = new Map<string, DataForSeoTaskResult>();
    for (const item of rawResults) {
      if (item.keyword) byKeyword.set(item.keyword.toLowerCase(), item);
    }

    return batchSchema.parse(
      queries.map((q) => {
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
      }),
    );
  } catch {
    return batchSchema.parse(
      queries.map((q) => ({
        keyword: q.keyword,
        found: false,
        rank: null,
        providerStatus: "delayed",
      })),
    );
  }
}
