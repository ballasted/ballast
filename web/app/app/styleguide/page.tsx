import type { Metadata } from "next";
import { Container } from "@/components/Container";
import { AssetDisc } from "@/components/app/AssetDisc";
import { Ambience } from "@/components/app/Ambience";
import { MeanderRule } from "@/components/Meander";
import { CommandSearch } from "@/components/app/CommandSearch";
import { NetworkChip } from "@/components/app/NetworkChip";
import { PortfolioValueChip } from "@/components/app/PortfolioValueChip";
import { AvatarMenu } from "@/components/app/AvatarMenu";
import { ConnectButton } from "@/components/app/ConnectButton";

// Living reference for every design-system primitive (spec §13). Lives under
// /app (not the marketing segment) since Milestone 2's shell primitives
// (CommandSearch, NetworkChip, PortfolioValueChip, AvatarMenu) all read wagmi
// state and need a WagmiProvider — the marketing segment deliberately has
// none (CLAUDE.md: wallet providers wrap ONLY /app). Not a product page — keep
// it out of search and out of the nav; reachable only by direct URL.
export const metadata: Metadata = {
  title: "Styleguide",
  description: "Internal design-system reference — not for public indexing.",
  robots: { index: false, follow: false },
};

const SWATCHES: Array<{ label: string; className: string; note: string }> = [
  { label: "ground", className: "bg-bg", note: "#050A06 — page background" },
  { label: "panel", className: "bg-card", note: "#0E1410 — cards, rails" },
  { label: "panel-2", className: "bg-surface-raised", note: "#131B16 — raised surfaces" },
  { label: "patina", className: "bg-green", note: "#22C93A — primary accent / buy" },
  { label: "patina-dim", className: "bg-green-mid", note: "#1B8A2B — rules, borders, decoration only (fails 4.5:1 as 12px text)" },
  { label: "amber", className: "bg-warning", note: "#E8A33D — warning / paused" },
  { label: "ember", className: "bg-negative", note: "#E2564D — negative / sell" },
  { label: "bone", className: "bg-bone", note: "#F5F3EC — primary text" },
];

const ASSET_DISC_SIZES = [24, 32, 48, 64, 96];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-border py-10 first:border-t-0 first:pt-0">
      <h2 className="section-label">{title}</h2>
      {children}
    </section>
  );
}

export default function StyleguidePage() {
  return (
    <Container className="py-16">
      <h1 className="font-serif text-display-sm text-text-primary">Styleguide</h1>
      <p className="mt-2 max-w-prose text-text-secondary">
        Every primitive, every state. Internal reference only — update this page
        in the same change that adds or restyles a component.
      </p>

      <Section title="Color">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SWATCHES.map((s) => (
            <div key={s.label} className="card p-3">
              <div className={`h-16 w-full rounded-input border border-border ${s.className}`} />
              <div className="mt-2 font-mono text-ui-xs text-text-primary">{s.label}</div>
              <div className="text-ui-xs text-text-muted">{s.note}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="space-y-3">
          <p className="font-serif text-display-xl text-text-primary">Aa 104</p>
          <p className="font-serif text-display-lg text-text-primary">Aa 76</p>
          <p className="font-serif text-display-md text-text-primary">Aa 56</p>
          <p className="font-serif text-display-sm text-text-primary">Aa 40</p>
        </div>
        <div className="mt-6 space-y-2 font-sans">
          <p className="text-ui-xl text-text-primary">UI sans 24</p>
          <p className="text-ui-lg text-text-primary">UI sans 20</p>
          <p className="text-ui-md text-text-primary">UI sans 16</p>
          <p className="text-ui-base text-text-primary">UI sans 14</p>
          <p className="text-ui-sm text-text-primary">UI sans 13</p>
          <p className="text-ui-xs text-text-primary">UI sans 12</p>
        </div>
        <div className="mt-6">
          <p className="font-mono text-ui-md text-text-primary">
            0x1a2B…9F00 · $1,234,567.89 · 12.4% · 4h ago
          </p>
          <p className="mt-1 text-ui-xs text-text-muted">
            Mono, tabular-nums enforced globally — columns never jitter.
          </p>
        </div>
      </Section>

      <Section title="AssetDisc">
        <div className="flex flex-wrap items-end gap-6">
          {ASSET_DISC_SIZES.map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <AssetDisc symbol="SGOV" size={size} />
              <span className="font-mono text-ui-xs text-text-muted">{size}px</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2">
            <AssetDisc symbol="???" src="/does-not-exist.png" size={48} />
            <span className="font-mono text-ui-xs text-text-muted">broken src</span>
          </div>
        </div>
      </Section>

      <Section title="Ambience">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="relative h-56 overflow-hidden rounded-card border border-border bg-bg">
            <Ambience variant="page" className="!absolute" />
            <span className="absolute bottom-2 left-2 font-mono text-ui-xs text-text-muted">
              variant=&quot;page&quot;
            </span>
          </div>
          <div className="relative h-56 overflow-hidden rounded-card border border-border bg-bg">
            <Ambience variant="hero" className="!absolute" />
            <span className="absolute bottom-2 left-2 font-mono text-ui-xs text-text-muted">
              variant=&quot;hero&quot;
            </span>
          </div>
        </div>
      </Section>

      <Section title="MeanderRule">
        <MeanderRule />
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <button className="btn-primary">Primary</button>
          <button className="btn-primary" disabled>
            Primary disabled
          </button>
          <button className="btn-secondary">Secondary</button>
          <button className="btn-secondary" disabled>
            Secondary disabled
          </button>
        </div>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap gap-2">
          <span className="chip chip-neutral">Neutral</span>
          <span className="chip chip-accent">Accent</span>
          <span className="chip chip-warning">Warning</span>
          <span className="chip chip-negative">Negative</span>
        </div>
      </Section>

      <Section title="Tabs">
        <div className="flex gap-2">
          <span className="tab tab-active">Active</span>
          <span className="tab tab-idle">Idle</span>
        </div>
      </Section>

      <Section title="Notes">
        <div className="space-y-2">
          <div className="note note-warning">Reserve syncing — trading paused.</div>
          <div className="note note-positive">Pool seeded.</div>
          <div className="note note-neutral">No data yet.</div>
        </div>
      </Section>

      <Section title="Shell">
        <p className="mb-4 text-sm text-text-muted">
          Live components, not mockups — connect a wallet to see the connected
          states (network chip, portfolio value, avatar menu). The bottom
          ticker bar is the real one framing this page (lg+ only).
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <CommandSearch />
          <NetworkChip />
          <PortfolioValueChip />
          <AvatarMenu />
          <ConnectButton />
        </div>
        <p className="mt-3 text-ui-xs text-text-faint">
          NetworkChip/PortfolioValueChip/AvatarMenu render nothing while
          disconnected — that&apos;s ConnectButton&apos;s slot, shown here side
          by side rather than swapped, so both states are visible at once.
        </p>
        <div className="mt-4 flex items-center gap-2 text-sm">
          <span className="text-text-secondary">Blur-balances demo value:</span>
          <span data-balance className="font-mono tabular-nums text-text-primary">
            $12,480.55
          </span>
          <span className="text-ui-xs text-text-faint">
            (toggle it from the avatar menu above)
          </span>
        </div>
      </Section>

      <Section title="Density">
        <div className="space-y-4">
          <div>
            <p className="eyebrow mb-2">Comfortable (--row-height: 44px, default)</p>
            <div className="card divide-y divide-border">
              {["Row A", "Row B"].map((r) => (
                <div key={r} className="flex items-center px-3 text-ui-base text-text-primary" style={{ height: "var(--row-height)" }}>
                  {r}
                </div>
              ))}
            </div>
          </div>
          <div style={{ "--row-height": "32px" } as React.CSSProperties}>
            <p className="eyebrow mb-2">Compact (--row-height: 32px)</p>
            <div className="card divide-y divide-border">
              {["Row A", "Row B"].map((r) => (
                <div key={r} className="flex items-center px-3 text-ui-base text-text-primary" style={{ height: "var(--row-height)" }}>
                  {r}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </Container>
  );
}
