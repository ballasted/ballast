const { execSync } = require("node:child_process");
const fs = require("node:fs");
const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const BODY_FILE = "/tmp/__snapshot_rpc_body.json";

function rpcBatch(calls) {
  // calls: array of {method, params}
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })));
  fs.writeFileSync(BODY_FILE, body);
  const out = execSync(`curl -s -m 60 -X POST ${RPC} -H "Content-Type: application/json" --data-binary @${BODY_FILE}`, { maxBuffer: 1024 * 1024 * 400 });
  const j = JSON.parse(out.toString());
  const arr = Array.isArray(j) ? j : [j];
  arr.sort((a, b) => a.id - b.id);
  return arr.map((r) => {
    if (r.error) throw new Error(JSON.stringify(r.error));
    return r.result;
  });
}

function rpc(method, params) {
  return rpcBatch([{ method, params }])[0];
}

module.exports = { rpc, rpcBatch };
