"use client";

import { buildXIntentUrl, type ShareCardParams } from "@/lib/shareCards";

// "Share on X" — opens an X web-intent with prefilled text + the event card link.
// Hidden behind NEXT_PUBLIC_SHARE_CARDS_ENABLED (default OFF) so it never changes
// production until the human flips it on. The OG card itself suppresses hidden
// tokens, so a share can never surface a test token.
const ENABLED = process.env.NEXT_PUBLIC_SHARE_CARDS_ENABLED === "true";

export function ShareOnX({ params, label = "Share on X", className }: { params: ShareCardParams; label?: string; className?: string }) {
  if (!ENABLED) return null;
  const href = buildXIntentUrl(params);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "chip inline-flex items-center gap-1.5 px-3 py-1.5 text-xs transition hover:border-accent/50"}
      title="Share this on X"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
      </svg>
      {label}
    </a>
  );
}
