// Query GoPlus token_security (chain 4663) for every launched token.
// GoPlus is what GMGN renders. Different host from Blockscout — no rate contention.
import { readFileSync } from "node:fs";
const tokens = JSON.parse(readFileSync(new URL("./tokens.json", import.meta.url)));
const FIELDS = ["is_open_source", "is_proxy", "is_mintable", "owner_address",
  "is_honeypot", "cannot_buy", "cannot_sell_all", "transfer_pausable",
  "is_blacklisted", "buy_tax", "sell_tax", "lp_holders", "holder_count"];
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
(async () => {
  for (const t of tokens) {
    try {
      const r = await fetch(
        `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${t.token}`
      );
      const j = await r.json();
      const k = Object.keys(j.result || {})[0];
      const d = (j.result || {})[k] || {};
      const row = FIELDS.map((f) => `${f}=${JSON.stringify(d[f])}`).join(" ");
      console.log(`${(t.symbol || "?").padEnd(8)} ${t.token}\n   ${row}`);
    } catch (e) {
      console.log(`${t.symbol} ERR ${e.message}`);
    }
    await sleep(2500);
  }
})();
