# ballast-sdk — **preview**

TypeScript SDK for the [Ballast](https://ballasted.fun) launchpad on **Robinhood Chain (4663)**: typed reads, quotes, writes, and on-chain event decoders, built on [viem](https://viem.sh).

> **Preview.** The API is marked preview and may change between 0.x releases. Not published to npm — consume it from this monorepo. Every write **simulates before it sends**; you still review and sign with your own wallet.

Addresses, ABIs, and the launch/fee-split rules are taken from the repo's **compiled Foundry artifacts** and deploy docs — not hand-written. Refresh the ABIs after a `forge build` with `npm run gen:abis`.

## Install

```bash
# viem is a peer dependency
npm install viem
# then build the SDK (from packages/sdk)
npm install && npm run build
```

## Quickstart

```ts
import { createPublicClient, http } from "viem";
import { createBallast, robinhoodChain } from "ballast-sdk";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(YOUR_RPC) });
const ballast = createBallast({ publicClient });

const info = await ballast.getToken("0xDc605041F02e41CbD8FDC347023e93C4c3fA243C");
console.log(info.symbol, info.graduated, info.backing?.backingPerToken);
```

For writes, pass a `walletClient` with an account:

```ts
import { createWalletClient, custom } from "viem";
const walletClient = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum), account });
const ballast = createBallast({ publicClient, walletClient });
```

## Reads

```ts
await ballast.getToken(token, { feeRouterFromBlock: 90_000_000n }); // identity, pools, gen, backing, fee router + split
await ballast.getFeeRouter(token, { fromBlock: 90_000_000n });       // router, version, current + pending split, parent
await ballast.listLaunches({ fromBlock: 0n });                        // all launches, hidden test tokens filtered out
await ballast.getBuybackStats();                                     // burned totals, runs, last burn, spent, waiting
await ballast.getDeadBalance();                                      // $BALLAST burned to the dead address
```

## Quotes (WETH-quoted pools)

```ts
const q = await ballast.quoteBuy({ token, ethIn: 10n ** 17n, slippageBps: 100 });
// { amountOut, minOut, gasEstimate }
await ballast.quoteSell({ token, tokenIn: 1_000_000n * 10n ** 18n });
```

## Writes

```ts
// Launch (mirrors the Create page: FeeRouterFactoryV2.createAndLaunch)
const { token, treasury, router } = await ballast.launch({
  name: "Example", symbol: "EXMPL", metadataURI: "ipfs://…",
  quoteAssets: [WETH],               // WETH and/or up to 2 stock tokens
  noticePeriod: 7n * 24n * 60n * 60n,
  split: { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 },
});
await ballast.graduate(token);       // seed the pool, LP locked permanently

// Buy / sell with slippage (quotes minOut unless you pass one)
await ballast.buy({ token, amountIn: 10n ** 17n, slippageBps: 100 });
await ballast.sell({ token, amountIn: 1_000_000n * 10n ** 18n, slippageBps: 150 });

// Change the fee split — respects the v2 asymmetric-delay rule
const { instant } = await ballast.scheduleSplit(router, { creatorBps: 4000, treasuryBps: 0, buybackBps: 3000, parentBurnBps: 0, rewardsBps: 3000 });
// instant === true when the creator share isn't raised and no bucket is lowered; otherwise a 7-day delay applies.
```

## Events

```ts
import { parseBallastLogs } from "ballast-sdk";
const logs = await publicClient.getLogs({ fromBlock, toBlock });
for (const ev of parseBallastLogs(logs)) {
  if (ev.kind === "launch") …
  if (ev.kind === "swap") …
  if (ev.kind === "buybackBurned") …
  if (ev.kind === "deadTransfer") …       // ERC-20 Transfer to the dead address
  if (ev.kind === "splitScheduled" || ev.kind === "splitApplied") …
  if (ev.kind === "parentBurned") …
  if (ev.kind === "treasuryDeposit") …
  if (ev.kind === "basketFill") …
}
```

## Errors

All thrown errors subclass `BallastSdkError`: `ValidationError`, `SplitShapeError`, `SplitDelayError`, `NotBallastParentError`, `AssetNotAllowedError`, `SimulationError`, `NotFoundError`, `DecodeError`.

## Known limitations (preview)

- **Quotes/swaps cover WETH-quoted pools.** Non-WETH-quoted pools (NVDA/SPY/SGOV) route over Fables/Ramses in the app (`web/lib/routerV2.ts`); that multi-venue routing is a planned SDK extension and not quoted/executed here yet.
- `buyWithRoundup` and `vote` are **Phase 3 extension points** — they throw until `RoundupRouter`/`BurnVote` are deployed and wired in.
- Fee-router resolution scans `FeeRouterCreated` logs; pass a sensible `fromBlock` to bound the scan.

## Scripts

| script | purpose |
| --- | --- |
| `npm run gen:abis` | regenerate `src/constants/abis.ts` from `contracts/out/*.json` |
| `npm run build` | tsup → ESM + CJS + `.d.ts` |
| `npm test` | unit tests (decoders, validation, encoding) |
| `npm run test:fork` | fork reads/simulated launch (set `SDK_FORK_RPC`) |
