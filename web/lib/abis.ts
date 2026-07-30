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
    // token => id+1 (0 = this factory never launched it). The O(1) ownership test:
    // a token belongs to whichever factory returns non-zero here (see useProjectFactory).
    type: "function",
    name: "launchIdOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "noticePeriod", type: "uint256" },
      { name: "metadataURI", type: "string" },
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
] as const;
