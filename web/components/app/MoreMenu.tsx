"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, moreNavItems } from "@/components/app/nav-items";
import { COMMUNITY_LINKS } from "@/lib/links";
import { cn } from "@/lib/cn";

// A single bottom sheet shared by BOTH mobile nav triggers — the "More" tab in
// BottomNav and the hamburger in TopBar — so there's one menu, one open state,
// never two drifting copies. Everything NOT on the fixed bottom bar (Backing,
// Treasury, Baskets, Buyback, Profile, …) plus the community links lives here,
// which is the only way those routes are reachable below lg.

type Ctx = { isOpen: boolean; open: () => void; close: () => void };
const MoreMenuContext = createContext<Ctx | null>(null);

export function useMoreMenu(): Ctx {
  const c = useContext(MoreMenuContext);
  if (!c) throw new Error("useMoreMenu must be used within <MoreMenuProvider>");
  return c;
}

export function MoreMenuProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  // Close whenever the route changes — a tapped link navigates and the sheet
  // should not linger over the new page.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  return (
    <MoreMenuContext.Provider value={{ isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) }}>
      {children}
      <MoreSheet isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </MoreMenuContext.Provider>
  );
}

function MoreSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const items = moreNavItems(NAV_ITEMS);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="More navigation">
      <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-label="Close menu" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-card border-t border-border bg-bg pb-[calc(16px+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-content px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="section-label">More</span>
            <button
              onClick={onClose}
              aria-label="Close menu"
              className="flex h-8 w-8 items-center justify-center rounded-input text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              ✕
            </button>
          </div>

          <nav className="grid grid-cols-2 gap-2">
            {items.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-input border px-3 py-3 text-sm font-medium transition-colors",
                    active
                      ? "border-green/40 bg-surface-hover text-green"
                      : "border-border text-text-secondary hover:bg-surface-raised hover:text-text-primary",
                  )}
                >
                  <Icon active={active} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="my-4 border-t border-border" />

          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {COMMUNITY_LINKS.map((l) =>
              l.external ? (
                <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="text-text-muted transition-colors hover:text-text-secondary">
                  {l.label} ↗
                </a>
              ) : (
                <Link key={l.href} href={l.href} onClick={onClose} className="text-text-muted transition-colors hover:text-text-secondary">
                  {l.label}
                </Link>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
