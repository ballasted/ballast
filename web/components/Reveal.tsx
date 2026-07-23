"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

// Section reveal via IntersectionObserver — fires ONCE, then disconnects. Pure
// DOM + React, no web3, negligible bundle cost. Under prefers-reduced-motion the
// CSS forces the settled state, so this is a no-op there. `as` lets a section keep
// its semantic tag.
export function Reveal({
  children,
  className,
  as: Tag = "div",
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  as?: keyof React.JSX.IntrinsicElements;
  delayMs?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const Component = Tag as React.ElementType;
  return (
    <Component
      ref={ref}
      className={cn("reveal", visible && "is-visible", className)}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Component>
  );
}
