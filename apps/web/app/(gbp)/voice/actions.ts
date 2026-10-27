"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "@nexus/identity-and-access";
import {
  approveVoiceProfile,
  getVoiceOnboardingState,
  saveTonePickerProfile,
  saveVoiceSampleFeedback,
} from "@/lib/gbp/voice-profile";

function getString(formData: FormData, key: string): string {
  const value: FormDataEntryValue | null = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function submitTonePickerAction(formData: FormData): Promise<void> {
  const session = await getServerSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/api/auth/signin");
  }

  const locationId = getString(formData, "locationId");
  const greetingStyle = getString(formData, "greetingStyle");
  const formality = getString(formData, "formality");
  const signOffStyle = getString(formData, "signOffStyle");
  const neverSay = getString(formData, "neverSay");

  if (!locationId || !greetingStyle || !formality || !signOffStyle) {
    throw new Error("Missing required tone picker fields.");
  }

  await saveTonePickerProfile({
    userId,
    locationId,
    greetingStyle,
    formality,
    signOffStyle,
    neverSay,
  });

  revalidatePath("/voice");
}

export async function saveSampleFeedbackAction(formData: FormData): Promise<void> {
  const session = await getServerSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/api/auth/signin");
  }

  const locationId = getString(formData, "locationId");
  const sampleIndex = Number(getString(formData, "sampleIndex"));
  const approved = getString(formData, "approved") === "true";
  const editedReply = getString(formData, "editedReply");

  if (!locationId || Number.isNaN(sampleIndex) || sampleIndex < 0) {
    throw new Error("Invalid sample feedback payload.");
  }

  await saveVoiceSampleFeedback({
    userId,
    locationId,
    sampleIndex,
    approved,
    editedReply,
  });

  revalidatePath("/voice");
}

export async function finalizeVoiceApprovalAction(formData: FormData): Promise<void> {
  const session = await getServerSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/api/auth/signin");
  }

  const locationId = getString(formData, "locationId");
  if (!locationId) {
    throw new Error("Missing location for approval.");
  }

  const state = await getVoiceOnboardingState(userId, locationId);
  if (!state) {
    throw new Error("Unable to load voice state.");
  }

  if (!state.readyToApprove) {
    throw new Error("Please complete all 3 samples before approval.");
  }

  await approveVoiceProfile({
    userId,
    locationId,
  });

  revalidatePath("/voice");
}
