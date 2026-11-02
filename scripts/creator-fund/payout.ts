// ─────────────────────────────────────────────────────────────────────────────
// BALLAST Creator Fund — Safe payout builder. For each CONFIRMED winner, generate a
// Safe Transaction Builder batch JSON the human imports + signs in Safe{Wallet}.
//
// Run from the repo root (read-only — never signs or broadcasts):
//     npx tsx scripts/creator-fund/payout.ts
//
// WHY proposeDeposit (not deposit): ProjectTreasury.deposit() is onlyCreator — the
// Safe is not any token's creator, so it CANNOT call it. The only path for a third
// party (the Safe) to fund a treasury is proposeDeposit(asset, amount,
// disclosureVersion); the token's CREATOR must then call acceptDeposit(id) within a
// 7-day ACCEPT_WINDOW, after which the funds are PERMANENTLY LOCKED (never
// withdrawable). That matches the campaign copy: the prize increases displayed
// backing and confers no claim. If not accepted in 7 days, anyone can
// reclaimExpired(id) and the funds return to the Safe. See docs/CREATOR_FUND.md.
//
// All viem logic lives in web/lib/creator-fund/payoutLib.ts (resolves viem from
// web/node_modules); this script only loads env, reads the winners file, and writes.
// ─────────────────────────────────────────────────────────────────────────────
import { resolve } from "node:path";
import { loadEnv, getRpcUrl } from "./lib/env";
import { PATHS, readJson, writeJson } from "./lib/io";
import type { ConfirmedWinner } from "../../web/lib/creatorFund";

loadEnv();

async function main(): Promise<void> {
  const lib = await import("../../web/lib/creator-fund/payoutLib");
  const cf = await import("../../web/lib/creatorFund");

  const confirmed = readJson<{ winners: ConfirmedWinner[] }>(PATHS.confirmedSource, { winners: [] }).winners;
  if (confirmed.length === 0) {
    console.log("No confirmed winners in scripts/creator-fund/confirmed-winners.json — nothing to build.");
    return;
  }
  if (confirmed.length > cf.MAX_WINNERS) {
    console.warn(`WARNING: ${confirmed.length} confirmed winners exceeds the cap of ${cf.MAX_WINNERS}.`);
  }

  const { url, sourceName } = getRpcUrl();
  console.log(`RPC source: ${sourceName}`);

  const results = await lib.buildPayouts(url, confirmed);

  for (const r of results) {
    console.log("─".repeat(70));
    console.log(`Winner token:   ${r.token}`);
    if (r.skipped) {
      console.log(`SKIPPED:        ${r.skipped}`);
      continue;
    }
    writeJson(resolve(PATHS.payoutsDir, `${r.token}.json`), r.batch);
    console.log(`Treasury:       ${r.treasury}`);
    console.log(`Prize asset:    ${r.prizeAsset}`);
    console.log(`Price used:     $${r.priceUsd?.toFixed(6)} (feed ${r.feed}, ${r.feedDecimals} dp)`);
    console.log(`Amount:         ${r.amountFormatted} (${r.amount} raw, ${r.assetDecimals} dp)`);
    console.log(`Deposit value:  ~$${r.amountUsd?.toFixed(2)}`);
    console.log(`disclosureVer:  ${r.disclosureVersion}`);
    console.log(`Written:        ${resolve(PATHS.payoutsDir, `${r.token}.json`)}`);
    for (const wrn of r.warnings ?? []) console.log(`  ⚠ ${wrn}`);
  }

  console.log("─".repeat(70));
  console.log(
    "Import each payouts/<token>.json in Safe → Transaction Builder, review, sign.\n" +
      "After execution, record the tx hash in confirmed-winners.json (funded.txHash) and\n" +
      "re-run the scanner so the page shows a Funded badge. The creator must accept the\n" +
      "deposit (acceptDeposit) within 7 days. Nothing was signed or sent by this script.",
  );
}

main().catch((e) => {
  console.error("payout build failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
