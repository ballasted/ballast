"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address } from "viem";
import { useReadContract } from "wagmi";
import { burnVoteAbi } from "@/lib/abis";
import { BURN_VOTE_ADDRESS, isBurnVoteConfigured, isRoundupConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { useAssets } from "@/hooks/useAssets";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;
const PCTS = [1, 2, 3, 4, 5] as const;
const MIN_ROUNDUP_ETH = 0.0005; // below this the round-up is skipped

export type RoundupSelection = {
  enabled: boolean;
  bps: number;
  stock?: Address;
  ethAmount: number; // the round-up ETH, 0 when skipped
  skipped: boolean;
};

/** Stock round-up control for the swap panel. Reports the trader's choice up via
 *  onChange; SwapPanel feeds it into useRoundup, which batches a stock-only buy
 *  (BasketStockBuyer.buyStockWithETH) with the main ETH buy. Hidden unless the
 *  round-up router env is set. */
export function RoundupToggle({
  token,
  baseEth,
  onChange,
}: {
  token: Address;
  /** ETH the round-up is sized against: the ETH spent (buy) or received (sell). */
  baseEth: number | undefined;
  onChange?: (sel: RoundupSelection) => void;
}) {
  const { assets } = useAssets();
  const [enabled, setEnabled] = useState(false);
  const [bps, setBps] = useState(100); // 1%
  const [stock, setStock] = useState<Address | "">("");

  // Community default (burn-vote winner), preselected. Falls back to SGOV.
  const def = useReadContract({
    address: BURN_VOTE_ADDRESS,
    abi: burnVoteAbi,
    functionName: "defaultStock",
    args: [token],
    chainId: CHAIN_ID,
    query: { enabled: isBurnVoteConfigured },
  });
  const communityDefault = def.data as Address | undefined;

  const options = useMemo(
    () => assets.filter((a) => a.address.toLowerCase() !== token.toLowerCase()),
    [assets, token],
  );

  const sgov = useMemo(
    () => options.find((a) => (a.symbol ?? "").toUpperCase() === "SGOV")?.address,
    [options],
  );

  const effectiveStock: Address | undefined =
    (stock || undefined) ??
    (communityDefault && communityDefault !== "0x0000000000000000000000000000000000000000"
      ? communityDefault
      : sgov);

  const roundupEth = enabled && baseEth ? (baseEth * bps) / 10_000 : 0;
  const skipped = enabled && roundupEth > 0 && roundupEth < MIN_ROUNDUP_ETH;

  // Report selection upward whenever it changes.
  const selEnabled = enabled && !skipped;
  const selEth = skipped ? 0 : roundupEth;
  useEffect(() => {
    onChange?.({ enabled: selEnabled, bps, stock: effectiveStock, ethAmount: selEth, skipped });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selEnabled, bps, effectiveStock, selEth, skipped]);

  if (!isRoundupConfigured) return null;

  const stockSym =
    options.find((a) => a.address.toLowerCase() === effectiveStock?.toLowerCase())?.symbol ??
    (effectiveStock ? shortAddress(effectiveStock) : "—");

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label className="flex items-center justify-between text-sm">
        <span>Stock round-up</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-green"
        />
      </label>

      {enabled && (
        <>
          <div className="flex gap-1">
            {PCTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setBps(p * 100)}
                className={cn("chip flex-1", bps === p * 100 && "chip-active")}
              >
                {p}%
              </button>
            ))}
          </div>

          <select
            className="input w-full"
            value={stock}
            onChange={(e) => setStock(e.target.value as Address)}
          >
            <option value="">
              Community default{communityDefault ? "" : " (SGOV)"}: {stockSym}
            </option>
            {options.map((a) => (
              <option key={a.address} value={a.address}>
                {a.symbol ?? shortAddress(a.address)}
              </option>
            ))}
          </select>

          {skipped ? (
            <p className="note text-warning">
              Round-up is under {MIN_ROUNDUP_ETH} ETH — too small to route, so it will be skipped.
            </p>
          ) : roundupEth > 0 ? (
            <p className="text-xs text-text-muted">
              +{roundupEth.toFixed(4)} ETH of {stockSym}, delivered to your wallet
            </p>
          ) : null}

          <p className="note">
            A round-up purchase you make for yourself, delivered to your wallet. Ballast takes
            nothing. Holding a token gives no claim, redemption right, or entitlement to treasury
            assets.
          </p>
        </>
      )}
    </div>
  );
}
