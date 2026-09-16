import { describe, it, expect } from "vitest";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { ballastFactoryAbi } from "./abis";

// Real, captured on-chain bytes — NOT a fixture we invented. Obtained via:
//   cast call 0x069974136c78cf0f2162463b95321e59f56523d8 "launches(uint256)" 0 \
//     --rpc-url $RPC_UPSTREAM_URL
// against the PRIOR BallastFactory on Robinhood Chain mainnet (launch index 0 =
// $BALLAST). That contract is immutable — this exact 96-byte (3-word) shape is
// what it returns today and will keep returning forever, regardless of what any
// *newer* factory's Launch struct looks like.
//
// On 2026-09-16, `launches`'s ABI output was briefly widened to 4 fields (to
// match a newer factory's struct that hadn't been deployed yet). Decoding this
// exact response against that 4-field ABI throws ("buffer overrun while
// deserializing"), which under useReadContracts's allowFailure silently dropped
// every launch from every configured factory — emptying Discover, command
// search, and the live rail (they all read through useProjects) with no error
// surfaced anywhere. This test pins the fix: the shared ABI must decode this
// real historical response correctly, forever, no matter how new-factory ABIs
// evolve elsewhere.
const REAL_PRIOR_FACTORY_LAUNCHES_0_RESPONSE =
  "0x000000000000000000000000069a260370c61d91bd3e9842d81d378f9750f7f30000000000000000000000004e2037b6fb622e681ce05e4e48c548ea915b4e590000000000000000000000003b4f9a424aeca0f3275981d5ead349c62ec9bd85" as const;

const BALLAST_TOKEN_ADDRESS = "0x069a260370C61d91bd3e9842d81D378F9750F7F3";
const BALLAST_TREASURY_ADDRESS = "0x4E2037b6FB622e681cE05e4e48c548EA915B4E59";
const BALLAST_CREATOR_ADDRESS = "0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85";

describe("ballastFactoryAbi.launches — must decode every already-deployed factory shape", () => {
  it("decodes a real captured launches(0) response from the prior (pre-quoteAsset) factory", () => {
    const [token, treasury, creator] = decodeFunctionResult({
      abi: ballastFactoryAbi,
      functionName: "launches",
      data: REAL_PRIOR_FACTORY_LAUNCHES_0_RESPONSE,
    }) as readonly [string, string, string];

    expect(token.toLowerCase()).toBe(BALLAST_TOKEN_ADDRESS.toLowerCase());
    expect(treasury.toLowerCase()).toBe(BALLAST_TREASURY_ADDRESS.toLowerCase());
    expect(creator.toLowerCase()).toBe(BALLAST_CREATOR_ADDRESS.toLowerCase());
  });

  it("declares exactly 3 outputs — widening this breaks decoding for every already-deployed factory", () => {
    const entry = ballastFactoryAbi.find(
      (item) => item.type === "function" && item.name === "launches",
    );
    expect(entry).toBeDefined();
    expect((entry as unknown as { outputs: unknown[] }).outputs).toHaveLength(3);
  });
});

describe("ballastFactoryAbi.launch — write calldata must match the currently-deployed selector", () => {
  it("encodes with exactly 4 args (no quoteAsset_) — the deployed factory has no 5-arg overload", () => {
    // encodeFunctionData throws if the arg count/types don't match the ABI's
    // declared inputs, so this alone proves the ABI still expects 4 args. The
    // stronger, on-chain-simulated proof (this exact calldata succeeds against
    // the live factory; a 5-arg version reverts with no selector match) was
    // run manually via `cast call` against the real deployed contract during
    // triage and isn't repeated here since it needs network access this test
    // suite doesn't have.
    const data = encodeFunctionData({
      abi: ballastFactoryAbi,
      functionName: "launch",
      args: ["Name", "SYM", 604800n, "ipfs://x"],
    });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });
});
