/**
 * Elysium (gen-5) fork smoke — drives the ACTUAL production calldata builders
 * (lib/swap.ts minHopPriceX36 fork encoding, lib/elysiumQuote.ts extsload quoting,
 * lib/tickMath.ts) against the REAL deployed contracts on an anvil fork of 99901.
 *
 * Proves end-to-end on-chain: launch → graduate → buy → sell → limit place → cancel.
 *
 * Run (from web/):
 *   anvil --fork-url https://rpc.elyscan.live --chain-id 99901 --port 8546 --silent &
 *   NEXT_PUBLIC_CHAIN=elysium npx tsx scripts/elysiumForkSmoke.mts
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  decodeEventLog,
  maxUint160,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildV4SwapInput, computeMinOut, swapDeadline } from "../lib/swap";
import { quoteElysiumExactIn, readElysiumPoolState } from "../lib/elysiumQuote";
import { poolKeyForToken, poolId as computePoolId, tokenIsCurrency0 } from "../lib/pool";
import { getSqrtRatioAtTick, liquidityForAmount0, liquidityForAmount1 } from "../lib/tickMath";
import { universalRouterExecuteAbi } from "../lib/robinhoodRouter";
import { ballastFactoryV5Abi, ballastHookV5Abi } from "../lib/abisV5";
import {
  FACTORY_ADDRESS,
  HOOK_ADDRESS,
  WETH_ADDRESS,
  POOL_MANAGER_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
  PERMIT2_ADDRESS,
  TICK_SPACING,
} from "../lib/contracts";
import { elysiumChain } from "../lib/chainProfile";

const RPC = process.env.FORK_RPC || "http://127.0.0.1:8546";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil #0

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const permit2 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }], outputs: [] },
] as const;

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

async function main() {
  const account = privateKeyToAccount(PK);
  const pub = createPublicClient({ chain: elysiumChain, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: elysiumChain, transport: http(RPC) });

  const factory = FACTORY_ADDRESS!;
  const hook = HOOK_ADDRESS!;
  const whype = WETH_ADDRESS!;
  const poolManager = POOL_MANAGER_ADDRESS!;
  const router = UNIVERSAL_ROUTER_ADDRESS!;
  console.log("Addresses resolved from lib/contracts (NEXT_PUBLIC_CHAIN=elysium):");
  console.log({ factory, hook, whype, poolManager, router });

  const send = async (hash: `0x${string}`, label: string) => {
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return rcpt;
  };

  // 1. LAUNCH
  console.log("\n[1] launch");
  const before = (await pub.readContract({ address: factory, abi: ballastFactoryV5Abi, functionName: "launchCount" })) as bigint;
  const launchHash = await wallet.writeContract({
    address: factory,
    abi: ballastFactoryV5Abi,
    functionName: "launch",
    args: ["Fork Smoke", "FORK", 100, "ipfs://smoke", whype, 10000, 0, 0],
  });
  const launchRcpt = await send(launchHash, "launch");
  let token: Address | undefined;
  for (const log of launchRcpt.logs) {
    try {
      const p = decodeEventLog({ abi: ballastFactoryV5Abi, ...log });
      if (p.eventName === "Launched") token = p.args.token as Address;
    } catch {}
  }
  assert(Boolean(token), `launched token from Launched event: ${token}`);
  if (!token) throw new Error("no token");
  void before;

  // 2. GRADUATE
  console.log("\n[2] graduate");
  await send(await wallet.writeContract({ address: factory, abi: ballastFactoryV5Abi, functionName: "graduate", args: [token] }), "graduate");
  const graduated = (await pub.readContract({ address: factory, abi: ballastFactoryV5Abi, functionName: "graduated", args: [token] })) as boolean;
  assert(graduated, "token graduated");

  // pool state
  const key = poolKeyForToken(token, whype, hook)!;
  const pid = computePoolId(key);
  const state = await readElysiumPoolState(pub, poolManager, pid);
  assert(Boolean(state && state.sqrtPriceX96 > 0n), `pool initialised (sqrtPriceX96 ${state?.sqrtPriceX96})`);
  assert(Boolean(state && state.liquidity > 0n), `pool has liquidity (${state?.liquidity})`);
  const feeBps = (await pub.readContract({ address: hook, abi: ballastHookV5Abi, functionName: "poolFeeBps", args: [pid] })) as number;
  assert(Number(feeBps) === 100, `pool fee is 1% (${Number(feeBps)} bps)`);

  // 3. BUY (native HYPE -> token) via the REAL fork-encoding builder
  console.log("\n[3] buy (HYPE -> token)");
  const buyIn = parseUnits("1", 18); // 1 HYPE
  const buyQuote = await quoteElysiumExactIn({ client: pub, poolManager, token, quoteAsset: whype, hook, feeBps: Number(feeBps), side: "buy", amountIn: buyIn });
  assert(buyQuote > 0n, `buy quote: ${formatUnits(buyQuote, 18)} token`);
  const buyMinOut = computeMinOut(buyQuote, 100); // 1% slippage
  const buyBuilt = buildV4SwapInput({ token, side: "buy", amountIn: buyIn, amountOutMinimum: buyMinOut, hook });
  assert(Boolean(buyBuilt), "buy calldata built");
  const tokenBalBefore = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
  const buyHash = await wallet.writeContract({
    address: router,
    abi: universalRouterExecuteAbi,
    functionName: "execute",
    args: [buyBuilt!.commands, buyBuilt!.inputs, swapDeadline(Math.floor(Date.now() / 1000))],
    value: buyBuilt!.value,
    gas: 3_000_000n,
  });
  console.log(`  buy tx: ${buyHash}`);
  await send(buyHash, "buy execute");
  const tokenBalAfter = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
  const bought = tokenBalAfter - tokenBalBefore;
  assert(bought > 0n, `received ${formatUnits(bought, 18)} token`);
  assert(bought >= buyMinOut, `received >= minOut (${formatUnits(bought, 18)} >= ${formatUnits(buyMinOut, 18)})`);

  // 4. SELL (token -> HYPE)
  console.log("\n[4] sell (token -> HYPE)");
  const sellIn = bought / 2n;
  await send(await wallet.writeContract({ address: token, abi: erc20, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint160] }), "approve token->permit2");
  await send(await wallet.writeContract({ address: PERMIT2_ADDRESS, abi: permit2, functionName: "approve", args: [token, router, maxUint160, 2 ** 46] }), "permit2 approve->router");
  const sellQuote = await quoteElysiumExactIn({ client: pub, poolManager, token, quoteAsset: whype, hook, feeBps: Number(feeBps), side: "sell", amountIn: sellIn });
  assert(sellQuote > 0n, `sell quote: ${formatUnits(sellQuote, 18)} HYPE`);
  const sellMinOut = computeMinOut(sellQuote, 100);
  const sellBuilt = buildV4SwapInput({ token, side: "sell", amountIn: sellIn, amountOutMinimum: sellMinOut, hook });
  assert(Boolean(sellBuilt), "sell calldata built");
  const nativeBefore = await pub.getBalance({ address: account.address });
  await send(
    await wallet.writeContract({
      address: router,
      abi: universalRouterExecuteAbi,
      functionName: "execute",
      args: [sellBuilt!.commands, sellBuilt!.inputs, swapDeadline(Math.floor(Date.now() / 1000))],
      value: sellBuilt!.value,
    }),
    "sell execute",
  );
  const nativeAfter = await pub.getBalance({ address: account.address });
  // native went up by ~sell proceeds minus gas; assert the token side decreased for certainty.
  const tokenBalFinal = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
  assert(tokenBalFinal === tokenBalAfter - sellIn, "token balance decreased by the sold amount");
  console.log(`  native ${formatUnits(nativeBefore, 18)} -> ${formatUnits(nativeAfter, 18)} HYPE (minus gas)`);

  // 5. LIMIT ORDER: place a SELL limit above current price, then cancel.
  console.log("\n[5] limit order place + cancel");
  const st = await readElysiumPoolState(pub, poolManager, pid);
  const curTick = st!.tick;
  const tokIs0 = tokenIsCurrency0(token, whype);
  // sell token: provide token above current price. provided currency is token.
  const providedIsCurrency0 = tokIs0;
  const zeroForOne = providedIsCurrency0;
  // choose a tickLower a few spacings above current, aligned.
  const alignedCur = Math.floor(curTick / TICK_SPACING) * TICK_SPACING;
  const tickLower = alignedCur + TICK_SPACING * 5;
  const tickUpper = tickLower + TICK_SPACING;
  const amountToken = parseUnits("1000", 18);
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const liquidity = providedIsCurrency0 ? liquidityForAmount0(amountToken, sqrtA, sqrtB) : liquidityForAmount1(amountToken, sqrtA, sqrtB);
  assert(liquidity > 0n, `computed limit-order liquidity ${liquidity}`);
  await send(await wallet.writeContract({ address: token, abi: erc20, functionName: "approve", args: [hook, maxUint160] }), "approve token->hook");
  const placeRcpt = await send(
    await wallet.writeContract({ address: hook, abi: ballastHookV5Abi, functionName: "place", args: [key, tickLower, zeroForOne, liquidity] }),
    "place limit order",
  );
  let epoch: bigint | undefined;
  for (const log of placeRcpt.logs) {
    try {
      const p = decodeEventLog({ abi: ballastHookV5Abi, ...log });
      if (p.eventName === "Place") epoch = p.args.epoch as bigint;
    } catch {}
  }
  assert(Boolean(epoch), `Place event, epoch ${epoch}`);
  const myLiq = (await pub.readContract({ address: hook, abi: ballastHookV5Abi, functionName: "epochLiquidity", args: [epoch!, account.address] })) as bigint;
  assert(myLiq === liquidity, `epochLiquidity matches placed liquidity (${myLiq})`);
  await send(
    await wallet.writeContract({ address: hook, abi: ballastHookV5Abi, functionName: "cancel", args: [key, tickLower, zeroForOne, account.address] }),
    "cancel limit order",
  );
  const myLiqAfter = (await pub.readContract({ address: hook, abi: ballastHookV5Abi, functionName: "epochLiquidity", args: [epoch!, account.address] })) as bigint;
  assert(myLiqAfter === 0n, "liquidity returned after cancel");

  console.log(`\n${failures === 0 ? "ALL PASSED ✓" : `${failures} FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
