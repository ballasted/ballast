// Launch a token (mirrors the Create page), then seed its pool.
// Requires a funded account. NEVER commit a private key — pass it at runtime.
//   RPC=https://… PRIVATE_KEY=0x… npx tsx examples/launch.ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBallast, robinhoodChain, ADDRESSES } from "../src";

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) throw new Error("Set PRIVATE_KEY (0x…) in the environment.");

const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC) });
const ballast = createBallast({ publicClient, walletClient });

const { token, treasury, router, txHash } = await ballast.launch({
  name: "Example Token",
  symbol: "EXMPL",
  metadataURI: "ipfs://replace-me",
  quoteAssets: [ADDRESSES.weth], // WETH-only pool
  noticePeriod: 7n * 24n * 60n * 60n,
  split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 },
});
console.log("launched", { token, treasury, router, txHash });

// Seed the pool (unbacked launch — no treasury deposit). LP is locked permanently.
console.log("graduate tx:", await ballast.graduate(token));
