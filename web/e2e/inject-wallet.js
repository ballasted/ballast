// Injected into the browser before any page script runs (Playwright
// addInitScript). Defines a minimal EIP-1193 provider that forwards every
// request to the local wallet-bridge (web/e2e/wallet-bridge.mjs, itself
// forwarding to a local Anvil fork), and announces it via EIP-6963 so
// wagmi's injected() connector discovers it the same way it would discover a
// real browser extension wallet.
(function () {
  const BRIDGE_URL = "/__e2e-bridge"; // same-origin proxy -- see next.config.mjs rewrites()
  const CHAIN_ID_HEX = "0x1237"; // 4663

  const listeners = {};
  // Real wallets expose accounts via eth_accounts ONLY after an explicit
  // eth_requestAccounts — a bare page-load eth_accounts probe (wagmi's
  // auto-reconnect check) must see [] until the user actually connects.
  // Anvil's own eth_accounts always returns its full dev-account list
  // regardless of "connection" state, so that call can't be forwarded as-is
  // here or wagmi sees a phantom already-connected wallet on every page load.
  let connected = false;
  const provider = {
    isMetaMask: true,
    isE2EBridge: true,
    request: async function ({ method, params }) {
      if (method === "eth_chainId") return CHAIN_ID_HEX;
      if (method === "wallet_revokePermissions") {
        connected = false;
        return null;
      }
      if (method === "wallet_getPermissions") return connected ? [{ parentCapability: "eth_accounts" }] : [];
      if (method === "eth_accounts" && !connected) return [];
      if (method === "eth_requestAccounts") connected = true;
      const res = await fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "bridge error");
      return j.result;
    },
    on: function (event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    removeListener: function (event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== cb);
    },
  };

  window.ethereum = provider;

  const info = {
    uuid: "e2e-bridge-0000-0000-0000-000000000000",
    name: "E2E Fork Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    rdns: "com.ballast.e2e",
  };
  function announce() {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
