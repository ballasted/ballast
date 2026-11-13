// Event-only ABIs for indexing. Kept in sync with contracts/src.

export const ballastFactoryAbi = [
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
    type: "event",
    name: "Graduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: false },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "backingUsd1e18", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ballastTokenAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
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

export const projectTreasuryAbi = [
  { type: "event", name: "CreatorDeposited", inputs: [{ name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
  { type: "event", name: "DepositAccepted", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "depositor", type: "address", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
  { type: "event", name: "WithdrawalAnnounced", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256" }, { name: "unlockAt", type: "uint64" }] },
  { type: "event", name: "WithdrawalExecuted", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
  { type: "event", name: "WithdrawalCancelled", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
] as const;

export const ballastHookAbi = [
  {
    type: "event",
    name: "FeeTaken",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "feeWeth", type: "uint256", indexed: false },
      { name: "creator", type: "address", indexed: false },
      { name: "platform", type: "address", indexed: false },
      { name: "referrer", type: "address", indexed: false },
    ],
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

// ─────────────────────────────────────────────────────────────────────────────
// Gen-5 (Elysium, chain 99901). WHOLLY SEPARATE contracts from gen-4 — topic0
// differs, so these must NOT reuse the gen-4 ABIs. Signatures mirror
// contracts/src/elysium/*.sol exactly.
// ─────────────────────────────────────────────────────────────────────────────

export const ballastFactoryV5Abi = [
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "feeRouter", type: "address", indexed: false },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "swapFeeBps", type: "uint16", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Graduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "openTick", type: "int24", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ballastHookV5Abi = [
  {
    type: "event",
    name: "FeeTaken",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteAsset", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
      { name: "creatorSide", type: "address", indexed: false },
      { name: "creatorCut", type: "uint256", indexed: false },
      { name: "protocol", type: "address", indexed: false },
      { name: "protocolCut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PoolFeeSet",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "feeBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Place",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "zeroForOne", type: "bool", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Cancel",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "liquidity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Fill",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "zeroForOne", type: "bool", indexed: false },
      { name: "token0", type: "uint256", indexed: false },
      { name: "token1", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
] as const;

export const feeRouterV5Abi = [
  {
    type: "event",
    name: "Routed",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "total", type: "uint256", indexed: false },
      { name: "toCreator", type: "uint256", indexed: false },
      { name: "toBuyback", type: "uint256", indexed: false },
      { name: "toRewards", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoutedToBuyback",
    inputs: [
      { name: "whypeIn", type: "uint256", indexed: false },
      { name: "tokenBought", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SplitScheduled",
    inputs: [
      { name: "creatorBps", type: "uint16", indexed: false },
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
      { name: "buybackBps", type: "uint16", indexed: false },
      { name: "rewardsBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SplitAppliedInstant",
    inputs: [
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "buybackBps", type: "uint16", indexed: false },
      { name: "rewardsBps", type: "uint16", indexed: false },
      { name: "cancelledPending", type: "bool", indexed: false },
    ],
  },
] as const;

export const protocolFeeVaultAbi = [
  {
    type: "event",
    name: "Collected",
    inputs: [
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Forwarded",
    inputs: [
      { name: "currency", type: "address", indexed: true },
      { name: "destination", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ballastSeederV5Abi = [
  {
    type: "event",
    name: "Seeded",
    inputs: [
      { name: "token", type: "address", indexed: true },
      {
        name: "key",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false },
    ],
  },
] as const;

// Uniswap v4 PoolManager Swap (singleton). We index all swaps and keep only those
// whose pool id maps to a BALLAST pool (see the Graduated handler). Reused by the
// gen-5 Elysium PoolManager — same event shape.
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
