#!/usr/bin/env node
/* Compare on-chain runtime bytecode vs the locally-built artifact deployedBytecode,
 * masking solc immutable byte ranges (which legitimately differ per deployment).
 * Read-only. Usage: node verify-runtime-match.cjs <RPC> */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const RPC = process.argv[2];
const OUT = path.resolve(__dirname, '..', 'out');
const targets = [
  { name: 'ProtocolFeeVault', addr: '0xA8fAd48376572075288ad60eE199b36bc445D1b0' },
  { name: 'BallastSeederV5',  addr: '0x1A2b1e5361a5f1cc0c8fe48b983D8191F0fA4444' },
  { name: 'BallastFactoryV5', addr: '0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE' },
  { name: 'BallastHookV5',    addr: '0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc' },
];
function maskImmutables(hexNo0x, immRefs) {
  const buf = Buffer.from(hexNo0x, 'hex');
  for (const k of Object.keys(immRefs || {})) {
    for (const ref of immRefs[k]) buf.fill(0, ref.start, ref.start + ref.length);
  }
  return buf.toString('hex');
}
let allOk = true;
for (const t of targets) {
  const art = JSON.parse(fs.readFileSync(path.join(OUT, `${t.name}.sol`, `${t.name}.json`), 'utf8'));
  const localHex = art.deployedBytecode.object.replace(/^0x/, '').toLowerCase();
  const immRefs = art.deployedBytecode.immutableReferences || {};
  const onchain = cp.execSync(`cast code ${t.addr} --rpc-url ${RPC}`, { encoding: 'utf8' }).trim().replace(/^0x/, '').toLowerCase();
  const a = maskImmutables(localHex, immRefs);
  const b = maskImmutables(onchain, immRefs);
  const ok = a === b;
  const immCount = Object.values(immRefs).reduce((n, arr) => n + arr.length, 0);
  console.log(`${t.name.padEnd(18)} ${ok ? 'MATCH ✓' : 'DIFFER ✗'}  (len local=${a.length/2} onchain=${b.length/2}, immutable slots masked=${immCount})`);
  if (!ok) allOk = false;
}
console.log(allOk ? '\nALL runtime bytecode matches the local build (immutables aside).' : '\nMISMATCH — investigate.');
process.exit(allOk ? 0 : 1);
