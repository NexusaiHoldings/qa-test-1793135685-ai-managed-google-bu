/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#15213a",
    "accent": "#1f4fd8",
    "border": "#d8dee8",
    "danger": "#b42318",
    "success": "#1a7f4b",
    "surface": "#f5f7fa",
    "textMuted": "#4f5b73",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeef4",
    "borderStrong": "#b9c3d3"
  },
  "shape": {
    "radius": 6
  }
};
