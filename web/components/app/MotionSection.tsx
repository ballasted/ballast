"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

// v2 section reveal — a section settles in (opacity + 8px rise) the first time it
// scrolls into view, then never moves again. Transform/opacity only, 220ms ease-out,
// matching the design system's motion rules. prefers-reduced-motion → rendered
// static, no animation. Above-the-fold sections animate on mount.
export function MotionSection({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </motion.div>
  );
}
