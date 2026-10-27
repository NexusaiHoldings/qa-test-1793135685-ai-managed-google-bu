"use server";

/**
 * Connect-flow server actions — Feature F1-002.
 *
 * Called only by the /connect page (not an external client), so these are
 * Server Actions rather than route handlers. Each action re-validates the
 * session, performs the link/backfill against the owner's own locations, and
 * revalidates the page so the new location card renders.
 */

import { revalidatePath } from "next/cache";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { linkLocation } from "@/lib/gbp/locations";
import { GbpAccessError } from "@/lib/gbp/google-client";

interface ActionState {
  ok: boolean;
  message: string;
}

/**
 * Link a location the owner tapped on /connect. Expects googleAccountId +
 * googleLocationId in the submitted form. Used directly as a `<form action>`
 * target; the page revalidates to render the new location card.
 */
export async function linkLocationAction(
  formData: FormData,
): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, message: "Please sign in to connect a location." };
  }

  const googleAccountId = String(formData.get("googleAccountId") ?? "").trim();
  const googleLocationId = String(formData.get("googleLocationId") ?? "").trim();
  if (!googleAccountId || !googleLocationId) {
    return { ok: false, message: "Missing location reference — please retry." };
  }

  try {
    const result = await linkLocation(
      buildDb(),
      user.id,
      googleAccountId,
      googleLocationId,
    );
    revalidatePath("/connect");
    return {
      ok: true,
      message: `Connected ${result.title}. Backfilled ${result.reviewsSynced} reviews and ${result.mediaSynced} photos.`,
    };
  } catch (e) {
    if (e instanceof GbpAccessError) {
      return { ok: false, message: e.message };
    }
    console.error(
      JSON.stringify({ at: "gbp.actions.linkLocationAction", userId: user.id, error: (e as Error).message }),
    );
    return {
      ok: false,
      message: "Something went wrong connecting that location — please try again.",
    };
  }
}

/**
 * Thin void-returning wrapper so the action can be used directly as a
 * `<form action>` target (whose prop type expects `void | Promise<void>`).
 */
export async function linkLocationFormAction(formData: FormData): Promise<void> {
  await linkLocationAction(formData);
}

/** Refresh the managed-location list (used by the "Connect another" action). */
export async function refreshLocationsAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  revalidatePath("/connect");
}
