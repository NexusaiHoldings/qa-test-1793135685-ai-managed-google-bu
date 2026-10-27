export type GeneratedSample = {
  reviewComment: string;
  currentReply: string;
  approved: boolean;
};

type BuildVoiceSamplesInput = {
  userId: string;
  locationId: string;
  reviews: string[];
};

function draftReplyFromReview(review: string): string {
  const trimmed = review.trim();
  if (trimmed.length === 0) {
    return "Thank you for your feedback—we appreciate you choosing us.";
  }

  const lower = trimmed.toLowerCase();
  const mentionsFast = lower.includes("fast") || lower.includes("quick");
  const mentionsClean = lower.includes("clean");
  const mentionsTeam = lower.includes("team") || lower.includes("staff");

  const parts: string[] = ["Thank you for the kind words"];
  if (mentionsTeam) parts.push("about our team");
  parts[0] = `${parts[0]}${parts.length > 1 ? ` ${parts[1]}` : ""}.`;

  if (mentionsFast) {
    parts.push("We know how important quick turnaround is and we’re glad we delivered.");
  }
  if (mentionsClean) {
    parts.push("Keeping the work area clean and respectful is a core part of how we operate.");
  }

  parts.push("We appreciate your trust and look forward to helping again whenever you need us.");
  return parts.join(" ");
}

export async function buildVoiceSamples(input: BuildVoiceSamplesInput): Promise<GeneratedSample[]> {
  const selected = input.reviews.slice(0, 3);
  while (selected.length < 3) {
    selected.push("Great service and friendly team.");
  }

  return selected.map((review) => ({
    reviewComment: review,
    currentReply: draftReplyFromReview(review),
    approved: false,
  }));
}
