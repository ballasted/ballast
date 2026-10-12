// BasketZap — contracts/src/BasketZap.sol. Feature-local ABI (same convention
// as ballastV1ClaimAbi in hooks/useV1Claim.ts), shared by useBasket.ts and
// useBasketRunner.ts.
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
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
          { name: "minOut", type: "uint256" },
        ],
      },
      { name: "swapDeadline", type: "uint256" },
    ],
    outputs: [{ name: "amountsOut", type: "uint256[]" }],
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
] as const;
