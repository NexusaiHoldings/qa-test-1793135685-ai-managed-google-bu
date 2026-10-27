import { Pool } from "pg";

export type VoiceSample = {
  reviewId: string;
  reviewText: string;
  draftedReply: string;
  reviewerName: string | null;
  starRating: number | null;
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function draftReply(reviewText: string, reviewerName: string | null): string {
  const opener = reviewerName ? `Thanks ${reviewerName},` : "Thanks so much,";
  const summary = reviewText.length > 180 ? `${reviewText.slice(0, 177)}...` : reviewText;
  return `${opener} we really appreciate you taking the time to share this. ${summary ? "Glad our team could help." : "Your feedback means a lot to us."} If you ever need us again, we’re here for you.`;
}

export async function getVoiceSamples(locationId: string): Promise<VoiceSample[]> {
  const query = `
    SELECT
      id AS review_id,
      COALESCE(NULLIF(TRIM(comment), ''), '') AS review_text,
      reviewer_name,
      star_rating
    FROM gbp_reviews
    WHERE location_id = $1
      AND COALESCE(NULLIF(TRIM(comment), ''), '') <> ''
    ORDER BY review_created_at DESC NULLS LAST
    LIMIT 3
  `;
  const result = await pool.query<{
    review_id: string;
    review_text: string;
    reviewer_name: string | null;
    star_rating: number | null;
  }>(query, [locationId]);

  return result.rows.map((row) => ({
    reviewId: row.review_id,
    reviewText: row.review_text,
    draftedReply: draftReply(row.review_text, row.reviewer_name),
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
  }));
}
