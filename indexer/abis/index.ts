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

// Uniswap v4 PoolManager Swap (singleton). We index all swaps and keep only those
// whose pool id maps to a BALLAST pool (see the Graduated handler).
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
