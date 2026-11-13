// Gen-5 (Elysium) contract ABIs — hand-authored from contracts/src/elysium/*.sol.
// These are DISTINCT from the gen-4 ABIs in lib/abis.ts: gen-5 has no treasury, a
// creator-picked per-pool fee, a 3-bucket FeeRouterV5, a ProtocolFeeVault, and
// on-chain range-order limit orders on the hook. Event signatures differ (different
// topic0) so the gen-4 decoders will NOT match gen-5 logs.
//
// Only the members the frontend / indexer / bot actually use are included; keep in
// sync with the sources if those contracts change.

// ─── BallastFactoryV5 ─────────────────────────────────────────────────────────
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
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "swapFeeBps", type: "uint16" },
      { name: "metadataURI", type: "string" },
      { name: "quoteAsset", type: "address" },
      { name: "initialCreatorBps", type: "uint16" },
      { name: "initialBuybackBps", type: "uint16" },
      { name: "initialRewardsBps", type: "uint16" },
    ],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "token", type: "address" },
      { name: "feeRouter", type: "address" },
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
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "feeRouter", type: "address" },
      { name: "creator", type: "address" },
      { name: "quoteAsset", type: "address" },
      { name: "swapFeeBps", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "launchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "launchIdOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "graduated",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "quoteAssetOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "swapFeeBpsOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "isGreenQuoteAsset",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "minFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "maxFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "hook",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "whype",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ─── BallastHookV5 (fees + limit orders) ──────────────────────────────────────
// PoolKey tuple reused by place/cancel.
const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
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
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poolFeeBps",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "place",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "tickLower", type: "int24" },
      { name: "zeroForOne", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [{ name: "epoch", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "tickLower", type: "int24" },
      { name: "zeroForOne", type: "bool" },
      { name: "to", type: "address" },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "poke",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "tuple", components: poolKeyComponents }],
    outputs: [],
  },
  {
    type: "function",
    name: "epochOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "epochLiquidity",
    stateMutability: "view",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "epochInfo",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint256" }],
    outputs: [
      { name: "filled", type: "bool" },
      { name: "token0Total", type: "uint256" },
      { name: "token1Total", type: "uint256" },
      { name: "liquidityTotal", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "protocolFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

// ─── FeeRouterV5 (per-launch; 3-bucket creator/buyback/rewards) ────────────────
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
  {
    type: "function",
    name: "route",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wantAmount", type: "uint256" },
      { name: "minBuybackOut", type: "uint256" },
    ],
    outputs: [{ name: "routedAmount", type: "uint256" }],
  },
  {
    type: "function",
    name: "scheduleSplit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "creatorBps_", type: "uint16" },
      { name: "buybackBps_", type: "uint16" },
      { name: "rewardsBps_", type: "uint16" },
    ],
    outputs: [],
  },
  { type: "function", name: "applySplit", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "realCreator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "stakingVault", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "buybackBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "rewardsBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "hasPendingSplit", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "pendingCreatorBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "pendingBuybackBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "pendingRewardsBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "totalRoutedToCreator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalRoutedToBuyback", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalRoutedToRewards", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalTokenBurned", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "readyAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

// ─── ProtocolFeeVault (protocol 20% sink; "sweep" = collect + forward) ─────────
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
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "forward",
    stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "sweep",
    stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }],
    outputs: [{ name: "forwarded", type: "uint256" }],
  },
  { type: "function", name: "destination", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

// ─── BallastSeederV5 (one-sided LP seeder) ────────────────────────────────────
export const ballastSeederV5Abi = [
  {
    type: "event",
    name: "Seeded",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "key", type: "tuple", components: poolKeyComponents, indexed: false },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false },
    ],
  },
] as const;
