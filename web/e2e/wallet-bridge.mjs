// Minimal local JSON-RPC bridge so Playwright can drive the real production
// wallet-connect UI against a local Anvil fork, signing with Anvil's
// universally-known default dev account #0 (public, zero real value, printed
// in every `anvil` instance's own startup banner — never a real secret).
// Pattern mirrors web/scripts/_wallet-bridge.mjs (a prior scratch tool for
// driving the UI against real mainnet with a real funded keystore) but this
// one only ever talks to a local Anvil fork and never holds or reads a real
// private key or keystore file.
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http } from "viem";

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RPC_URL = process.env.BRIDGE_RPC_URL || "http://127.0.0.1:8555";
const PORT = Number(process.env.BRIDGE_PORT || 8766);
const CHAIN_ID = 4663;

const account = privateKeyToAccount(ANVIL_PK);
const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain (fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
void publicClient;

async function rpcForward(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw j.error;
  return j.result;
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let id;
    try {
      const { method, params, id: reqId } = JSON.parse(body);
      id = reqId;
      let result;
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          result = [account.address];
          break;
        case "eth_chainId":
          result = `0x${CHAIN_ID.toString(16)}`;
          break;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          result = null;
          break;
        case "eth_sendTransaction": {
          const tx = params[0];
          const hash = await walletClient.sendTransaction({
            account,
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
          result = hash;
          break;
        }
        case "personal_sign": {
          const [msg] = params;
          result = await walletClient.signMessage({ account, message: { raw: msg } });
          break;
        }
        default:
          result = await rpcForward(method, params);
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, result }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id, error: { message: e instanceof Error ? e.message : String(e) } }),
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e wallet-bridge] ${account.address} on chain ${CHAIN_ID}, forwarding to ${RPC_URL}, listening on ${PORT}`);
});
