// ─────────────────────────────────────────────────────────────────────────────
// BALLAST Creator Fund — chain scanner. Builds the eligibility leaderboard from
// on-chain events and writes JSON the /app/creator-fund page + admin page read.
//
// Run from the repo root:
//     npx tsx scripts/creator-fund/scan.ts
//
// Reads RH_RPC_URL_PAID by name (falls back to RPC_UPSTREAM_URL, then the public
// RPC). Re-runnable + incremental: per-token last-scanned block is cached in
// data/creator-fund/state.json, so a re-run only fetches new blocks. Writes:
//   • web/lib/creator-fund/data/leaderboard.json   (public — no flag detail)
//   • web/lib/creator-fund/data/admin.json         (admin — includes flags)
//   • mirrors scripts/creator-fund/confirmed-winners.json into the web bundle
//
// Never signs or broadcasts anything. Reads only. Secrets are read by name, never
// printed. See docs/CREATOR_FUND.md for the full method.
// ─────────────────────────────────────────────────────────────────────────────
import { loadEnv, getRpcUrl } from "./lib/env";
import { PATHS, readJson, writeJson, mirrorConfirmed } from "./lib/io";
import { notifyQualified, tgEnabled } from "./lib/notify";
import type { ScanState } from "../../web/lib/creator-fund/scan";
import type { ConfirmedWinner } from "../../web/lib/creatorFund";

// Env MUST load before importing any module that reads process.env at import time
// (web/lib/contracts.ts, web/lib/creatorFund.ts). Those are dynamically imported
// inside main(), after loadEnv().
loadEnv();

type StateWithNotified = ScanState & { notified?: string[] };

async function main(): Promise<void> {
  // All viem usage lives inside the dynamically-imported web/lib modules (they
  // resolve viem from web/node_modules). The repo root has no viem, so this script
  // never imports it directly.
  const scan = await import("../../web/lib/creator-fund/scan");
  const cf = await import("../../web/lib/creatorFund");

  const now = Math.floor(Date.now() / 1000);

  // Always mirror the human-edited confirmed winners into the web bundle.
  mirrorConfirmed();
  const confirmed = readJson<{ winners: ConfirmedWinner[] }>(PATHS.confirmedSource, { winners: [] }).winners;

  // Pre-launch: nothing is eligible, write empty boards and exit (no RPC needed).
  if (cf.CAMPAIGN_START <= 0) {
    console.warn(
      "CAMPAIGN_START is unset (NEXT_PUBLIC_CREATOR_FUND_START=0). Writing empty leaderboards — set the start to begin scanning.",
    );
    const empty = { meta: { generatedAt: now, campaignStart: 0, lastScannedBlock: 0 }, tokens: [] };
    writeJson(PATHS.publicOut, empty);
    writeJson(PATHS.adminOut, empty);
    return;
  }

  const { url, sourceName } = getRpcUrl();
  console.log(`RPC source: ${sourceName}`); // name only — never the URL/key

  const client = scan.makeClient(url);

  const { ASSET_REGISTRY_ADDRESS, ETH_USD_FEED_ADDRESS, WETH_ADDRESS } = scan.DEPS;
  if (!ASSET_REGISTRY_ADDRESS || !ETH_USD_FEED_ADDRESS || !WETH_ADDRESS) {
    throw new Error(
      "Missing NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS / NEXT_PUBLIC_ETH_USD_FEED_ADDRESS / NEXT_PUBLIC_WETH_ADDRESS in env.",
    );
  }

  const latest = await client.getBlockNumber();

  // Load incremental state.
  const state = readJson<StateWithNotified>(PATHS.state, { ...scan.emptyState(), notified: [] });
  state.campaignStart = cf.CAMPAIGN_START;
  if (!state.notified) state.notified = [];

  // 1. discover eligible launches.
  const discovered = await scan.discoverEligibleLaunches(client, state, latest);
  console.log(`Eligible tokens tracked: ${Object.keys(state.tokens).length} (${discovered.length} new/updated)`);

  // 2. per-token incremental scan (skip finalized windows).
  const traderCache = new Map<string, `0x${string}`>();
  let scannedTokens = 0;
  for (const key of Object.keys(state.tokens)) {
    const ts = state.tokens[key]!;
    if (ts.finalized) continue;
    const { newSwaps, newTransfers } = await scan.scanTokenWindow(client, ts, latest, {
      registry: ASSET_REGISTRY_ADDRESS,
      weth: WETH_ADDRESS,
      ethUsdFeed: ETH_USD_FEED_ADDRESS,
      traderCache,
    });
    // Window fully elapsed and now scanned → never rescan.
    if (now > ts.launchTs + cf.MILESTONE_WINDOW_SECONDS) ts.finalized = true;
    scannedTokens++;
    if (newSwaps || newTransfers) {
      console.log(`  ${ts.symbol || key}: +${newSwaps} swaps, +${newTransfers} transfers`);
    }
  }
  console.log(`Scanned ${scannedTokens} active token window(s) up to block ${latest}.`);

  // Persist state before building (so a crash mid-build doesn't lose scan work).
  writeJson(PATHS.state, state);

  // 3. build leaderboards.
  const boards = scan.buildLeaderboards(state, now, confirmed, Number(latest));
  writeJson(PATHS.publicOut, boards.public);
  writeJson(PATHS.adminOut, boards.admin);

  const counts = boards.admin.tokens.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Statuses: ${JSON.stringify(counts)}`);
  console.log(`Confirmed winners committed: ${confirmed.length} / ${cf.MAX_WINNERS}`);

  // 4. optional Telegram alert for newly-qualified tokens (dedup via state.notified).
  if (tgEnabled()) {
    const notified = new Set(state.notified);
    for (const t of boards.admin.tokens) {
      if (t.status !== "qualified") continue;
      const key = t.token.toLowerCase();
      if (notified.has(key)) continue;
      const ok = await notifyQualified(t.symbol ? `$${t.symbol}` : t.name || t.token);
      if (ok) {
        notified.add(key);
        console.log(`  TG alert sent: ${t.symbol || t.token}`);
      }
    }
    state.notified = Array.from(notified);
    writeJson(PATHS.state, state);
  }

  console.log("Done. Wrote leaderboard.json + admin.json. Nothing was signed or sent on-chain.");
}

main().catch((e) => {
  console.error("scan failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
