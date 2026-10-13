// BasketZap — contracts/src/BasketZap.sol. Feature-local ABI (same convention
// as ballastV1ClaimAbi in hooks/useV1Claim.ts), shared by useBasket.ts and
// useBasketRunner.ts.
// REWRITE (docs/DECISIONS.md §6): BasketZap now routes each leg over Fables or
// Ramses via index into its own fixed hop tables (not a caller-supplied
// fee/tickSpacing/hooks PoolKey). The Leg struct carries `preferFables` + the
// `fablesHopIdx`/`ramsesHopIdx` the frontend builds from web/lib/routerV2.ts,
// and swapBasket returns `usedFables` per leg alongside `amountsOut`.
export const basketZapAbi = [
  {
    type: "function",
    name: "swapBasket",
    stateMutability: "payable",
    inputs: [
      { name: "launchToken", type: "address" },
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "asset", type: "address" },
          { name: "weightBps", type: "uint16" },
          { name: "preferFables", type: "bool" },
          { name: "fablesHopIdx", type: "uint256[]" },
          { name: "ramsesHopIdx", type: "uint256[]" },
          { name: "minOut", type: "uint256" },
        ],
      },
      { name: "swapDeadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountsOut", type: "uint256[]" },
      { name: "usedFables", type: "bool[]" },
    ],
  },
  { type: "function", name: "MAX_LEGS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "BasketSwapped",
    inputs: [
      { name: "launchToken", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "ethIn", type: "uint256", indexed: false },
      { name: "ethRefunded", type: "uint256", indexed: false },
      { name: "assets", type: "address[]", indexed: false },
      { name: "weightsBps", type: "uint16[]", indexed: false },
      { name: "amountsOut", type: "uint256[]", indexed: false },
      { name: "usedFables", type: "bool[]", indexed: false },
    ],
  },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "NotCreator", inputs: [] },
  { type: "error", name: "UnknownLaunch", inputs: [] },
  { type: "error", name: "NoLegs", inputs: [] },
  { type: "error", name: "TooManyLegs", inputs: [] },
  { type: "error", name: "WeightsMustSumToBps", inputs: [] },
  { type: "error", name: "DuplicateAsset", inputs: [{ type: "address" }] },
  { type: "error", name: "SelfBacking", inputs: [{ type: "address" }] },
  { type: "error", name: "ZeroEthIn", inputs: [] },
  { type: "error", name: "SwapDeadlineExpired", inputs: [] },
  { type: "error", name: "AssetNotAllowed", inputs: [{ type: "address" }] },
  { type: "error", name: "InvalidPrice", inputs: [{ type: "address" }] },
  { type: "error", name: "StalePrice", inputs: [{ type: "address" }, { type: "uint256" }] },
  {
    type: "error",
    name: "PriceDeviationTooLarge",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "error", name: "MinOutTooLow", inputs: [] },
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
  },
  // New in the V4Router rewrite (docs/DECISIONS.md §6).
  { type: "error", name: "AllVenuesFailedForLeg", inputs: [{ type: "address" }] },
  { type: "error", name: "NoRamsesRoute", inputs: [] },
  { type: "error", name: "BadHopChain", inputs: [] },
  { type: "error", name: "NotSelf", inputs: [] },
] as const;
