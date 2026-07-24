import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { config as loadEnv } from "dotenv";
import {
  ballastFactoryAbi,
  ballastTokenAbi,
  projectTreasuryAbi,
  ballastHookAbi,
  poolManagerAbi,
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

export default createConfig({
  chains: { robinhood: { id: 4663, rpc: RPC } },
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
  },
});
