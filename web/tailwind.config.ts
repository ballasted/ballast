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
        bg: "#0A0C0B", // Ground
        card: "#101412", // Surface
        "surface-raised": "#161B18", // elevated cards, the preview panel
        "surface-hover": "#1A211C", // card hover lift
        border: "#1C211E",
        "border-strong": "#2E352F",
        green: {
          DEFAULT: "#00C805", // Accent (patina)
          bg: "#0E2A12", // Accent deep
          mid: "#2E6B33", // Accent mid — second data/step tone
        },
        // Bone / marble — from the brand assets. The primary tone for headings and
        // brand moments, so the interface reads composed rather than monochrome.
        bone: {
          DEFAULT: "#DDD8CA",
          muted: "#8A938D",
        },
        text: {
          primary: "#F2F4F2",
          secondary: "#C7CDBE",
          muted: "#8A938D",
          faint: "#5F665F",
        },
        positive: "#00C805",
        negative: "#FF5A52",
        warning: {
          DEFAULT: "#EF9F27",
          bg: "#1A1509",
          border: "#3D3114",
        },
        // Chart + treasury-composition series. Kept as an explicit ramp so a
        // visualization has more than one usable colour without inventing hues.
        data: {
          1: "#00C805",
          2: "#2E6B33",
          3: "#DDD8CA",
          4: "#6E8B77",
          5: "#C9A96A",
        },
      },
      borderRadius: {
        card: "13px",
        input: "11px",
        button: "14px",
        phone: "30px",
      },
      // `border-accent` — the quiet green-tinted border that marks a card as
      // carrying backing data, so the panel that matters is visually distinct
      // without a badge (visual-upgrade Phase 2, "Border accent #16301A").
      borderColor: {
        accent: "#16301A",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // The second register from the brand's two-register system. Headings and
        // brand moments only; body / numbers / controls stay sans for legibility.
        // A classical humanist serif stack (no web-font download → marketing stays
        // zero-bundle and the build is offline-safe); swap in the brand serif via
        // next/font when its file is chosen.
        serif: [
          "Iowan Old Style",
          "Palatino Linotype",
          "Palatino",
          "Georgia",
          "Cambria",
          "serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      maxWidth: {
        content: "1080px",
        prose: "720px",
      },
    },
  },
  plugins: [],
};

export default config;
