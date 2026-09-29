import { Ambience } from "@/components/app/Ambience";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

// MARKETING LAYOUT — static shell shared by the landing page, docs, and legal
// pages. No web3 providers, no wallet code. Fast for a first-time visitor.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Ambient depth so the landing page reads as a lit surface, not flat black
          (spec §3, "Surface style", hero variant). Fixed, behind all content. */}
      <Ambience variant="hero" />
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
