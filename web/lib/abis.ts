// Minimal ABIs for the UI reads. Kept in sync with contracts/src.

export const backingLensAbi = [
  {
    type: "function",
    name: "backingOf",
    stateMutability: "view",
    inputs: [{ name: "treasuryAddr", type: "address" }],
    outputs: [
      {
        name: "b",
        type: "tuple",
        components: [
          { name: "sequencerStatus", type: "uint8" }, // 0 Unknown 1 Up 2 Grace 3 Down
          { name: "totalSupply", type: "uint256" },
          { name: "lockedValueUsd", type: "uint256" },
          { name: "withdrawableValueUsd", type: "uint256" },
          { name: "totalValueUsd", type: "uint256" },
          { name: "backingPerToken", type: "uint256" },
          { name: "lockedBackingPerToken", type: "uint256" },
          { name: "anyStale", type: "bool" },
          { name: "anyUnpriced", type: "bool" },
          {
            name: "assets",
            type: "tuple[]",
            components: [
              { name: "asset", type: "address" },
              { name: "lockedBalance", type: "uint256" },
              { name: "withdrawableBalance", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "priceDecimals", type: "uint8" },
              { name: "assetDecimals", type: "uint8" },
              { name: "updatedAt", type: "uint256" },
              { name: "marketHours", type: "uint8" }, // 0 Unknown 1 UsEquities24_5 2 Crypto24_7
              { name: "lockedValueUsd", type: "uint256" },
              { name: "withdrawableValueUsd", type: "uint256" },
              { name: "priced", type: "bool" },
              { name: "stale", type: "bool" },
              { name: "oraclePaused", type: "bool" },
            ],
          },
        ],
      },
    ],
  },
] as const;

export const projectTreasuryAbi = [
  {
    type: "function",
    name: "projectToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "creator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "noticePeriod",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingWithdrawal",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "unlockAt", type: "uint64" },
    ],
  },
  {
    // Creator's own deposits still available to withdraw (deposited via
    // deposit(), never a third-party proposeDeposit/acceptDeposit — those are
    // permanently locked in lockedBalance instead and can never move here).
    type: "function",
    name: "creatorWithdrawable",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activeWithdrawalId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Announce intent to withdraw a creator deposit — starts the public,
    // immutable noticePeriod countdown. Only one withdrawal may be active at a
    // time; amount must not exceed creatorWithdrawable(asset).
    type: "function",
    name: "announceWithdrawal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    // Reverts if block.timestamp < unlockAt — the notice period is the whole
    // point, enforced on-chain, not just in the UI.
    type: "function",
    name: "executeWithdrawal",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    // Can cancel at ANY time before execution — no notice-period restriction
    // on cancelling (contracts/src/ProjectTreasury.sol).
    type: "function",
    name: "cancelWithdrawal",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// BallastHook — the singleton v4 hook that skims the 1% WETH swap fee and accrues
// it per RECIPIENT (creator / platform vault / referrer) in `owed`. Distribution is
// pull-not-push: each recipient calls `claim()` to sweep their OWN balance. `owed`
// is keyed by address, not by token, so a creator's balance is the sum across all
// their launches and one claim() takes all of it. The platform vault claims via the
// exact same path (whoever controls that address calls claim()).
export const ballastHookAbi = [
  {
    // Immutable per hook generation — never reassignable. Used to find WHICH
    // FeeConfig instance governs a given launch's pool (there are two live
    // instances across generations — see docs/PROTOCOL_CONTROLS.md).
    type: "function",
    name: "feeConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // Non-WETH quote-asset fees (e.g. NVDA) — gen-4+ hooks only. Older hooks simply
  // lack this function; reads/writes against them fail and are ignored
  // (allowFailure), never assumed to be zero-by-design vs. unsupported.
  {
    type: "function",
    name: "owedIn",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimIn",
    stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "ClaimedIn",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// WETH — on this chain WETH is an ERC-20 (18 dec) and the pools are token/WETH,
// but wallets hold NATIVE ETH. A buy therefore wraps ETH → WETH first (deposit is
// payable and mints WETH 1:1 for the ETH sent). Pulling that WETH into the swap
// still goes through Permit2 (see useSwap). `withdraw` unwraps back to ETH.
export const wethAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

// MetadataDenylist — owner-managed, default-ALLOW display takedown. The UI reads
// `deniedTokens()` once to know which tokens' project-supplied metadata (name,
// logo, description, links) to withhold, and `entryOf()` for the public reason on a
// suppressed token's page. It is a display control only — the token stays listed by
// ticker + address, and its raw metadataURI stays readable on-chain.
export const metadataDenylistAbi = [
  {
    type: "function",
    name: "deniedTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "isDenied",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "entryOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "denied", type: "bool" },
      { name: "updatedAt", type: "uint64" },
      { name: "reason", type: "string" },
    ],
  },
] as const;

// ── BallastFactory ──────────────────────────────────────────────────────────
// The launch registry (the ONLY per-launch address source — never hardcode).
export const ballastFactoryAbi = [
  {
    type: "function",
    name: "launchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Constant opening tick for UNBACKED launches — a public constant on the deployed
    // factory. price = 1.0001^tick WETH/token, so FDV = price × TOTAL_SUPPLY. Read
    // live so the create flow states a number, not a description (opening ≈ 1 ETH).
    type: "function",
    name: "UNBACKED_TICK",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24" }],
  },
  {
    // Declares only the first 3 fields on PURPOSE, even though the newer contract
    // source has a 4th (quoteAssets, an address[] — appended last). Solidity's
    // auto-generated public getter for a struct with a dynamic-array member
    // OMITS that member from the returned tuple entirely (not "returns it
    // last" — it genuinely isn't in the ABI-encoded return data), so decoding
    // only 3 fields here isn't a compatibility shim, it's the actual shape of
    // EVERY factory's `launches(id)` return, old or new. FACTORY_ADDRESSES is a
    // union of factories deployed at different times (see lib/contracts.ts) —
    // this shared ABI is correct for all of them unchanged. To read a launch's
    // quote assets, use `quoteAssetsOf(token)` below (only present on
    // multi-quote-asset-capable factories — call with allowFailure per-factory,
    // never assume every factory in FACTORY_ADDRESSES has it).
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "treasury", type: "address" },
      { name: "creator", type: "address" },
    ],
  },
  {
    type: "function",
    name: "graduated",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    // Immutable BallastSeeder singleton this factory graduates through — it is
    // the LP position OWNER for every pool this factory ever seeds (v4 identifies
    // a position by (poolId, owner, tickLower, tickUpper, salt), salt=0 always
    // here). A per-generation value, same shape as HOOK_ADDRESS/FACTORY_ADDRESS —
    // read it live from each factory rather than tracking it in env, since it's
    // already a public getter and this avoids one more historical address to keep
    // in sync by hand (see lib/seededPosition.ts).
    type: "function",
    name: "seeder",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    // token => id+1 (0 = this factory never launched it). The O(1) ownership test:
    // a token belongs to whichever factory returns non-zero here (see useProjectFactory).
    type: "function",
    name: "launchIdOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    // The quote asset(s) a launch's pool(s) are/will be paired against — only
    // present on a multi-quote-asset-capable factory (see contracts/src/
    // BallastFactory.sol's quoteAssetsOf). A PRIOR factory in FACTORY_ADDRESSES
    // predating this function will simply fail this call — callers MUST use
    // allowFailure per-factory (multicall) rather than assume every factory
    // union member has it, exactly like `graduated`/`launchIdOf` already do.
    type: "function",
    name: "quoteAssetsOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    // Deploy-time-fixed allowlist of non-WETH quote assets this factory accepts
    // in launch()'s quoteAssets_ array (see docs/exit-liquidity-table.md — never
    // owner-settable post-deploy, promoting one is a re-run of that external-
    // liquidity judgment). WETH itself isn't in this mapping — it's always
    // valid separately, read from the `weth` immutable below.
    type: "function",
    name: "isGreenQuoteAsset",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "weth",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "MAX_QUOTE_ASSETS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // ⚠️ DO NOT DEPLOY/PUSH-LIVE THIS 5-ARG SHAPE UNTIL A FACTORY WITH IT IS
    // ACTUALLY DEPLOYED AND FACTORY_ADDRESS IS REPOINTED AT IT. Every write
    // always targets FACTORY_ADDRESS (lib/contracts.ts) — there is exactly one
    // live shape that matters at any time, and while FACTORY_ADDRESS still
    // points at a 4-arg (no quoteAssets_) factory, THIS ABI MUST STILL DECLARE
    // 4 ARGS, or every real launch() call gets a wrong-selector revert with no
    // reason (2026-09-16 incident: this exact mistake broke Discover/create for
    // everyone). This 5-arg version is prepared ahead of the next factory
    // redeploy — widen this (already done) together with useLaunchRunner.ts's
    // call site (already done) AND the FACTORY_ADDRESS env var update, as ONE
    // atomic change, never as three separate ones landing at different times.
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "noticePeriod", type: "uint256" },
      { name: "metadataURI", type: "string" },
      { name: "quoteAssets_", type: "address[]" },
    ],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "token", type: "address" },
      { name: "treasury", type: "address" },
    ],
  },
  {
    type: "function",
    name: "graduate",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: false },
      { name: "noticePeriod", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    // Dropped `tickLower` vs the prior factory's Graduated (no longer a single
    // meaningful value once one graduation can seed several pools at once, each
    // with its own tick) — a PRIOR factory in FACTORY_ADDRESSES still emits the
    // OLD 4-field shape on-chain; decoding it against this 3-field ABI is safe
    // (extra trailing log data is simply ignored by viem's event decoder,
    // matched by name/position from the front, same "fewer fields is safe"
    // rule as `launches` above) — but never widen this back to 4 assuming
    // every factory's Graduated matches, since a NEW factory genuinely doesn't
    // have tickLower on-chain at all.
    type: "event",
    name: "Graduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: false },
      { name: "backingUsd1e18", type: "uint256", indexed: false },
    ],
  },
  {
    // Per-quote-asset pool-creation record — the only way to enumerate a
    // token's pools, since v4 has no canonical "all pools for this token"
    // lookup (PoolManager is a singleton keyed by the full PoolKey). Only
    // emitted by a multi-quote-asset-capable factory.
    type: "event",
    name: "PoolSeeded",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteAsset", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "openTick", type: "int24", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// v4 PoolManager — the singleton every pool lives in. Only the Swap event, used
// by the live rail's "large buys" feed: ONE watch/backfill covers every pool on
// the chain (ours and anyone else's), filtered client-side to our known pool ids
// (contracts/src, v4-core's IPoolManager.sol).
export const poolManagerAbi = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

// ── FeeConfig ─────────────────────────────────────────────────────────────────
// Owner-settable global fee + split, read LIVE (CLAUDE.md: never hardcode economic
// parameters). One config serves every pool. Split legs: creator / platform /
// referrer, all out of 10_000 bps.
export const feeConfigAbi = [
  {
    type: "function",
    name: "feeParams",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "feeBps", type: "uint16" },
      { name: "creatorBps", type: "uint16" },
      { name: "platformBps", type: "uint16" },
      { name: "referrerBps", type: "uint16" },
      { name: "platformVault", type: "address" },
    ],
  },
  {
    // Ownable2Step — a two-step transfer (new owner must accept), not a delay.
    // See docs/PROTOCOL_CONTROLS.md for the plan to move this to a timelock.
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// Minimal OpenZeppelin TimelockController surface — just enough to detect
// "is this owner actually a timelock" and show its delay. See
// docs/PROTOCOL_CONTROLS.md: pending-operation detection needs CallScheduled
// event history, which this RPC's free tier can't scan (10-block eth_getLogs
// cap) — deliberately NOT attempted here rather than faked.
export const timelockAbi = [
  {
    type: "function",
    name: "getMinDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ── AssetRegistry ─────────────────────────────────────────────────────────────
export const assetRegistryAbi = [
  {
    type: "function",
    name: "allowedAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "assetConfig",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "allowed", type: "bool" },
      { name: "feed", type: "address" },
      { name: "staleAfter", type: "uint256" },
      { name: "minDeposit", type: "uint256" },
      { name: "marketHours", type: "uint8" },
    ],
  },
] as const;

// ProjectTreasury write surface (creator-side deposits/withdrawals).
export const projectTreasuryWriteAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "assets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "heldBalance",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// BallastToken — treasury pointer + project metadata (launch identity permanent,
// current URI updatable by the creator with a public MetadataUpdated log).
export const ballastTokenAbi = [
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "creator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "metadataURI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "launchMetadataURI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "metadataChanged",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setMetadataURI",
    stateMutability: "nonpayable",
    inputs: [{ name: "newURI", type: "string" }],
    outputs: [],
  },
  {
    type: "event",
    name: "MetadataUpdated",
    inputs: [
      { name: "oldURI", type: "string", indexed: false },
      { name: "newURI", type: "string", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// Chainlink feed — for the live backing-per-token preview in the create flow.
export const aggregatorV3Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

// Permit2 — the UniversalRouter pulls ERC-20 inputs through Permit2, so a swap
// needs a Permit2 allowance (allowance() to read, approve() to grant), on top of a
// one-time ERC-20 approve of the token TO Permit2.
export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

// v4 Quoter — off-chain quote for exact-in single-hop. NOTE: on this chain the
// stock Quoter works for READS (it does not carry the router's minHopPriceX36),
// so we use it only to estimate output; the SWAP itself goes through the forked
// UniversalRouter with the extra field (see lib/swap.ts).
export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// BallastRouterV2 — ETH <-> quoteAsset (Fables or Ramses) <-> our own v4 pool,
// single PoolManager.unlock() per call, on-chain fallback to the other venue.
// See contracts/src/BallastRouterV2.sol.
export const ballastRouterV2Abi = [
  {
    type: "function",
    name: "buyWithETH",
    stateMutability: "payable",
    inputs: [
      { name: "fablesHopIdx", type: "uint256[]" },
      { name: "ramsesHopIdx", type: "uint256[]" },
      { name: "preferFables", type: "bool" },
      { name: "quoteAsset", type: "address" },
      { name: "ballastToken", type: "address" },
      { name: "hook", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "out", type: "uint256" },
      { name: "usedFables", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "sellToETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ballastToken", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "quoteAsset", type: "address" },
      { name: "hook", type: "address" },
      { name: "fablesHopIdx", type: "uint256[]" },
      { name: "ramsesHopIdx", type: "uint256[]" },
      { name: "preferFables", type: "bool" },
      { name: "minOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "out", type: "uint256" },
      { name: "usedFables", type: "bool" },
    ],
  },
] as const;

// v4Quoter.quoteExactInput — multi-hop, used to quote the Fables leg (ETH ->
// USDG -> ... -> quoteAsset) at the user's actual trade size.
export const quoterMultiHopAbi = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "currencyIn", type: "address" },
          {
            name: "path",
            type: "tuple[]",
            components: [
              { name: "intermediateCurrency", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
              { name: "hookData", type: "bytes" },
            ],
          },
          { name: "minHopPriceX36", type: "uint256[]" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// Ramses v3 QuoterV2 — tickSpacing-keyed (not fee-tier), same ABI shape as
// Uniswap v3's QuoterV2 otherwise. Used to quote the Ramses leg at the user's
// actual trade size, same venue BallastRouterV2's Ramses hops execute against.
export const ramsesQuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// v4 StateView — pool spot price via getSlot0(poolId).
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ type: "uint128" }],
  },
  {
    // Raw v4 tick-initialized bitmap word (see lib/seededPosition.ts) — used to
    // find a seeded position's real tickLower/tickUpper without needing the
    // Seeded/PoolSeeded event log (blocked in this environment by the RPC's
    // free-tier eth_getLogs range cap, confirmed 2026-09-25).
    type: "function",
    name: "getTickBitmap",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "wordPos", type: "int16" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    // The actual LP position's live liquidity — correct at every price, unlike
    // getLiquidity(poolId) (the pool-wide ACTIVE liquidity), which reads 0 when
    // the current tick sits exactly on the position's boundary (the half-open
    // tick-range artifact — confirmed on real graduated pools 2026-09-25).
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
] as const;

// ── Fee Router (contracts/src/FeeRouter.sol, FeeRouterFactory.sol,
//    HolderStakingVault.sol) — see docs/FEE_ROUTER_DESIGN.md. ──────────────
const poolKeyComponent = {
  name: "key",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

export const feeRouterAbi = [
  { type: "function", name: "realCreator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "wired", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "stakingVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasuryAsset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "buybackWired", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pendingBuybackWeth", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "buybackBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "rewardsBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "hasPendingSplit", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pendingCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "pendingTreasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "pendingBuybackBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "pendingRewardsBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "pendingEffectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "lastRouteAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "readyAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRoutedToCreator", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRoutedToTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalTreasuryAssetDeposited", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRoutedToBuyback", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalTokenBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRoutedToRewards", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "scheduleSplit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "creatorBps_", type: "uint16" },
      { name: "treasuryBps_", type: "uint16" },
      { name: "buybackBps_", type: "uint16" },
      { name: "rewardsBps_", type: "uint16" },
    ],
    outputs: [],
  },
  { type: "function", name: "applySplit", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "route",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wantAmount", type: "uint256" },
      { name: "minTreasuryOut", type: "uint256" },
      { name: "minBuybackOut", type: "uint256" },
    ],
    outputs: [{ name: "routedAmount", type: "uint256" }],
  },
  { type: "function", name: "wireBuybackPool", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "creatorDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "flushDeferredBuyback",
    stateMutability: "nonpayable",
    inputs: [{ name: "minOut", type: "uint256" }],
    outputs: [{ name: "bought", type: "uint256" }],
  },
  {
    type: "function",
    name: "adopt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token_", type: "address" },
      { name: "treasury_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setMetadataURI",
    stateMutability: "nonpayable",
    inputs: [{ name: "newURI", type: "string" }],
    outputs: [],
  },
  {
    type: "event",
    name: "Wired",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: true },
      { name: "stakingVault", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SplitScheduled",
    inputs: [
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "treasuryBps", type: "uint16", indexed: false },
      { name: "buybackBps", type: "uint16", indexed: false },
      { name: "rewardsBps", type: "uint16", indexed: false },
      { name: "effectiveAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SplitApplied",
    inputs: [
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "treasuryBps", type: "uint16", indexed: false },
      { name: "buybackBps", type: "uint16", indexed: false },
      { name: "rewardsBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Routed",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "total", type: "uint256", indexed: false },
      { name: "toCreator", type: "uint256", indexed: false },
      { name: "toTreasury", type: "uint256", indexed: false },
      { name: "toBuyback", type: "uint256", indexed: false },
      { name: "toRewards", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoutedToTreasury",
    inputs: [
      { name: "wethIn", type: "uint256", indexed: false },
      { name: "assetOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoutedToBuyback",
    inputs: [
      { name: "wethIn", type: "uint256", indexed: false },
      { name: "tokenBought", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "RoutedToRewards", inputs: [{ name: "amount", type: "uint256", indexed: false }] },
] as const;

export const holderStakingVaultAbi = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "rewardCurrency", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "router", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalStaked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "totalRewardsNotified", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "stake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "amount", type: "uint256" }] },
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unstaked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardNotified",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
      { name: "folded", type: "bool", indexed: false },
      { name: "carriedPending", type: "uint256", indexed: false },
    ],
  },
] as const;

export const feeRouterFactoryAbi = [
  {
    type: "function",
    name: "createAndLaunch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hook", type: "address" },
      { name: "weth", type: "address" },
      { name: "poolManager", type: "address" },
      { name: "treasuryAsset", type: "address" },
      { ...poolKeyComponent, name: "treasuryPoolKey" },
      { name: "registry", type: "address" },
      { name: "maxSlippageBps", type: "uint16" },
      { name: "maxRoutePerCall", type: "uint256" },
      { name: "routeCooldown", type: "uint256" },
      { name: "disclosureVersion", type: "bytes32" },
      { name: "factory", type: "address" },
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "noticePeriod", type: "uint256" },
      { name: "metadataURI", type: "string" },
      { name: "quoteAssets_", type: "address[]" },
    ],
    outputs: [
      { name: "router", type: "address" },
      { name: "token", type: "address" },
      { name: "treasury", type: "address" },
    ],
  },
  {
    type: "function",
    name: "createForExisting",
    stateMutability: "nonpayable",
    inputs: [
      { name: "realCreator", type: "address" },
      { name: "hook", type: "address" },
      { name: "weth", type: "address" },
      { name: "poolManager", type: "address" },
      { name: "treasuryAsset", type: "address" },
      { ...poolKeyComponent, name: "treasuryPoolKey" },
      { name: "registry", type: "address" },
      { name: "maxSlippageBps", type: "uint16" },
      { name: "maxRoutePerCall", type: "uint256" },
      { name: "routeCooldown", type: "uint256" },
      { name: "disclosureVersion", type: "bytes32" },
      { name: "factory", type: "address" },
    ],
    outputs: [{ name: "router", type: "address" }],
  },
  {
    type: "event",
    name: "FeeRouterCreated",
    inputs: [
      { name: "router", type: "address", indexed: true },
      { name: "realCreator", type: "address", indexed: true },
    ],
  },
] as const;

// Open Treasury — contracts/src/OpenTreasuryVault{,Factory}.sol, OpenTreasuryLens.sol.
export const openTreasuryVaultFactoryAbi = [
  {
    type: "function",
    name: "getOrCreateVault",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "vaultFor",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
    ],
  },
] as const;

export const openTreasuryVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "notifyReward",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sync",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "added", type: "uint256" }],
  },
  {
    type: "function",
    name: "earned",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "principal",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingWithdrawAt",
    stateMutability: "view",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "assets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "assetsOf",
    stateMutability: "view",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  { type: "function", name: "minHoldTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rewardsDuration", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rewardAsset", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "periodFinish", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rewardRate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalWeight", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalRewardDeposited", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalRewardClaimed", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "totalPrincipal",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "weight", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "weightRemoved", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardAdded",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
      { name: "rewardRate", type: "uint256", indexed: false },
      { name: "periodFinish", type: "uint256", indexed: false },
    ],
  },
] as const;

export const openTreasuryLensAbi = [
  {
    type: "function",
    name: "combinedBackingOf",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "vaultFactory", type: "address" },
    ],
    outputs: [
      {
        name: "c",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "treasury", type: "address" },
          { name: "vault", type: "address" },
          { name: "creatorFundedUsd", type: "uint256" },
          { name: "creatorFundedOk", type: "bool" },
          { name: "creatorFundedAnyStale", type: "bool" },
          { name: "communityWithdrawableUsd", type: "uint256" },
          { name: "communityAnyStale", type: "bool" },
          { name: "communityAnyUnpriced", type: "bool" },
          { name: "combinedTotalUsd", type: "uint256" },
          {
            name: "communityAssets",
            type: "tuple[]",
            components: [
              { name: "asset", type: "address" },
              { name: "balance", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "priceDecimals", type: "uint8" },
              { name: "assetDecimals", type: "uint8" },
              { name: "updatedAt", type: "uint256" },
              { name: "valueUsd", type: "uint256" },
              { name: "priced", type: "bool" },
              { name: "stale", type: "bool" },
            ],
          },
        ],
      },
    ],
  },
] as const;

// Ramses' own canonical RamsesLocker — not a Ballast contract, so only the
// handful of functions/events we actually call are declared here (see
// contracts/lib/ramses-v3-contracts/contracts/RamsesLocker.sol for the full
// vendored source used to verify the real deployment).
export const ramsesLockerAbi = [
  {
    type: "function",
    name: "pendingFees",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "feeReceiverOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "poolOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isLocked",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "feeReceiver", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ramsesLockLauncherAbi = [
  {
    type: "function",
    name: "createAndLock",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "legs",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "launchedToken", type: "address" },
      { name: "creatorRecipient", type: "address" },
      { name: "creatorBps", type: "uint16" },
      { name: "protocolBps", type: "uint16" },
      { name: "expectedSqrtPriceX96", type: "uint160" },
      { name: "maxPriceDeviationBps", type: "uint16" },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "splitter", type: "address" },
    ],
  },
  {
    type: "event",
    name: "CreatedAndLocked",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "splitter", type: "address", indexed: true },
      { name: "launchedToken", type: "address", indexed: true },
      { name: "token0", type: "address", indexed: false },
      { name: "token1", type: "address", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
      { name: "creatorRecipient", type: "address", indexed: false },
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "protocolBps", type: "uint16", indexed: false },
    ],
  },
] as const;

export const ballastFeeSplitterAbi = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "locker", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "positionId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "creatorRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "protocolRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "protocolBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [{ name: "token_", type: "address" }],
    outputs: [
      { name: "toCreator", type: "uint256" },
      { name: "toProtocol", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Distributed",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "toCreator", type: "uint256", indexed: false },
      { name: "toProtocol", type: "uint256", indexed: false },
      { name: "creatorPending", type: "uint256", indexed: false },
      { name: "protocolPending", type: "uint256", indexed: false },
    ],
  },
] as const;

// Ramses' own RamsesV3Factory / pool — minimal, only what the create flow needs
// to find or create a pool at the fixed 1% tier (tickSpacing 100).
export const ramsesV3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

export const ramsesV3PoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint24" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;
