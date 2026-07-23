import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Meander } from "@/components/Meander";
import { Container } from "@/components/Container";

// MARKETING LAYOUT — static shell shared by the landing page, docs, and legal
// pages. No web3 providers, no wallet code. Fast for a first-time visitor.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      {/* Meander section rule tying the app to the brand lockup — above the footer. */}
      <Container className="py-2">
        <Meander />
      </Container>
      <Footer />
    </div>
  );
}
