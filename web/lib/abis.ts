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
] as const;
