/**
 * Navigation configuration consumed by the substrate's <TopNav /> to render
 * the sticky nav strip.
 *
 * Shape contract (do not change): NavLink, NavGroup, NavConfig, NAV_CONFIG.
 * Links flagged `adminOnly` are stripped from the public nav by <TopNav />
 * and only render for admin sessions.
 */

export type NavLink = {
  /** Absolute path the link points at (e.g. "/reviews"). */
  href: string;
  /** Human-readable label rendered in the nav strip. */
  label: string;
  /** When true, the link only renders for admin sessions. */
  adminOnly?: boolean;
};

export type NavGroup = {
  /** Dropdown / section label for the grouped links. */
  label: string;
  /** Links rendered inside the group. */
  links: NavLink[];
  /** When true, the entire group only renders for admin sessions. */
  adminOnly?: boolean;
};

export type NavConfig = {
  /** Top-level links rendered directly in the sticky nav strip. */
  primary: NavLink[];
  /** Grouped links rendered as dropdown sections in the nav strip. */
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/reviews", label: "Reviews" },
    { href: "/approvals", label: "Approvals" },
    { href: "/posts", label: "Posts" },
    { href: "/rankings", label: "Rankings" },
    { href: "/reports", label: "Reports" },
  ],
  groups: [
    {
      label: "Setup",
      links: [
        { href: "/connect", label: "Connect" },
        { href: "/voice", label: "Voice" },
        { href: "/posts/photos", label: "Photos" },
      ],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        { href: "/admin/escalations", label: "Escalations", adminOnly: true },
        { href: "/admin/health", label: "Platform Health", adminOnly: true },
      ],
    },
  ],
};
