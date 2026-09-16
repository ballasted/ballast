import type { Config } from "tailwindcss";

// Design system — spec §10. Robinhood Wallet's design *language*, not a clone.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,md,mdx}",
    "./components/**/*.{ts,tsx}",
    "./content/**/*.{md,mdx}",
    "./mdx-components.tsx",
  ],
  theme: {
    extend: {
      colors: {
        // Palette renamed per the Sept 2026 UI spec (ground/panel/patina/bone/
        // ember/amber). Tailwind KEY NAMES are kept stable (bg, card, green.*,
        // text.*, etc.) so no component needed a rename pass — only the
        // underlying hex/rgba values moved.
        bg: "#050A06", // Ground
        card: "#0E1410", // Panel
        "surface-raised": "#131B16", // Panel-2 — elevated cards, the preview panel
        "surface-hover": "#18211A", // Panel-2 hover — card hover lift
        border: "rgba(34,201,58,0.16)", // Line — hairline, patina-tinted
        "border-strong": "rgba(34,201,58,0.32)",
        green: {
          DEFAULT: "#22C93A", // Patina — primary accent, positive
          hover: "#3ADB52", // Patina hover — a touch brighter so a press reads as
          // feedback, not a fade; dark button text stays readable against it.
          bg: "#0F2A14", // Patina deep
          mid: "#1B8A2B", // Patina-dim — muted accent, labels; also data/step tone
        },
        // Bone — from the brand assets. The primary tone for headings and brand
        // moments, so the interface reads composed rather than monochrome.
        bone: {
          DEFAULT: "#F5F3EC",
          muted: "rgba(245,243,236,0.35)", // bone-35
        },
        text: {
          primary: "#F5F3EC", // Bone
          secondary: "rgba(245,243,236,0.62)", // bone-60
          muted: "rgba(245,243,236,0.35)", // bone-35
          faint: "rgba(245,243,236,0.18)", // bone-20 — below bone-35, no spec tier
        },
        positive: "#22C93A", // Patina
        negative: "#E2564D", // Ember
        warning: {
          DEFAULT: "#E8A33D", // Amber
          bg: "#1C1509",
          border: "#3D3016",
        },
        // Chart + treasury-composition series. Kept as an explicit ramp so a
        // visualization has more than one usable colour without inventing hues.
        data: {
          1: "#22C93A",
          2: "#1B8A2B",
          3: "#F5F3EC",
          4: "#6E8B77",
          5: "#C9A96A",
        },
      },
      borderRadius: {
        card: "16px",
        input: "12px",
        button: "12px",
        pill: "999px",
        phone: "30px",
      },
      // `border-accent` — the quiet patina-tinted border that marks a card as
      // carrying backing data, so the panel that matters is visually distinct
      // without a badge (visual-upgrade Phase 2, "Border accent").
      borderColor: {
        accent: "#153F1D",
      },
      fontFamily: {
        // UI sans — Inter, self-hosted via next/font (app/layout.tsx sets
        // --font-sans). System stack is the fallback while the font loads.
        sans: [
          "var(--font-sans)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Display serif — Playfair Display (Didone), the second register from
        // the brand's two-register system. Headings and brand moments only;
        // body / numbers / controls stay sans for legibility.
        serif: [
          "var(--font-display)",
          "Iowan Old Style",
          "Palatino Linotype",
          "Palatino",
          "Georgia",
          "Cambria",
          "serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // Named steps for the display serif and UI sans scales so later
      // milestones use e.g. text-display-lg instead of one-off px values.
      fontSize: {
        "display-sm": ["40px", { lineHeight: "1.08", letterSpacing: "-0.01em" }],
        "display-md": ["56px", { lineHeight: "1.05", letterSpacing: "-0.01em" }],
        "display-lg": ["76px", { lineHeight: "1.02", letterSpacing: "-0.01em" }],
        "display-xl": ["104px", { lineHeight: "1", letterSpacing: "-0.01em" }],
        "ui-xs": ["12px", { lineHeight: "1.4" }],
        "ui-sm": ["13px", { lineHeight: "1.4" }],
        "ui-base": ["14px", { lineHeight: "1.5" }],
        "ui-md": ["16px", { lineHeight: "1.5" }],
        "ui-lg": ["20px", { lineHeight: "1.4" }],
        "ui-xl": ["24px", { lineHeight: "1.3" }],
      },
      maxWidth: {
        content: "1200px", // density §1 — anchor content instead of sprawling edge-to-edge
        prose: "720px",
      },
    },
  },
  plugins: [],
};

export default config;
