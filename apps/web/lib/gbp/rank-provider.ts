import { z } from "zod";

export type RankCheckInput = {
  keyword: string;
  city: string;
  latitude: number;
  longitude: number;
};

export type RankCheckResult = {
  found: boolean;
  rank: number | null;
  provider: "dataforseo";
  rawErrorCode?: string;
};

export interface RankProvider {
  checkLocalPackRank(input: RankCheckInput): Promise<RankCheckResult>;
}

const DataForSeoResponseSchema = z.object({
  tasks: z.array(
    z.object({
      status_code: z.number(),
      result: z.array(
        z.object({
          items: z.array(
            z.object({
              rank_group: z.number().optional(),
              title: z.string().optional(),
            }),
          ).optional(),
        }),
      ).optional(),
    }),
  ),
});

export class DataForSeoRankProvider implements RankProvider {
  public async checkLocalPackRank(input: RankCheckInput): Promise<RankCheckResult> {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    const businessName = process.env.GBP_BUSINESS_NAME_MATCH;

    if (!login || !password || !businessName) {
      return { found: false, rank: null, provider: "dataforseo", rawErrorCode: "missing_config" };
    }

    const auth = Buffer.from(`${login}:${password}`).toString("base64");
    const endpoint = "https://api.dataforseo.com/v3/serp/google/maps/live/advanced";
    const payload = [
      {
        keyword: input.keyword,
        language_code: "en",
        location_name: input.city,
        location_coordinate: `${input.latitude},${input.longitude},13z`,
      },
    ];

    const startedAt = Date.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        found: false,
        rank: null,
        provider: "dataforseo",
        rawErrorCode: `http_${res.status}`,
      };
    }

    const json = await res.json();
    const parsed = DataForSeoResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { found: false, rank: null, provider: "dataforseo", rawErrorCode: "parse_error" };
    }

    const task = parsed.data.tasks[0];
    const items = task?.result?.[0]?.items ?? [];
    const name = businessName.toLowerCase();
    for (const item of items) {
      const title = (item.title ?? "").toLowerCase();
      if (title && title.includes(name)) {
        return {
          found: true,
          rank: item.rank_group ?? null,
          provider: "dataforseo",
        };
      }
    }

    const elapsed = Date.now() - startedAt;
    void elapsed;
    return { found: false, rank: null, provider: "dataforseo" };
  }
}
