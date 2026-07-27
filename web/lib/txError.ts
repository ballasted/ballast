import { BaseError, ContractFunctionRevertedError } from "viem";

// One place to turn a raw provider/viem error into a sentence a person can act
// on. Two jobs:
//   1. Log the FULL error object (code, data, cause chain) to the console so a
//      failed transaction can actually be diagnosed — the UI only ever shows a
//      decoded, human sentence, never the raw provider string.
//   2. Decode a reverted contract call into its custom-error name and map the
//      names we know to plain copy.
//
// viem attaches the ABI to writeContract/simulate errors, so a revert like
// `FeedRestingAtLaunch(address)` arrives as a ContractFunctionRevertedError with
// `data.errorName` — no manual 4-byte selector matching needed.

// Known custom errors across the factory, treasury, and token. Keys are the
// Solidity error names; values are what the user reads.
const REVERT_COPY: Record<string, string> = {
  FeedRestingAtLaunch:
    "A treasury feed is resting — its market is closed. A backed launch prices against a live feed, so launch during market hours.",
  BadNoticePeriod: "The withdrawal notice period must be 7, 30, or 90 days.",
  WrongOrdering: "Token address mining failed on-chain. Retry — a fresh salt is mined each attempt.",
  CouldNotMineCurrency0: "Could not mine a valid token address in the search window. Retry.",
  NotLaunchToken: "That token was not launched by this factory.",
  AlreadyGraduated: "This token has already graduated — its pool is seeded.",
  ZeroAddress: "A required address was zero. This is a configuration error, not a wallet issue.",
  NotCreator: "Only the project creator can do that.",
  NothingToWithdraw: "There is nothing available to withdraw.",
  NoticeNotElapsed: "The withdrawal notice period has not elapsed yet.",
  AssetNotAllowed: "That asset is not on the treasury allowlist.",
  SelfBackingForbidden: "A project cannot back itself with its own token.",
};

// Solidity `Error(string)` reverts (Solmate/OpenZeppelin), which arrive as a plain
// reason string rather than a named custom error — including via a replayed
// eth_call (see replayForRevert). Matched as substrings of the decoded message.
const STRING_REVERT_COPY: Array<[string, string]> = [
  [
    "TRANSFER_FROM_FAILED",
    "The input transfer failed — for a sell, your wallet may not hold enough of the token, or the Permit2 approval didn't go through. Check your balance and try again.",
  ],
  ["TRANSFER_FAILED", "A token transfer failed. Check your balance and try again."],
  ["STF", "The input transfer failed — check your balance and allowance, then try again."],
  ["V4TooLittleReceived", "Price moved past your slippage tolerance. Raise the tolerance or try a smaller size."],
  ["AllowanceExpired", "Your Permit2 approval expired. Approve again and retry."],
  ["InsufficientAllowance", "Your Permit2 approval is insufficient. Approve again and retry."],
];

export function decodeTxError(err: unknown): string {
  // 1. Full object to the console for diagnosis — never shown to the user.
  //    Surfaces `code` and `data` that the raw message string drops.
  console.error("[ballast] transaction error", err);

  // 2. Reverted contract call — pull the custom-error name from the ABI decode.
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? undefined;
      if (name && REVERT_COPY[name]) return REVERT_COPY[name];
      if (name) return `Transaction reverted: ${name}.`;
    }
    const short = err.shortMessage || err.message;
    // String reverts (incl. those recovered by replaying a reverted tx) surface
    // their reason inside the message rather than as a named error — scan for the
    // ones we can explain. Checked against the full message so a reason buried in
    // "execution reverted: TRANSFER_FROM_FAILED" is still matched.
    const detail = `${short} ${err.message}`;
    for (const [needle, copy] of STRING_REVERT_COPY) {
      if (detail.includes(needle)) return copy;
    }
    if (/user rejected|denied|rejected the request/i.test(short)) {
      return "You rejected the transaction in your wallet.";
    }
    if (/insufficient funds/i.test(short)) return "Not enough ETH to cover gas.";
    if (/chain mismatch|does not match the target chain|chain of the connected/i.test(short)) {
      return "Your wallet is on the wrong network. Switch to Robinhood Chain and try again.";
    }
    return short.split("\n")[0]?.slice(0, 200) ?? "The transaction failed.";
  }

  const raw = err instanceof Error ? err.message : String(err);
  if (/rejected|denied/i.test(raw)) return "You rejected the transaction in your wallet.";
  return (raw.split("\n")[0] ?? raw).slice(0, 200);
}
