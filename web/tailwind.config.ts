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
        bg: "#0A0C0B",
        card: "#101412",
        border: "#1C211E",
        green: {
          DEFAULT: "#00C805",
          bg: "#0E2A12",
        },
        text: {
          primary: "#F2F4F2",
          secondary: "#C7CDBE",
          muted: "#8A938D",
          faint: "#5F665F",
        },
        negative: "#FF5A52",
        warning: {
          DEFAULT: "#EF9F27",
          bg: "#1A1509",
          border: "#3D3114",
        },
      },
      borderRadius: {
        card: "13px",
        input: "11px",
        button: "14px",
        phone: "30px",
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
