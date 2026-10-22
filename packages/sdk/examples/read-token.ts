// Read a token's identity, pools, backing, and fee split.
//   RPC=https://… npx tsx examples/read-token.ts 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C
import { createPublicClient, http, type Address } from "viem";
import { createBallast, robinhoodChain } from "../src";

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const token = (process.argv[2] ?? "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C") as Address;

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
const ballast = createBallast({ publicClient });

const info = await ballast.getToken(token);
console.log({
  symbol: info.symbol,
  name: info.name,
  hookGen: info.hookGen,
  graduated: info.graduated,
  quoteAssets: info.quoteAssets,
  backingPerToken: info.backing?.backingPerToken?.toString(),
  totalValueUsd: info.backing?.totalValueUsd?.toString(),
});

console.log("dead-address $BALLAST balance:", (await ballast.getDeadBalance()).toString());
console.log("buyback:", await ballast.getBuybackStats());
