// Check Blockscout verification status of core contracts + every launch's
// ProjectTreasury (decoded from the Launched event data field). No RPC needed.
const B = "https://robinhoodchain.blockscout.com";
const LAUNCHED =
  "0x341e1a8477856ce51ab6bc9293a7a07e030d00df94b79c7d4724e62af10faac7";
const FACTORIES = [
  "0x069974136c78cf0f2162463b95321e59f56523d8",
  "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1",
];
const CORE = {
  "factory v1": "0x069974136c78cf0f2162463b95321e59f56523d8",
  "factory v2": "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1",
  AssetRegistry: "0x427764d0d19ab765c35a41a5aa4771580307da81",
  "BackingLens v1": "0x21fde9acfb45da09262672b9f35fb3b4fe91d770",
  "FeeConfig v1": "0xf814ca06affabd1aa5cd31adb5f25d23e9871304",
  "BallastHook v1": "0x9c15c992e4de3711715c8b7d717ef46e474680cc",
  "BallastSeeder v1": "0xbe043844e0b7713b4c7841dccb3c4e1c6ea5ecf9",
  "BallastHook v2": "0x743102aa1de955b5f0fada1377b6e545fdb080cc",
  BuybackBurner: "0x36198daefdcef476cf8e77b0961a4d79ae7852be",
  ManateeRenderer: "0xbd602bddb55b3a200015bafcd975e54a93549327",
  BallastManatee: "0xfd3534f2a6ca756e95e5d2ff7bd287954b856e4b",
};

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function verified(addr) {
  try {
    const r = await getJson(`${B}/api/v2/addresses/${addr}`);
    return { v: r.is_verified, name: r.name };
  } catch (e) {
    return { v: "ERR:" + e.message };
  }
}

// Discover treasuries from Launched event data (treasury = first 32B of data).
async function allLogs(factory) {
  let params = null;
  const out = [];
  for (let p = 0; p < 50; p++) {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    const d = await getJson(`${B}/api/v2/addresses/${factory}/logs${q}`);
    out.push(...(d.items || []));
    if (!d.next_page_params) break;
    params = d.next_page_params;
  }
  return out;
}

const treasuries = [];
for (const f of FACTORIES) {
  const logs = await allLogs(f);
  for (const l of logs.filter((x) => (x.topics || [])[0]?.toLowerCase() === LAUNCHED)) {
    const data = (l.raw_data || l.data || "").replace(/^0x/, "");
    const treasury = "0x" + data.slice(24, 64); // first word -> address
    const token = "0x" + l.topics[3].slice(-40);
    treasuries.push({ token, treasury });
  }
}

console.log("=== CORE CONTRACTS ===");
for (const [name, addr] of Object.entries(CORE)) {
  const s = await verified(addr);
  console.log(String(s.v).padEnd(6), name.padEnd(18), addr, s.name ? `(${s.name})` : "");
  await sleep(700);
}

console.log("\n=== PROJECT TREASURIES (one per launch) ===");
for (const t of treasuries) {
  const s = await verified(t.treasury);
  console.log(String(s.v).padEnd(6), t.treasury, "token=" + t.token);
  await sleep(700);
}
