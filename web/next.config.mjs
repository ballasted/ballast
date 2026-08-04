import createMDX from "@next/mdx";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Content Security Policy ───────────────────────────────────────────────────
// Defence-in-depth while the domain is flagged by Safe Browsing. It is deliberately
// permissive where the wallet SDK and the GeckoTerminal embed genuinely need it —
// a broken wallet on an already-flagged site is worse than a looser CSP — but it
// still shuts the doors that matter: no framing us (clickjacking), no plugin
// content, locked base-uri/form-action, and no non-http(s) or data/exotic-scheme
// navigations. `img-src`/`connect-src` stay broad (https:) because logos resolve
// from the IPFS gateway and the wallet reaches many RPC/relay hosts.
//
// ⚠️ VERIFY IN A BROWSER after deploy: connect a wallet, open a token page (the
// GeckoTerminal chart must render), and confirm project logos load. If anything is
// blocked, flip the header name below to "Content-Security-Policy-Report-Only"
// to observe violations without enforcing, tighten, then switch back.
const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts (no nonce here); some wallet libs use eval/wasm.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Same-origin API proxies + direct public-RPC fallback + wallet relays (https/wss).
  "connect-src 'self' https: wss:",
  // The price chart embed, plus WalletConnect's verify frame.
  "frame-src 'self' https://www.geckoterminal.com https://verify.walletconnect.com https://verify.walletconnect.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow .mdx files to be treated as pages/components.
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  reactStrictMode: true,
  // Pin the workspace root: an unrelated package-lock.json in a parent dir was
  // making Next infer the wrong root for output file tracing.
  outputFileTracingRoot: __dirname,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config, { webpack }) => {
    // wagmi's connectors barrel drags in the Base/Coinbase account connector,
    // which lazily requires optional @x402/* payment packages we don't install
    // or use (we only use the `injected` connector). Ignore them so the bundle
    // resolves; they are never executed.
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }),
    );

    // WalletConnect/reown's dependency tree reaches for two optional packages
    // that only exist in non-browser environments:
    //   • @react-native-async-storage/async-storage — a React-Native storage
    //     backend @metamask/sdk probes for; irrelevant in a web build.
    //   • pino-pretty — a dev-only pretty-printer pino tries to require; we never
    //     enable pretty logging in the browser.
    // Alias both to false so webpack resolves them to an empty module instead of
    // emitting "Can't resolve …" warnings. They are never executed at runtime.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    return config;
  },
};

const withMDX = createMDX({
  // Add markdown/remark/rehype plugins here as the docs grow.
  options: {},
});

export default withMDX(nextConfig);
