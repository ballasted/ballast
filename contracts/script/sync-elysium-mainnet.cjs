#!/usr/bin/env node
/*
 * sync-elysium-mainnet.cjs — single source of truth for gen-5 Elysium MAINNET (99901) addresses.
 *
 * Run AFTER Rizky broadcasts DeployElysium on 99901. It reads the canonical broadcast
 * artifact (never hand-copied), extracts the four deployed gen-5 addresses by CONTRACT NAME,
 * records the L2 block of the factory deploy (Ponder startBlock), and writes:
 *
 *   1. contracts/deployments/elysium-mainnet.json      -> fills the `ballast` block in place
 *   2. deployments/elysium-mainnet.addresses.json      -> flat map the apps import
 *
 * Every downstream app (frontend, SDK, MCP server, Telegram bot, Ponder indexer) imports
 * (2) so there is exactly one place addresses live. No app hand-copies an address.
 *
 * Usage:
 *   node contracts/script/sync-elysium-mainnet.cjs
 *     [--broadcast <path to run-latest.json>]   (default: the 99901 run-latest)
 *
 * SAFETY: read-only against chain; only writes local JSON. Does nothing destructive.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CONTRACTS = path.resolve(__dirname, '..');
const CHAIN_ID = 99901;

const argi = process.argv.indexOf('--broadcast');
const broadcastPath = argi > -1
  ? process.argv[argi + 1]
  : path.join(CONTRACTS, 'broadcast', 'DeployElysium.s.sol', String(CHAIN_ID), 'run-latest.json');

if (!fs.existsSync(broadcastPath)) {
  console.error(`[sync] broadcast artifact not found: ${broadcastPath}`);
  console.error(`[sync] run the DeployElysium broadcast on ${CHAIN_ID} first, then re-run this.`);
  process.exit(1);
}

const run = JSON.parse(fs.readFileSync(broadcastPath, 'utf8'));
if (String(run.chain) !== String(CHAIN_ID)) {
  console.error(`[sync] artifact chain ${run.chain} != ${CHAIN_ID}; refusing to sync.`);
  process.exit(1);
}

// Map CREATE/CREATE2 transactions by the deployed contract name.
const byName = {};
for (const tx of run.transactions || []) {
  if ((tx.transactionType === 'CREATE' || tx.transactionType === 'CREATE2') && tx.contractName && tx.contractAddress) {
    byName[tx.contractName] = tx.contractAddress;
  }
}

const need = {
  protocolFeeVault: 'ProtocolFeeVault',
  hook: 'BallastHookV5',
  seeder: 'BallastSeederV5',
  factory: 'BallastFactoryV5',
};
const ballast = {};
const missing = [];
for (const [key, cname] of Object.entries(need)) {
  if (byName[cname]) ballast[key] = byName[cname];
  else missing.push(cname);
}
if (missing.length) {
  console.error(`[sync] missing deployed contracts in artifact: ${missing.join(', ')}`);
  process.exit(1);
}
ballast.assetRegistry = ''; // none on Elysium (green-asset list lives in the factory)

// Ponder startBlock = L2 block number of the factory deploy receipt (RPC block numbers are L2;
// only block.number INSIDE the EVM returns the parent-chain block — see CLAUDE.md Elysium note).
let startBlock = null;
for (const r of run.receipts || []) {
  // the factory is the last CREATE; match its tx hash
}
const factoryTx = (run.transactions || []).find((t) => t.contractName === 'BallastFactoryV5');
if (factoryTx) {
  const rec = (run.receipts || []).find((r) => r.transactionHash === factoryTx.hash);
  if (rec && rec.blockNumber) startBlock = parseInt(rec.blockNumber, 16) || Number(rec.blockNumber);
}

// 1. patch the config's ballast block in place (preserve everything else)
const cfgPath = path.join(CONTRACTS, 'deployments', 'elysium-mainnet.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.ballast = { _comment: cfg.ballast && cfg.ballast._comment, ...ballast };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`[sync] patched ${path.relative(REPO, cfgPath)} ballast block`);

// 2. flat address map the apps import
const flat = {
  chainId: CHAIN_ID,
  label: 'Gen 5 · beta',
  rpc: process.env.ELY_MAINNET_RPC || 'https://rpc.elysium.kinetiq.xyz',
  rpcBackup: process.env.ELY_MAINNET_RPC_BACKUP || 'https://rpc.elyscan.live',
  explorer: cfg.explorer,
  startBlock, // Ponder indexer startBlock (L2)
  tokens: cfg.tokens,
  infra: cfg.infra,
  v4: cfg.v4,
  safe: cfg.safe && cfg.safe.expectedAddress,
  protocolBurnDestination: cfg.params.protocolBurnDestination,
  ballast,
};
const outPath = path.join(REPO, 'deployments', 'elysium-mainnet.addresses.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(flat, null, 2) + '\n');
console.log(`[sync] wrote ${path.relative(REPO, outPath)}`);
console.log(`[sync] ballast:`, ballast);
console.log(`[sync] Ponder startBlock (L2): ${startBlock ?? 'UNKNOWN — set manually from the deploy receipt'}`);
console.log('[sync] done. Apps import deployments/elysium-mainnet.addresses.json.');
