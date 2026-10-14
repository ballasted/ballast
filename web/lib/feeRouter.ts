import { formatDuration } from "@/lib/format";

// Maps a decoded FeeRouter.route() revert (viem errorName from a preflight
// simulation) to a human reason shown in place of "Ready now", so the UI never
// offers a Route button that would revert on-chain. `nowSec`/`readyAtSec` give a
// precise Cooldown countdown. Pure + unit-tested.
export function routeRevertReason(errorName: string | undefined, nowSec: number, readyAtSec: number): string {
  switch (errorName) {
    case "NothingToRoute":
      return "No fees to route yet — trading has to generate fees first.";
    case "Cooldown":
      return readyAtSec > nowSec ? `On cooldown — ready in ${formatDuration(readyAtSec - nowSec)}.` : "On cooldown.";
    case "NotWired":
      return "This router isn't wired to a launch yet.";
    case "MinAmountOutNotMet":
      return "A bucket swap would move the price too far right now — try again shortly.";
    default:
      return errorName ? `Can't route right now (${errorName}).` : "Can't route right now.";
  }
}

/** Does the buyback bucket need its pool wired before route() can burn? True when
 *  buyback has (or will have) a non-zero share and the pool isn't wired yet —
 *  surfaces the permissionless "Wire buyback pool" next-step in the UI. */
export function needsBuybackWire(args: {
  buybackWired: boolean;
  buybackBps: number;
  hasPendingSplit: boolean;
  pendingBuybackBps: number;
}): boolean {
  const willBuyback = args.buybackBps > 0 || (args.hasPendingSplit && args.pendingBuybackBps > 0);
  return !args.buybackWired && willBuyback;
}
