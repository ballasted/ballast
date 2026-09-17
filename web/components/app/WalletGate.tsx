import { ConnectButton } from "@/components/app/ConnectButton";
import { Meander } from "@/components/Meander";

// The connect-wallet gate used by wallet-scoped screens (Portfolio, Profile). Matches
// the brand empty-state pattern — meander mark, serif headline, one line, action —
// so a gated screen reads as designed, not as a bare card floating in an empty page.
export function WalletGate({ title = "Connect your wallet", body }: { title?: string; body: string }) {
  return (
    <div className="mx-auto mt-8 max-w-lg card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h1 className="font-serif text-xl font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">{body}</p>
      <div className="mt-6 flex justify-center">
        <ConnectButton />
      </div>
    </div>
  );
}
