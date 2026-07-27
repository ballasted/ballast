import type { Address } from "viem";

// $BALLAST — the first token launched on this launchpad, by the BALLAST team, as a
// live test. It shares the platform's name, sits first on Discover, and routes its
// creator fees to the protocol vault, so a reader could easily mistake it for a
// protocol token / equity. It is NOT one. This notice says so, bluntly, above the
// fold — the same voice as "what BALLAST is not".
//
// ⚠️ HARDCODED per-launch address — a deliberate, user-approved exception to the
// "never hardcode per-launch addresses" convention (there is no per-token notice
// mechanism yet, and this is acceptable for one token). When a per-token disclosure
// flag exists in launch metadata, drive this from that instead and delete the
// constant. Lowercased for a case-insensitive compare.
const PROTOCOL_TEST_TOKEN = "0x069a260370c61d91bd3e9842d81d378f9750f7f3";

export function isProtocolTestToken(token: Address | undefined): boolean {
  return Boolean(token) && token!.toLowerCase() === PROTOCOL_TEST_TOKEN;
}

export function ProtocolTokenNotice({ token }: { token: Address | undefined }) {
  if (!isProtocolTestToken(token)) return null;
  return (
    <section className="card border-accent p-4" role="note">
      <h2 className="text-sm font-semibold text-text-primary">This is not a protocol token</h2>
      <p className="mt-2 text-sm text-text-secondary">
        Launched by the BALLAST team as the first test of this launchpad. This is not a protocol token. It confers no
        ownership, revenue share, or claim on BALLAST. Its creator fees route to the protocol vault.
      </p>
    </section>
  );
}
