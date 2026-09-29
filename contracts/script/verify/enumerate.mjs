// Enumerate every BallastToken launched by each factory, via Blockscout logs.
// No RPC needed — Blockscout API is reachable. Run: node script/verify/enumerate.mjs
const B = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";
const LAUNCHED =
  "0x341e1a8477856ce51ab6bc9293a7a07e030d00df94b79c7d4724e62af10faac7";
const FACTORIES = [
  "0x069974136c78cf0f2162463b95321e59f56523d8",
  "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1",
];

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function allLogs(factory) {
  let url = `${B}/api/v2/addresses/${factory}/logs`;
  const out = [];
  let params = null;
  for (let page = 0; page < 50; page++) {
    const q = params
      ? "?" + new URLSearchParams(params).toString()
      : "";
    const d = await getJson(url + q);
    out.push(...(d.items || []));
    if (!d.next_page_params) break;
    params = d.next_page_params;
  }
  return out;
}

const tokens = [];
for (const f of FACTORIES) {
  const logs = await allLogs(f);
  const launched = logs.filter(
    (l) => (l.topics || [])[0]?.toLowerCase() === LAUNCHED
  );
  for (const l of launched) {
    const t = l.topics;
    tokens.push({
      factory: f,
      id: parseInt(t[1], 16),
      creator: "0x" + t[2].slice(-40),
      token: "0x" + t[3].slice(-40),
    });
  }
  console.error(
    `factory ${f}: ${logs.length} logs, ${launched.length} Launched`
  );
}

// Enrich with token name/symbol + verification status.
for (const e of tokens) {
  try {
    const tk = await getJson(`${B}/api/v2/tokens/${e.token}`);
    e.name = tk.name;
    e.symbol = tk.symbol;
  } catch {}
  try {
    const ad = await getJson(`${B}/api/v2/addresses/${e.token}`);
    e.is_verified = ad.is_verified;
  } catch {}
}

console.log(JSON.stringify(tokens, null, 2));
