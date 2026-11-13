import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { config as loadEnv } from "dotenv";
import {
  ballastFactoryAbi,
  ballastTokenAbi,
  projectTreasuryAbi,
  ballastHookAbi,
  poolManagerAbi,
  ballastFactoryV5Abi,
  ballastHookV5Abi,
  feeRouterV5Abi,
  protocolFeeVaultAbi,
  ballastSeederV5Abi,
} from "./abis";

// DATABASE_URL, PONDER_RPC_URL_4663 live in the repo-root .env (single source;
// Foundry reads the same file). Ponder picks DATABASE_URL off process.env.
loadEnv({ path: "../.env" });

// Verified live mainnet addresses (probed on-chain / Blockscout, 2026-07).
const FACTORY = "0x069974136c78Cf0F2162463B95321E59F56523D8";
const HOOK = "0x9C15c992E4De3711715C8B7D717EF46e474680CC";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

// Factory deployment block (creation tx 0xdf14…cdc1, Blockscout). Backfilling from
// here catches every launch AND — via the factory() pattern below — every child
// token/treasury and its pool, missing nothing. Env override allowed but this is
// the correct anchor; do not raise it above the deploy block or early launches
// are lost.
const START_BLOCK = process.env.PONDER_START_BLOCK
  ? Number(process.env.PONDER_START_BLOCK)
  : 17514129;

// Prefer a dedicated indexer RPC; fall back to the Alchemy URL you already keep in
// RH_RPC_URL_PAID (so it isn't duplicated), then the public RPC as a last resort.
const RPC =
  process.env.PONDER_RPC_URL_4663 ||
  process.env.RH_RPC_URL_PAID ||
  "https://rpc.mainnet.chain.robinhood.com";

const launched = getAbiItem({ abi: ballastFactoryAbi, name: "Launched" });

// ── Gen-5 Elysium (chain 99901) ────────────────────────────────────────────────
// Wholly separate deployment from gen-4 on Robinhood Chain. Verified live addresses
// (2026-11). NO treasury on Elysium. feeRouter is PER-LAUNCH, discovered from the
// factory's Launched event via the factory() pattern below.
const ELYSIUM_FACTORY = "0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE";
const ELYSIUM_HOOK = "0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc";
const ELYSIUM_SEEDER = "0x1A2b1e5361a5f1cc0c8fe48b983D8191F0fA4444";
const ELYSIUM_PROTOCOL_VAULT = "0xA8fAd48376572075288ad60eE199b36bc445D1b0";
const ELYSIUM_POOL_MANAGER = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1";

// Factory deploy block. Backfilling from here catches every launch and — via the
// factory() pattern — every child token and FeeRouter. Env override allowed.
const ELYSIUM_START_BLOCK = process.env.ELYSIUM_START_BLOCK
  ? Number(process.env.ELYSIUM_START_BLOCK)
  : 3085053;

// Primary RPC is https://rpc.elysium.kinetiq.xyz. PONDER_RPC_URL_99901 overrides it
// (use the working backup https://rpc.elyscan.live for local testing).
const ELYSIUM_RPC =
  process.env.PONDER_RPC_URL_99901 || "https://rpc.elysium.kinetiq.xyz";

const launchedV5 = getAbiItem({ abi: ballastFactoryV5Abi, name: "Launched" });

export default createConfig({
  chains: {
    robinhood: { id: 4663, rpc: RPC },
    elysium: { id: 99901, rpc: ELYSIUM_RPC },
  },
  contracts: {
    BallastFactory: {
      chain: "robinhood",
      abi: ballastFactoryAbi,
      address: FACTORY,
      startBlock: START_BLOCK,
    },
    // Per-launch token, discovered from the factory's Launched event.
    ProjectToken: {
      chain: "robinhood",
      abi: ballastTokenAbi,
      address: factory({ address: FACTORY, event: launched, parameter: "token" }),
      startBlock: START_BLOCK,
    },
    // Per-launch treasury, discovered the same way.
    ProjectTreasuryC: {
      chain: "robinhood",
      abi: projectTreasuryAbi,
      address: factory({ address: FACTORY, event: launched, parameter: "treasury" }),
      startBlock: START_BLOCK,
    },
    // Singleton fee hook.
    BallastHook: {
      chain: "robinhood",
      abi: ballastHookAbi,
      address: HOOK,
      startBlock: START_BLOCK,
    },
    // Singleton v4 PoolManager. We index every Swap and keep only those whose pool
    // id maps to a BALLAST pool (recorded at Graduated).
    PoolManager: {
      chain: "robinhood",
      abi: poolManagerAbi,
      address: POOL_MANAGER,
      startBlock: START_BLOCK,
    },

    // ── Gen-5 Elysium contracts (chain 99901) ────────────────────────────────
    BallastFactoryV5: {
      chain: "elysium",
      abi: ballastFactoryV5Abi,
      address: ELYSIUM_FACTORY,
      startBlock: ELYSIUM_START_BLOCK,
    },
    // Per-launch token, discovered from the factory's Launched event.
    ProjectTokenV5: {
      chain: "elysium",
      abi: ballastTokenAbi,
      address: factory({ address: ELYSIUM_FACTORY, event: launchedV5, parameter: "token" }),
      startBlock: ELYSIUM_START_BLOCK,
    },
    // Per-launch FeeRouterV5, discovered the same way (gen-5 has no treasury).
    FeeRouterV5: {
      chain: "elysium",
      abi: feeRouterV5Abi,
      address: factory({ address: ELYSIUM_FACTORY, event: launchedV5, parameter: "feeRouter" }),
      startBlock: ELYSIUM_START_BLOCK,
    },
    // Singleton gen-5 hook: fees + range-order limit orders.
    BallastHookV5: {
      chain: "elysium",
      abi: ballastHookV5Abi,
      address: ELYSIUM_HOOK,
      startBlock: ELYSIUM_START_BLOCK,
    },
    // Ownerless protocol 20% sink (vault sweeps).
    ProtocolFeeVault: {
      chain: "elysium",
      abi: protocolFeeVaultAbi,
      address: ELYSIUM_PROTOCOL_VAULT,
      startBlock: ELYSIUM_START_BLOCK,
    },
    // One-sided LP seeder (emits per-pool creator fee at seed time).
    BallastSeederV5: {
      chain: "elysium",
      abi: ballastSeederV5Abi,
      address: ELYSIUM_SEEDER,
      startBlock: ELYSIUM_START_BLOCK,
    },
    // Singleton v4 PoolManager on Elysium. Index every Swap; keep only those whose
    // pool id maps to a gen-5 pool (recorded at Graduated).
    PoolManagerV5: {
      chain: "elysium",
      abi: poolManagerAbi,
      address: ELYSIUM_POOL_MANAGER,
      startBlock: ELYSIUM_START_BLOCK,
    },
  },
});
