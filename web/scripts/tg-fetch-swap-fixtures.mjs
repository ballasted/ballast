// One-off: pull REAL v4 swaps off Robinhood Chain and label each buy/sell by an
// oracle INDEPENDENT of the sign convention we're testing — the net ERC-20
// movement of the launched token in/out of the PoolManager singleton. If the pool
// gained the token, the swapper paid it → SELL; if the pool lost it → BUY. We then
// emit fixtures covering the 2x2 matrix (token = currency0/currency1) x (buy/sell).
//
//   node scripts/tg-fetch-swap-fixtures.mjs
//
// Env (from .env.local): RPC_UPSTREAM_URL, NEXT_PUBLIC_POOL_MANAGER_ADDRESS,
// NEXT_PUBLIC_WETH_ADDRESS, NEXT_PUBLIC_FACTORY_ADDRESS,
// NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES.
import { createPublicClient, http, parseAbiItem } from "viem";
import { readFileSync } from "node:fs";

// Minimal .env.local reader (no dotenv dep).
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const RPC = env.RPC_UPSTREAM_URL;
const POOL_MANAGER = env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS.toLowerCase();
const WETH = env.NEXT_PUBLIC_WETH_ADDRESS.toLowerCase();
const FACTORIES = [env.NEXT_PUBLIC_FACTORY_ADDRESS, ...(env.NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES || "").split(",")]
  .map((s) => s && s.trim().toLowerCase())
  .filter(Boolean);

const client = createPublicClient({ transport: http(RPC) });

const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const POOL_SEEDED = parseAbiItem(
  "event PoolSeeded(address indexed token, address indexed quoteAsset, bytes32 poolId, int24 openTick, uint256 amount)",
);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t) => ("0x" + t.slice(26)).toLowerCase();

const SPAN = 9_000_000n;

async function buildPoolMap(tip) {
  // poolId(lower) -> { token, quote }
  const map = {};
  for (let lo = 0n; lo <= tip; lo += SPAN) {
    const hi = lo + SPAN - 1n > tip ? tip : lo + SPAN - 1n;
    for (const f of FACTORIES) {
      try {
        const logs = await client.getLogs({ address: f, event: POOL_SEEDED, fromBlock: lo, toBlock: hi });
        for (const l of logs) {
          map[l.args.poolId.toLowerCase()] = { token: l.args.token.toLowerCase(), quote: l.args.quoteAsset.toLowerCase() };
        }
      } catch (e) {
        console.error(`PoolSeeded ${f} ${lo}-${hi}: ${String(e).slice(0, 120)}`);
      }
    }
  }
  return map;
}

// Net token movement into the PoolManager over the tx → ground-truth side.
async function groundTruthSide(txHash, token) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  let net = 0n; // + = pool gained token (sell), - = pool lost token (buy)
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    if ((log.topics[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const from = topicAddr(log.topics[1]);
    const to = topicAddr(log.topics[2]);
    const value = BigInt(log.data);
    if (to === POOL_MANAGER) net += value;
    if (from === POOL_MANAGER) net -= value;
  }
  if (net === 0n) return null; // ambiguous / no direct PM transfer
  return net > 0n ? "sell" : "buy";
}

// Swaps for ONE pool (filtered by the indexed poolId) over [from,tip], chunked.
async function swapsForPool(poolId, from, tip) {
  const out = [];
  for (let lo = from; lo <= tip; lo += SPAN) {
    const hi = lo + SPAN - 1n > tip ? tip : lo + SPAN - 1n;
    try {
      const logs = await client.getLogs({ address: POOL_MANAGER, event: SWAP, args: { id: poolId }, fromBlock: lo, toBlock: hi });
      out.push(...logs);
    } catch (e) {
      console.error(`swaps pool ${poolId.slice(0, 10)} ${lo}-${hi}: ${String(e).slice(0, 90)}`);
    }
  }
  // newest first
  return out.sort((a, b) => Number(b.blockNumber - a.blockNumber));
}

async function main() {
  const tip = await client.getBlockNumber();
  console.error(`tip=${tip}  factories=${FACTORIES.length}`);
  const poolMap = await buildPoolMap(tip);
  const poolIds = Object.keys(poolMap);
  console.error(`pools known: ${poolIds.length}`);

  // Want one fixture per (tokenIsC0 ? "c0" : "c1") x ("buy"|"sell").
  const want = new Set(["c0:buy", "c0:sell", "c1:buy", "c1:sell"]);
  const picked = [];
  const from = tip > 20_000_000n ? tip - 20_000_000n : 0n;

  // Visit pools, preferring ones that can still fill an open slot.
  for (const poolId of poolIds) {
    if (want.size === 0) break;
    const { token, quote } = poolMap[poolId];
    const tokenIsC0 = token < quote;
    const key = tokenIsC0 ? "c0" : "c1";
    if (!want.has(`${key}:buy`) && !want.has(`${key}:sell`)) continue;
    const swaps = await swapsForPool(poolId, from, tip);
    if (swaps.length) console.error(`pool ${poolId.slice(0, 10)} (${key}, q=${quote === WETH ? "WETH" : quote.slice(0, 8)}): ${swaps.length} swaps`);
    for (const s of swaps) {
      const slotBuy = `${key}:buy`, slotSell = `${key}:sell`;
      if (!want.has(slotBuy) && !want.has(slotSell)) break;
      const side = await groundTruthSide(s.transactionHash, token).catch(() => null);
      if (!side) continue;
      const slot = `${key}:${side}`;
      if (!want.has(slot)) continue;
      want.delete(slot);
      picked.push({
        slot,
        txHash: s.transactionHash,
        poolId,
        token,
        quote,
        quoteIsWeth: quote === WETH,
        tokenIsCurrency0: tokenIsC0,
        amount0: s.args.amount0.toString(),
        amount1: s.args.amount1.toString(),
        groundTruthSide: side,
        block: s.blockNumber.toString(),
      });
      console.error(`picked ${slot}  tx=${s.transactionHash}`);
    }
  }
  console.log(JSON.stringify({ wethAddress: WETH, poolManager: POOL_MANAGER, fixtures: picked, missing: [...want] }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
