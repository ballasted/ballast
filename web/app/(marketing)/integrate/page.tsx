import type { Metadata } from "next";
import { Container } from "@/components/Container";

const REPO = "https://github.com/ballasted/ballast/blob/main";

export const metadata: Metadata = {
  title: "Integrate",
  description:
    "How to encode a swap against Ballast pools on Robinhood Chain — the extra minHopPriceX36 field, SETTLE_ALL behavior, and working buy/sell calldata. A chain-level router difference, not a token behavior.",
};

export default function IntegratePage() {
  return (
    <Container prose className="py-16">
      <article className="prose-doc">
        <h1>Integrating with Ballast on Robinhood Chain</h1>

        <p className="text-text-secondary">
          If you built swap calldata against a Ballast pool with the stock Uniswap SDK and it
          reverted on the buy — before a sell was ever attempted — <strong>that isn&apos;t a token
          problem</strong>. It&apos;s a router encoding difference specific to this chain. This page
          is the fix: the exact struct shape, worked examples, and a runnable repro you can check
          against a live pool yourself rather than take our word for it.
        </p>

        <div className="note note-warning not-prose my-6">
          Ballast token contracts have no owner, no pause, no blacklist, no transfer hook, and no
          mint function — see{" "}
          <a href="/docs/why-scanners-flag-us">why scanners flag us</a> for the full breakdown, or
          read <code>BallastToken.sol</code> yourself. This page is about the chain&apos;s router,
          not the token.
        </div>

        <h2>The gotcha</h2>
        <p>
          Robinhood Chain&apos;s deployed UniversalRouter is a <strong>modified fork</strong>. Its
          v4 swap params carry an extra <code>minHopPriceX36</code> field that the stock{" "}
          <code>@uniswap/*</code> SDKs don&apos;t know about. Calldata built by an unmodified SDK
          omits the field entirely, which shifts every byte after it — the fork&apos;s ABI decoder
          reads garbage and reverts. Two other router-lookalike addresses also exist on this chain;
          only one carries the matching verified fork source (see below).
        </p>

        <h2>The struct shape</h2>
        <p>
          <code>minHopPriceX36</code> is a fixed-point ×10<sup>36</sup> minimum execution price per
          hop. Set it to <code>0</code> to disable it and rely on <code>amountOutMinimum</code> for
          slippage instead — that&apos;s what Ballast&apos;s own app does. It has two different
          shapes depending on hop count, which is the actual trap (one field name, two types):
        </p>

        <h3>Single-hop — ExactInputSingleParams</h3>
        <p>What a graduated token/WETH pool needs. The field sits after amountOutMinimum, before hookData.</p>
        <pre>
          <code>{`{
  poolKey: { currency0, currency1, fee, tickSpacing, hooks },
  zeroForOne: boolean,
  amountIn: uint128,
  amountOutMinimum: uint128,
  minHopPriceX36: uint256,   // <-- the fork field. 0 = disabled.
  hookData: bytes,
}`}</code>
        </pre>

        <h3>Multi-hop — ExactInputParams</h3>
        <p>
          Ballast&apos;s own app doesn&apos;t need this (graduated pools are single-hop token/WETH),
          but the chain&apos;s router supports it. Here the field is <code>uint256[]</code>, and it
          sits <strong>third</strong> — after <code>path</code>, before <code>amountIn</code> — not
          trailing like the single-hop shape:
        </p>
        <pre>
          <code>{`{
  currencyIn: address,
  path: PathKey[],
  minHopPriceX36: uint256[],  // <-- length 0 (disabled) or exactly path.length,
                               //     else the router reverts InvalidHopPriceLength
  amountIn: uint128,
  amountOutMinimum: uint128,
}`}</code>
        </pre>

        <h2>SETTLE_ALL pays from msgSender, always</h2>
        <p>
          <code>SETTLE_ALL</code> pulls the input currency from whoever called{" "}
          <code>execute()</code> — unconditionally, via Permit2. It does not pay from the router&apos;s
          own balance. If you need the router to fund the input itself (e.g. right after a{" "}
          <code>WRAP_ETH</code> that leaves WETH sitting in the router), use plain{" "}
          <code>SETTLE</code> with <code>payerIsUser=false</code> instead — that&apos;s how a
          native-ETH buy avoids a Permit2 pull entirely. Mixing these up either fails a buy that
          should be gasless-to-approve, or tries to pull funds from a wallet that never approved
          anything.
        </p>

        <h2>Working examples</h2>
        <p>
          Native-ETH buy — wrap and swap in one <code>execute()</code> call, no separate wrap
          transaction and no Permit2 approval (the router funds the swap from its own just-wrapped
          balance):
        </p>
        <pre>
          <code>{`import { concatHex, encodeAbiParameters, toHex } from "viem";

const CMD_WRAP_ETH = "0x0b";
const CMD_V4_SWAP = "0x10";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;

// actions: [SWAP_EXACT_IN_SINGLE (0x06), SETTLE (0x0b), TAKE_ALL (0x0f)]
const swapParams = encodeAbiParameters([exactInputSingleParamsAbi], [{
  poolKey,
  zeroForOne: false,          // buying: WETH (currency1) -> token (currency0)
  amountIn,                    // wei, native ETH you're sending as msg.value
  amountOutMinimum,
  minHopPriceX36: 0n,          // disabled; slippage enforced by amountOutMinimum
  hookData: "0x",
}]);
const wrap = encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }],
  [ADDRESS_THIS, CONTRACT_BALANCE],
);
const settle = encodeAbiParameters(              // payerIsUser=false: router pays
  [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
  [WETH_ADDRESS, CONTRACT_BALANCE, false],
);
const takeAll = encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }],
  [tokenAddress, amountOutMinimum],
);
const v4Input = encodeAbiParameters(
  [{ type: "bytes" }, { type: "bytes[]" }],
  [concatHex(["0x06", "0x0b", "0x0f"]), [swapParams, settle, takeAll]],
);

await router.execute(
  concatHex([CMD_WRAP_ETH, CMD_V4_SWAP]),
  [wrap, v4Input],
  deadline,                     // a TIMESTAMP — this chain's blocks are ~100ms
  { value: amountIn },
);`}</code>
        </pre>

        <p>Sell — token to native ETH, pulled from your wallet via Permit2, unwrapped on the way out:</p>
        <pre>
          <code>{`const CMD_UNWRAP_WETH = "0x0c";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

const swapParams = encodeAbiParameters([exactInputSingleParamsAbi], [{
  poolKey,
  zeroForOne: true,           // selling: token (currency0) -> WETH (currency1)
  amountIn,
  amountOutMinimum,
  minHopPriceX36: 0n,
  hookData: "0x",
}]);
const settleAll = encodeAbiParameters(          // pulls from msgSender, always
  [{ type: "address" }, { type: "uint256" }],
  [tokenAddress, amountIn],
);
const take = encodeAbiParameters(               // 0 = OPEN_DELTA, full credit to router
  [{ type: "address" }, { type: "address" }, { type: "uint256" }],
  [WETH_ADDRESS, ADDRESS_THIS, 0n],
);
const v4Input = encodeAbiParameters(
  [{ type: "bytes" }, { type: "bytes[]" }],
  [concatHex(["0x06", "0x0c", "0x0e"]), [swapParams, settleAll, take]],
);
const unwrap = encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }],
  [MSG_SENDER, amountOutMinimum],
);

// requires two one-time Permit2 approvals first: token -> Permit2, Permit2 -> router
await router.execute(
  concatHex([CMD_V4_SWAP, CMD_UNWRAP_WETH]),
  [v4Input, unwrap],
  deadline,
);`}</code>
        </pre>

        <h2>Verify it yourself</h2>
        <p>Don&apos;t take this page&apos;s word for it. Three independent ways to check:</p>
        <ul>
          <li>
            <strong>Runnable repro</strong> —{" "}
            <a href={`${REPO}/contracts/test/RouterEncodingRepro.t.sol`}>
              <code>contracts/test/RouterEncodingRepro.t.sol</code>
            </a>{" "}
            forks the chain and executes both calldata shapes against a real graduated pool: the
            shape above succeeds on buy and sell; standard SDK-shaped calldata (the field omitted)
            reverts on the buy, before a sell is ever attempted. Clone the repo and run{" "}
            <code>forge test --match-path &quot;test/RouterEncodingRepro.t.sol&quot;</code> against
            your own fork.
          </li>
          <li>
            <strong>Canonical source</strong> —{" "}
            <a href={`${REPO}/web/lib/robinhoodRouter.ts`}><code>web/lib/robinhoodRouter.ts</code></a>{" "}
            and{" "}
            <a href={`${REPO}/web/lib/swap.ts`}><code>web/lib/swap.ts</code></a> are what Ballast&apos;s
            own app signs with, byte for byte — copy them directly rather than re-deriving from this
            page.
          </li>
          <li>
            <strong>On-chain proof</strong> — a separate, earlier proof (
            <code>contracts/script/ProveSwapMainnet.s.sol</code>) ran quote / simulate / real-broadcast
            against a live pool and got the identical output all three ways, confirming the fork
            router decodes this shape correctly.
          </li>
        </ul>

        <p className="text-sm text-text-faint">
          Router address:{" "}
          <a href="https://robinhoodchain.blockscout.com/address/0x8876789976dEcBfCbBbe364623C63652db8C0904?tab=contract">
            0x8876789976dEcBfCbBbe364623C63652db8C0904
          </a>{" "}
          — verified fork source on Blockscout. Two look-alike router addresses exist on this chain;
          re-verify independently before sending value, don&apos;t trust an address because a page
          printed it.
        </p>
      </article>
    </Container>
  );
}
