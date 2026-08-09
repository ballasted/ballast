"use client";

import { useState } from "react";
import { SocialIcon } from "@/components/SocialIcon";
import type { IconName } from "@/lib/links";
import { cn } from "@/lib/cn";

// The project's self-declared links (website / X / Telegram), read from the pinned
// metadata JSON. These are NOT verified — a project typing an X handle is not proof
// it controls it — so this is labelled "Links", never "Verified links", and carries
// no check mark. "Verified" is reserved for what the backing panel earns.
//
// Two hardening rules live here because the metadata is attacker-controllable (a
// token's on-chain metadataURI is a free launch() parameter, so anyone can pin
// arbitrary JSON and skip our create form entirely):
//   1. RENDER-TIME URL VALIDATION — every href is re-validated here, not just in
//      the create form. Only http(s) URLs survive; `javascript:`/`data:`/garbage
//      are dropped, so a directly-pinned link can never become a live sink on a
//      page we serve under ballasted.xyz.
//   2. OUTBOUND INTERSTITIAL — left-clicking a link opens a confirmation showing
//      the real destination and that BALLAST does not vouch for it, because we are
//      actively serving these on our own origin.
type LinkMeta = { website?: string; x?: string; telegram?: string };

function toUrl(v: string): string {
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

// Validate + normalise a project-supplied link. Returns a safe http(s) URL string,
// or undefined if the value can't be trusted as one. This is the gate that keeps a
// non-http scheme from ever reaching an href.
function safeHref(v?: string): string | undefined {
  if (!v || !v.trim()) return undefined;
  try {
    const u = new URL(toUrl(v.trim()));
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (!u.hostname.includes(".")) return undefined; // reject bare/garbage hosts
    return u.toString();
  } catch {
    return undefined;
  }
}

// Short, readable label for the row variant: hostname for a website, @handle for X,
// the bare handle/invite for Telegram.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}
function after(v: string, marker: string): string {
  const i = v.toLowerCase().lastIndexOf(marker);
  return (i >= 0 ? v.slice(i + marker.length) : v).replace(/^\/+/, "");
}

type Item = { key: string; icon: IconName; label: string; href: string };

function items(meta?: LinkMeta): Item[] {
  if (!meta) return [];
  const out: Item[] = [];
  const web = safeHref(meta.website);
  const x = safeHref(meta.x);
  const tg = safeHref(meta.telegram);
  if (web) out.push({ key: "website", icon: "website", label: hostOf(web), href: web });
  if (x) out.push({ key: "x", icon: "x", label: `@${after(meta.x!, "x.com/")}`, href: x });
  if (tg) out.push({ key: "telegram", icon: "telegram", label: after(meta.telegram!, "t.me/"), href: tg });
  return out;
}

/**
 * `variant="row"` — token page: icon + handle per link, with the unverified line.
 * `variant="icons"` — Discover card: icons only, no handles. Because a card is a
 * single <Link> (an anchor), the icon lives on a <button> rather than a nested <a>
 * (invalid HTML) and stops propagation so it doesn't also navigate to the token
 * page. Both paths route through the outbound interstitial before opening.
 */
export function ProjectLinks({
  meta,
  variant,
  className,
}: {
  meta?: LinkMeta;
  variant: "row" | "icons";
  className?: string;
}) {
  const list = items(meta);
  const [pending, setPending] = useState<Item | null>(null);
  if (list.length === 0) return null;

  if (variant === "icons") {
    return (
      <>
        <div className={cn("flex items-center gap-2.5", className)}>
          {list.map((it) => (
            <button
              key={it.key}
              type="button"
              aria-label={`${it.key} (opens in a new tab)`}
              title={it.label}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPending(it);
              }}
              className="text-text-faint transition-colors hover:text-text-secondary"
            >
              <SocialIcon name={it.icon} className="h-4 w-4" />
            </button>
          ))}
        </div>
        <LeaveInterstitial item={pending} onClose={() => setPending(null)} />
      </>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {list.map((it) => (
          // A real anchor (so middle-click / copy-link get the true URL), but a
          // left-click is intercepted into the interstitial.
          <a
            key={it.key}
            href={it.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => {
              e.preventDefault();
              setPending(it);
            }}
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <SocialIcon name={it.icon} className="h-4 w-4 text-text-faint" />
            {it.label}
          </a>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-text-faint">Provided by the project. Not verified by BALLAST.</p>
      <LeaveInterstitial item={pending} onClose={() => setPending(null)} />
    </div>
  );
}

// Outbound confirmation. Deliberately blunt and motion-free (matches the create
// flow's confirm modal). States plainly that the link is unverified and shows the
// exact destination host + full URL so a phishing target can't hide behind a label.
function LeaveInterstitial({ item, onClose }: { item: Item | null; onClose: () => void }) {
  if (!item) return null;
  const host = hostOf(item.href);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-text-primary">Leaving BALLAST</h2>
        <p className="mt-1 text-sm text-text-muted">
          Project-provided link, <span className="text-text-secondary">not verified</span> by BALLAST. Check the
          destination before continuing.
        </p>
        <div className="mt-4 rounded-input border border-border bg-bg p-3">
          <div className="eyebrow">Destination</div>
          <div className="mt-1 font-medium text-text-primary">{host}</div>
          <div className="mt-0.5 break-all font-mono text-xs text-text-faint">{item.href}</div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              window.open(item.href, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            Continue ↗
          </button>
        </div>
      </div>
    </div>
  );
}
