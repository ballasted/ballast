// Payout batch builder (viem logic lives here, in web/lib, so the repo-root
// payout.ts never imports viem directly). Reads prices + decimals + minDeposit and
// the treasury (on-chain, never guessed) and returns a Safe Transaction Builder batch
// per confirmed winner: approve + proposeDeposit. See docs/CREATOR_FUND.md.
import { encodeFunctionData, formatUnits, getAddress, type Address } from "viem";
import { aggregatorV3Abi, assetRegistryAbi, ballastTokenAbi, erc20Abi } from "../abis";
import { ASSET_REGISTRY_ADDRESS } from "../contracts";
import { DEFAULT_PRIZE_ASSET, PRIZE_DISCLOSURE_VERSION, PRIZE_USD, type ConfirmedWinner } from "../creatorFund";
import { makeClient } from "./scan";

export const PAYOUT_SAFE = "0xEFC97e16a24d2434C7138a2634E554a0631aC079";

const proposeDepositAbi = {
  type: "function",
  name: "proposeDeposit",
  stateMutability: "nonpayable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "disclosureVersion", type: "bytes32" },
  ],
  outputs: [{ type: "uint256" }],
} as const;

export type PayoutResult = {
  token: Address;
  skipped?: string;
  treasury?: Address;
  prizeAsset?: Address;
  feed?: Address;
  priceUsd?: number;
  amount?: string;
  amountFormatted?: string;
  amountUsd?: number;
  assetDecimals?: number;
  feedDecimals?: number;
  disclosureVersion?: string;
  batch?: unknown;
  warnings?: string[];
};

/** Build a Safe batch for every confirmed winner. Read-only; never signs/sends. */
export async function buildPayouts(rpcUrl: string, winners: ConfirmedWinner[]): Promise<PayoutResult[]> {
  const registry = ASSET_REGISTRY_ADDRESS;
  if (!registry) throw new Error("NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS not set.");
  const client = makeClient(rpcUrl);
  const out: PayoutResult[] = [];

  for (const w of winners) {
    const token = getAddress(w.token as `0x${string}`);
    const prizeAsset = getAddress((w.prizeAsset ?? DEFAULT_PRIZE_ASSET) as `0x${string}`);

    const treasury = (await client.readContract({
      address: token,
      abi: ballastTokenAbi,
      functionName: "treasury",
    })) as `0x${string}`;
    if (!treasury || /^0x0{40}$/.test(treasury)) {
      out.push({ token, skipped: "could not resolve treasury on-chain" });
      continue;
    }

    const cfg = (await client.readContract({
      address: registry,
      abi: assetRegistryAbi,
      functionName: "assetConfig",
      args: [prizeAsset],
    })) as readonly [boolean, `0x${string}`, bigint, bigint, number];
    const [allowed, feed, , minDeposit] = cfg;
    if (!allowed) {
      out.push({ token, prizeAsset, skipped: "prize asset is not AssetRegistry-allowed (proposeDeposit would revert)" });
      continue;
    }

    const [feedDecimals, assetDecimals, roundData] = await Promise.all([
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: prizeAsset, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }) as Promise<
        readonly [bigint, bigint, bigint, bigint, bigint]
      >,
    ]);
    const answer = roundData[1];
    if (answer <= 0n) {
      out.push({ token, prizeAsset, skipped: "feed returned non-positive price" });
      continue;
    }

    const priceUsd = Number(formatUnits(answer, Number(feedDecimals)));
    let amount = (BigInt(PRIZE_USD) * 10n ** BigInt(assetDecimals) * 10n ** BigInt(feedDecimals)) / answer;

    const warnings: string[] = [];
    if (amount < minDeposit) {
      warnings.push(
        `$${PRIZE_USD} worth (${formatUnits(amount, Number(assetDecimals))}) is below minDeposit ` +
          `(${formatUnits(minDeposit, Number(assetDecimals))}); bumped to minDeposit, so the deposit is worth more than $${PRIZE_USD}.`,
      );
      amount = minDeposit;
    }
    const amountFormatted = formatUnits(amount, Number(assetDecimals));
    const amountUsd = Number(amountFormatted) * priceUsd;

    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [treasury, amount] });
    const proposeData = encodeFunctionData({
      abi: [proposeDepositAbi],
      functionName: "proposeDeposit",
      args: [prizeAsset, amount, PRIZE_DISCLOSURE_VERSION],
    });

    const batch = {
      version: "1.0",
      chainId: "4663",
      createdAt: Date.now(),
      meta: {
        name: `BALLAST Creator Fund prize — ${token}`,
        description:
          `Approve + proposeDeposit $${PRIZE_USD} of ${prizeAsset} into treasury ${treasury}. ` +
          `The token creator must then call acceptDeposit(id) within 7 days or it reverts to the Safe.`,
        txBuilderVersion: "1.17.1",
        createdFromSafeAddress: PAYOUT_SAFE,
        createdFromOwnerAddress: "",
        checksum: "",
      },
      transactions: [
        { to: prizeAsset, value: "0", data: approveData, contractMethod: null, contractInputsValues: null },
        { to: treasury, value: "0", data: proposeData, contractMethod: null, contractInputsValues: null },
      ],
    };

    out.push({
      token,
      treasury,
      prizeAsset,
      feed,
      priceUsd,
      amount: amount.toString(),
      amountFormatted,
      amountUsd,
      assetDecimals: Number(assetDecimals),
      feedDecimals: Number(feedDecimals),
      disclosureVersion: PRIZE_DISCLOSURE_VERSION,
      batch,
      warnings,
    });
  }

  return out;
}
