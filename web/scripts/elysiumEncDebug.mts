import { createPublicClient, http, encodeAbiParameters, concatHex, toHex, parseUnits, type Hex, type Address } from "viem";
import { poolKeyForToken, buyZeroForOne } from "../lib/pool";
import { universalRouterExecuteAbi } from "../lib/robinhoodRouter";

const RPC = "http://127.0.0.1:8546";
const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const UR = (process.argv[3] || "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a") as Address;
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address;
const HOOK = "0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc" as Address;
const TOKEN = (process.argv[2] || "") as Address;

const pub = createPublicClient({ transport: http(RPC) });

const SETTLE_ABI = [{ type: "address" }, { type: "uint256" }, { type: "bool" }] as const;
const TAKE_ALL_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const WRAP_ABI = [{ type: "address" }, { type: "uint256" }] as const;
const V4_IN = [{ type: "bytes" }, { type: "bytes[]" }] as const;
const ADDR_THIS = "0x0000000000000000000000000000000000000002" as Address;
const CONTRACT_BALANCE = 1n << 255n;

const poolKeyTuple = {
  name: "poolKey",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

function paramsStandard(key: any, zfo: boolean, amountIn: bigint, minOut: bigint): Hex {
  const abi = { type: "tuple", components: [poolKeyTuple, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] } as const;
  return encodeAbiParameters([abi], [{ poolKey: key, zeroForOne: zfo, amountIn, amountOutMinimum: minOut, hookData: "0x" }]);
}
function paramsFork(key: any, zfo: boolean, amountIn: bigint, minOut: bigint): Hex {
  const abi = { type: "tuple", components: [poolKeyTuple, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] } as const;
  return encodeAbiParameters([abi], [{ poolKey: key, zeroForOne: zfo, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
}

async function tryBuy(label: string, swapParams: Hex, amountIn: bigint) {
  const key = poolKeyForToken(TOKEN, WHYPE, HOOK)!;
  const keyTuple = { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks };
  void keyTuple;
  const wrap = encodeAbiParameters(WRAP_ABI, [ADDR_THIS, CONTRACT_BALANCE]);
  const settle = encodeAbiParameters(SETTLE_ABI, [WHYPE, CONTRACT_BALANCE, false]);
  const takeAll = encodeAbiParameters(TAKE_ALL_ABI, [TOKEN, 0n]);
  const actions = concatHex([toHex(0x06, { size: 1 }), toHex(0x0b, { size: 1 }), toHex(0x0f, { size: 1 })]);
  const v4Input = encodeAbiParameters(V4_IN, [actions, [swapParams, settle, takeAll]]);
  const commands = concatHex(["0x0b", "0x10"]);
  try {
    await pub.simulateContract({
      account: FROM,
      address: UR,
      abi: universalRouterExecuteAbi,
      functionName: "execute",
      args: [commands, [wrap, v4Input], BigInt(Math.floor(Date.now() / 1000) + 600)],
      value: amountIn,
    });
    console.log(`${label}: OK (no revert)`);
  } catch (e: any) {
    const walk = e?.walk?.() ?? e;
    console.log(`${label}: REVERT ${walk?.data ?? walk?.shortMessage ?? walk?.message?.split("\n")[0]}`);
  }
}

async function main() {
  const key = poolKeyForToken(TOKEN, WHYPE, HOOK)!;
  const kt = { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks };
  const zfo = buyZeroForOne(TOKEN, WHYPE);
  const amountIn = parseUnits("1", 18);
  console.log("token", TOKEN, "zeroForOne", zfo, "key", kt);
  await tryBuy("STANDARD (no minHopPriceX36)", paramsStandard(kt, zfo, amountIn, 0n), amountIn);
  await tryBuy("FORK (with minHopPriceX36)", paramsFork(kt, zfo, amountIn, 0n), amountIn);
}
main();
