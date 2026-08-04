"use client";

import { motion, useReducedMotion } from "framer-motion";

// Route transition for the /app segment (v2). A template re-mounts on every
// navigation (unlike a layout), so each new page settles in — a short fade + 6px
// rise, opacity/transform only, ~200ms ease-out — the "settle into place" tone, not
// a performance. prefers-reduced-motion renders an instant swap (no motion).
// Marketing keeps its own scroll reveals and stays free of this client boundary.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <div>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
