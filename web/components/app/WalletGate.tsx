import { ConnectButton } from "@/components/app/ConnectButton";

// The connect-wallet gate used by wallet-scoped screens (Portfolio, Profile).
export function WalletGate({ title = "Connect your wallet", body }: { title?: string; body: string }) {
  return (
    <div className="mx-auto mt-8 max-w-lg card p-10 text-center">
      <h1 className="font-serif text-xl font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">{body}</p>
      <div className="mt-6 flex justify-center">
        <ConnectButton />
      </div>
    </div>
  );
}
