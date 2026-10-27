/**
 * GET /api/cron/gbp-review-poll — Feature F1-002.
 *
 * Vercel Cron handler (target schedule: every 30 minutes) that keeps
 * gbp_reviews current for every linked location, so AI replies can land inside
 * the 2-hour window from ceo_briefing.ai_automation_core. Failures on one
 * location never abort the rest (pollAllLocations isolates them).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (local/dev) → unguarded (the job is read-mostly).
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { pollAllLocations } from "@/lib/gbp/review-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  try {
    const summary = await pollAllLocations(buildDb());
    console.log(
      JSON.stringify({
        at: "gbp.cron.review-poll",
        locationsProcessed: summary.locationsProcessed,
        reviewsUpserted: summary.reviewsUpserted,
        errors: summary.errors,
      }),
    );
    return NextResponse.json({
      ok: true,
      locationsProcessed: summary.locationsProcessed,
      reviewsUpserted: summary.reviewsUpserted,
      errors: summary.errors,
    });
  } catch (e) {
    console.error(
      JSON.stringify({ at: "gbp.cron.review-poll", error: (e as Error).message }),
    );
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
