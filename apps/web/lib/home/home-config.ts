/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Your Google listing is going quiet while you're on the job. We post every week, answer every review in your voice, and\u2026",
  "subhead": "A $99/month AI agent that keeps a one-truck plumber's, electrician's, or HVAC tech's Google Business Profile alive while they're on the job \u2014 publishing a post every week on the same weekday, replying to every new review within two hours\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Your GBP stays active while you're on the job",
      "eyebrow": "AI-Managed Google Business Profile \u2014 $99/mo",
      "subhead": "One AI agent posts weekly updates, answers every review in your voice, and tracks your local rankings \u2014 so your profile works as hard as you do, even when you're under a sink.",
      "primaryCta": {
        "label": "Start Free Trial",
        "href": "/signup"
      },
      "secondaryCta": {
        "label": "See How It Works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "60+ days",
          "label": "Average gap since last post on a service-area GBP"
        },
        {
          "value": "2 hrs",
          "label": "Max time before every new review gets a reply"
        },
        {
          "value": "3.5M",
          "label": "US local-service businesses competing for the same map pack"
        },
        {
          "value": "$99/mo",
          "label": "Flat rate \u2014 every feature, no add-ons, ever"
        }
      ],
      "title": "What a stale GBP costs you"
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Connect your profile",
          "body": "Link your GBP in under two minutes. The agent reads your existing services, past posts, and review history to learn your business before it touches anything."
        },
        {
          "title": "We learn your voice",
          "body": "Answer five quick questions about how you talk to customers. The agent uses that to write posts and review replies that sound like you \u2014 not a bot."
        },
        {
          "title": "The agent goes to work",
          "body": "Every week on the same day, a new photo post or service update goes live. Every review gets a reply within two hours. Anything risky gets flagged for you first \u2014 nothing sensitive is ever auto-posted."
        },
        {
          "title": "Track your rankings weekly",
          "body": "A plain-English digest lands in your inbox each week: where you rank for your service-area keywords, what posted, what reviews came in, and what the agent replied."
        }
      ],
      "title": "Set it up in minutes. Let the agent run it.",
      "subhead": "Connect your Google Business Profile once. The AI handles everything from that moment forward."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Review replies that sound like you \u2014 in two hours or less",
          "body": "The agent answers every routine review in the voice you trained it on, within two hours of it posting. Five-star thank-you or a tricky three-star complaint \u2014 it handles both. Any review it flags as risky is held in your queue and never published without your approval. You stay in control without watching your phone all day."
        },
        {
          "title": "One post every week, same day, your timezone",
          "body": "Google rewards consistent activity. The agent publishes a photo update or service highlight every week on the exact weekday you choose, timed to your local timezone. Miss a week for any reason and you get a free week credited automatically \u2014 no questions asked."
        },
        {
          "title": "Service-area keyword rankings, tracked and reported",
          "body": "The agent monitors where your profile ranks for the specific keywords your customers actually search \u2014 'emergency plumber [city],' 'AC repair near me,' and the rest. Your weekly digest shows movement up or down so you always know if the work is paying off."
        }
      ],
      "title": "Built for the owner who's already on the truck"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "Weekly GBP posts",
          "body": "Photo or service update published on a fixed weekday in your timezone, every single week, automatically."
        },
        {
          "title": "Voice-matched review replies",
          "body": "Routine reviews answered in your trained voice within two hours. Risky reviews held for human review \u2014 never auto-posted."
        },
        {
          "title": "Service-area keyword tracking",
          "body": "Rankings monitored for the search terms that drive calls in your metro, reported weekly."
        },
        {
          "title": "Weekly digest email",
          "body": "Plain-English summary of posts published, reviews answered, and ranking changes \u2014 readable in under 60 seconds."
        },
        {
          "title": "Missed-week service credits",
          "body": "If the agent ever misses a scheduled post, you get a free week credited to your account. Automatically, no support ticket needed."
        },
        {
          "title": "Flat, predictable pricing",
          "body": "One price per location. Annual prepay available. Referral and partner credits applied to your account \u2014 list pricing never changes."
        }
      ],
      "title": "Everything included. No add-ons. No surprises.",
      "subhead": "Every feature ships with the $99/mo plan. There is no higher tier that unlocks more \u2014 this is the whole product."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "I used to go months without posting anything on my profile. Now something goes up every Tuesday and I don't think about it once. My map pack ranking moved up two spots in the first month.",
          "author": "Owner-operator",
          "role": "Residential plumber, 2-truck shop, Dallas metro"
        },
        {
          "quote": "I tried Localo for a while but I was still doing most of the work myself. This actually just runs. Every review gets a reply that sounds like me \u2014 my wife thought I was answering them myself.",
          "author": "Owner-operator",
          "role": "Licensed electrician, solo truck, Phoenix"
        },
        {
          "quote": "Ninety-nine dollars a month is nothing compared to one extra booked job. The weekly email tells me exactly where I stand and I can read it at a red light.",
          "author": "Owner-operator",
          "role": "HVAC tech, 3-truck shop, Charlotte"
        }
      ],
      "title": "What owner-operators say after the first 90 days"
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Will the review replies actually sound like me, or obviously like AI?",
          "a": "The agent is trained on your answers to five short questions about your tone, your common customer situations, and phrases you'd never say. Most customers can't tell the difference \u2014 and if a reply ever doesn't feel right, you can edit it before it posts."
        },
        {
          "q": "What happens if a review is negative or could make things worse?",
          "a": "Any review the agent flags as sensitive \u2014 disputes, refund demands, accusations \u2014 is held in your queue and never published without your explicit approval. You get a notification and decide what to do. The two-hour SLA applies only to replies the agent is confident about."
        },
        {
          "q": "I already tried Localo or SE Ranking. How is this different?",
          "a": "Those tools give you dashboards and suggestions \u2014 you still do the work. This agent does the work: it writes and posts, it replies to reviews, it tracks rankings. You just read the weekly digest. If you're already paying for a DIY tool and still not posting consistently, that's exactly the gap this fills."
        },
        {
          "q": "Can I cancel anytime, and what happens to my GBP if I do?",
          "a": "Yes, cancel anytime from your account \u2014 no calls, no retention flows. Your GBP stays exactly as it is; we don't delete anything we posted. Annual subscribers get a prorated refund for unused months."
        },
        {
          "q": "I have more than one location. How does pricing work?",
          "a": "Each connected location is one flat $99/mo subscription. There are no add-ons and no bundle discounts that change the per-location price \u2014 every location gets the full feature set. Referral credits apply per account and reduce your next billing cycle."
        }
      ],
      "title": "Straight answers to real questions"
    },
    {
      "type": "cta_band",
      "headline": "Your profile is decaying right now. Let's fix that today.",
      "subhead": "Connect your GBP in two minutes. The agent posts its first update this week. $99/mo, cancel anytime."
    }
  ]
};
