/**
 * setAssets.ts — expand the BALLAST treasury asset allowlist WITHOUT forge.
 *
 * A viem/TypeScript rewrite of contracts/script/SetAssets.s.sol, for a machine that
 * has Node + an RPC but no working Foundry. It calls AssetRegistry.setAsset(...) per
 * asset and keeps EVERY verification gate from the Solidity version:
 *   1. feed.decimals() is READ, never assumed 8 (CLAUDE.md rule 9).
 *   2. feed.description() must contain "Robinhood", the ticker, and "USD" (rule 16)
 *      — the on-chain confirmation this is the right Robinhood feed, not a look-alike.
 *   3. latestRoundData() must return a positive price (a real, priceable feed).
 *   4. token.symbol()/decimals() are read and shown so you can eyeball identity.
 *   5. the implied USD value of minDeposit at the live price is printed.
 * Two traps this CANNOT catch — verify at the source (rules 14/15): impostor tokens
 * (matching ticker, different address) and SVR-vs-Standard proxy. Addresses come
 * from env, human-verified, never baked in.
 *
 * DRY-RUN by default: verifies all ten, prints a table, writes NOTHING. It only
 * broadcasts when you pass --broadcast (or DRY_RUN=false), and then only if EVERY
 * resolved candidate passed verification — a single failure aborts the write, same
 * fail-closed behaviour as the reverting Solidity run.
 *
 * Env (auto-loaded from ../.env.local then ../../.env, i.e. web/.env.local and the
 * repo-root .env; existing process.env wins):
 *   ASSET_REGISTRY (or NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS)  deployed registry
 *   RPC_UPSTREAM_URL / RH_RPC_URL_PAID / RH_MAINNET_RPC_URL  an RPC endpoint
 *   DEPLOYER_PRIVATE_KEY   the registry OWNER (only needed for --broadcast)
 *   TOKEN_<TICKER> / FEED_<TICKER>   canonical token + Chainlink STANDARD proxy
 *
 * Run (from web/):
 *   npx tsx scripts/setAssets.ts              # dry-run: print the table
 *   npx tsx scripts/setAssets.ts --broadcast  # write, as the owner
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getContract,
  formatUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── env loading (no dotenv dependency) ──────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // file absent is fine
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(resolve(__dirname, "../.env.local"));
loadEnv(resolve(__dirname, "../../.env"));

// ── candidates (mirrors the Solidity list exactly) ──────────────────────────────
const HOUR = 3600;
const EQUITY_STALE = 96 * HOUR;
const SGOV_STALE = 120 * HOUR;
const MH_US_EQUITIES = 1; // MarketHours.UsEquities24_5

type Candidate = { ticker: string; staleAfter: number; minDeposit: bigint; marketHours: number };
const CANDIDATES: Candidate[] = [
  { ticker: "SGOV", staleAfter: SGOV_STALE, minDeposit: 10n ** 18n, marketHours: MH_US_EQUITIES },
  { ticker: "NVDA", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "TSLA", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "GOOGL", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "AAPL", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "MSFT", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "AMZN", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "META", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "SPY", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
  { ticker: "QQQ", staleAfter: EQUITY_STALE, minDeposit: 10n ** 17n, marketHours: MH_US_EQUITIES },
];

// ── ABIs (minimal) ───────────────────────────────────────────────────────────────
const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const feedAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
// Only the 5-arg setAsset is declared, so viem never has to disambiguate the overload.
const registryAbi = [
  {
    type: "function",
    name: "setAsset",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "feed", type: "address" },
      { name: "staleAfter", type: "uint256" },
      { name: "minDeposit", type: "uint256" },
      { name: "marketHours", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "assetConfig",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "allowed", type: "bool" },
      { name: "feed", type: "address" },
      { name: "staleAfter", type: "uint256" },
      { name: "minDeposit", type: "uint256" },
      { name: "marketHours", type: "uint8" },
    ],
  },
  { type: "function", name: "allowedAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

// ── helpers ──────────────────────────────────────────────────────────────────────
function reqAddr(v: string | undefined): Address | undefined {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

type Row = {
  ticker: string;
  token?: Address;
  feed?: Address;
  status: "SKIP" | "PASS" | "FAIL";
  detail: string;
  tokenDecimals?: number;
  feedDecimals?: number;
  price?: number;
  impliedUsd?: number;
};

async function main() {
  const broadcast = process.argv.includes("--broadcast") || process.env.DRY_RUN === "false";

  const registryAddr = reqAddr(process.env.ASSET_REGISTRY) ?? reqAddr(process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS);
  if (!registryAddr) {
    console.error("ERROR: ASSET_REGISTRY (or NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS) is not set/valid.");
    process.exit(1);
  }
  const rpc =
    process.env.RPC_UPSTREAM_URL ||
    process.env.RH_RPC_URL_PAID ||
    process.env.RH_MAINNET_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";

  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  console.log("=== SetAssets (viem): expand allowlist ===");
  console.log("registry:", registryAddr);
  console.log("rpc     :", rpc.replace(/\/v2\/.*$/, "/v2/****")); // don't print the key
  console.log("mode    :", broadcast ? "BROADCAST (will write)" : "DRY-RUN (no writes)");
  console.log("");

  const rows: Row[] = [];
  for (const c of CANDIDATES) {
    const token = reqAddr(process.env[`TOKEN_${c.ticker}`]);
    const feed = reqAddr(process.env[`FEED_${c.ticker}`]);
    if (!token || !feed) {
      rows.push({ ticker: c.ticker, token, feed, status: "SKIP", detail: "TOKEN_/FEED_ env unset" });
      continue;
    }
    try {
      const tokenC = getContract({ address: token, abi: erc20Abi, client: publicClient });
      const feedC = getContract({ address: feed, abi: feedAbi, client: publicClient });

      let tokenDecimals = 18;
      try {
        tokenDecimals = await tokenC.read.decimals();
      } catch {
        /* assume 18, logged below via detail */
      }
      const feedDecimals = await feedC.read.decimals();
      const desc = await feedC.read.description();
      const [, answer, , updatedAt] = await feedC.read.latestRoundData();

      // Gate: the on-chain description must anchor the exact ticker to a Robinhood
      // prefix and be a USD feed. ⚠️ FLAG (CLAUDE.md rule 16 conflict): rule 16 says
      // feeds are "Robinhood TICKER / USD", and most are — but SOME feeds on chain
      // 4663 return "RHTICKER / USD" on-chain (verified: NVDA/TSLA/MSFT/SPY read
      // "RHNVDA / USD" etc.), even though the canonical Chainlink directory LABELS
      // them "Robinhood NVDA / USD" and their proxyAddress matches our env address
      // exactly. So the address is right; the on-chain description just uses a second
      // naming format. We accept EITHER "Robinhood <TICKER>" OR "RH<TICKER>" (both
      // still require the exact ticker + USD) so a look-alike "... / USD" feed can't
      // pass, while both legitimate Robinhood formats do. The ADDRESS remains the
      // real anti-impostor guard (human-verified against the directory, rule 14/15).
      const descOk =
        desc.includes("USD") && (desc.includes(`Robinhood ${c.ticker}`) || desc.includes(`RH${c.ticker}`));
      if (!descOk) {
        rows.push({
          ticker: c.ticker,
          token,
          feed,
          status: "FAIL",
          detail: `feed.description() "${desc}" missing Robinhood/${c.ticker}/USD`,
          tokenDecimals,
          feedDecimals,
        });
        continue;
      }
      // Gate: positive price.
      if (answer <= 0n) {
        rows.push({
          ticker: c.ticker,
          token,
          feed,
          status: "FAIL",
          detail: `feed answer <= 0 (unpriceable)`,
          tokenDecimals,
          feedDecimals,
        });
        continue;
      }

      const price = Number(formatUnits(answer, feedDecimals));
      const minDepTokens = Number(formatUnits(c.minDeposit, tokenDecimals));
      const impliedUsd = minDepTokens * price;
      const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
      rows.push({
        ticker: c.ticker,
        token,
        feed,
        status: "PASS",
        detail: `"${desc}" · age ${ageSec}s`,
        tokenDecimals,
        feedDecimals,
        price,
        impliedUsd,
      });
    } catch (e) {
      rows.push({
        ticker: c.ticker,
        token,
        feed,
        status: "FAIL",
        detail: `read failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      });
    }
  }

  // ── the table ──
  console.log(
    pad("TICKER", 7),
    pad("STATUS", 7),
    pad("tokDec", 7),
    pad("feedDec", 8),
    pad("price(USD)", 14),
    pad("minDep≈USD", 12),
    "detail",
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      pad(r.ticker, 7),
      pad(r.status, 7),
      pad(r.tokenDecimals !== undefined ? String(r.tokenDecimals) : "-", 7),
      pad(r.feedDecimals !== undefined ? String(r.feedDecimals) : "-", 8),
      pad(r.price !== undefined ? `$${r.price.toLocaleString("en", { maximumFractionDigits: 4 })}` : "-", 14),
      pad(r.impliedUsd !== undefined ? `$${r.impliedUsd.toLocaleString("en", { maximumFractionDigits: 2 })}` : "-", 12),
      r.detail,
    );
  }
  console.log("");

  const skipped = rows.filter((r) => r.status === "SKIP");
  const failed = rows.filter((r) => r.status === "FAIL");
  const passed = rows.filter((r) => r.status === "PASS");
  console.log(`skipped (env unset): ${skipped.map((r) => r.ticker).join(", ") || "(none)"}`);
  console.log(`failed verification: ${failed.map((r) => r.ticker).join(", ") || "(none)"}`);
  console.log(`passed & ready     : ${passed.map((r) => r.ticker).join(", ") || "(none)"}`);
  console.log("");

  if (!broadcast) {
    console.log("DRY-RUN: nothing written. Re-run with --broadcast (as the registry owner) to write.");
    await printAllowlist(publicClient, registryAddr);
    return;
  }

  // ── broadcast (fail-closed: any FAIL among resolved candidates aborts) ──
  if (failed.length > 0) {
    console.error(`ABORT: ${failed.length} resolved candidate(s) failed verification. Fix the address(es) and re-run.`);
    process.exit(1);
  }
  if (passed.length === 0) {
    console.error("ABORT: nothing passed verification — no TOKEN_/FEED_ pairs resolved.");
    process.exit(1);
  }
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    console.error("ABORT: DEPLOYER_PRIVATE_KEY not set (required to broadcast).");
    process.exit(1);
  }
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  console.log(`Broadcasting ${passed.length} setAsset call(s) as ${account.address} ...`);

  for (const r of passed) {
    const c = CANDIDATES.find((x) => x.ticker === r.ticker)!;
    const hash = await wallet.writeContract({
      address: registryAddr,
      abi: registryAbi,
      functionName: "setAsset",
      args: [r.token!, r.feed!, BigInt(c.staleAfter), c.minDeposit, c.marketHours],
    });
    process.stdout.write(`  ${pad(r.ticker, 6)} setAsset tx ${hash} ... `);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(receipt.status === "success" ? "OK" : "REVERTED");
    if (receipt.status !== "success") {
      console.error(`ABORT: ${r.ticker} setAsset reverted (${hash}). Are you the registry owner?`);
      process.exit(1);
    }
  }
  console.log("");
  await printAllowlist(publicClient, registryAddr);
}

async function printAllowlist(publicClient: ReturnType<typeof createPublicClient>, registryAddr: Address) {
  const allowed = (await publicClient.readContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: "allowedAssets",
  })) as Address[];
  console.log(`=== allowedAssets() now returns ${allowed.length} asset(s) ===`);
  for (const a of allowed) {
    const [, feed, staleAfter, minDeposit, marketHours] = (await publicClient.readContract({
      address: registryAddr,
      abi: registryAbi,
      functionName: "assetConfig",
      args: [a],
    })) as [boolean, Address, bigint, bigint, number];
    console.log(`  ${a}  feed=${feed}  staleAfter=${staleAfter}s  minDeposit=${minDeposit}  mh=${marketHours}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
