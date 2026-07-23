"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

// FAQ with a genuine height transition (grid-template-rows 0fr -> 1fr, content
// kept in the DOM so it can animate). No web3. Under prefers-reduced-motion the
// global CSS collapses the transition to instant. The "+" rotates, never bounces.
export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="mt-8 divide-y divide-border rounded-card border border-border">
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="px-6">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : i)}
              className="flex w-full items-center justify-between gap-4 py-4 text-left font-medium text-text-primary"
            >
              {item.q}
              <span
                aria-hidden
                className={cn("text-text-muted transition-transform duration-200", isOpen && "rotate-45")}
              >
                +
              </span>
            </button>
            <div
              className="grid transition-[grid-template-rows] duration-200 ease-out"
              style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
            >
              <div className="overflow-hidden">
                <p className="pb-4 text-sm text-text-secondary">{item.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
