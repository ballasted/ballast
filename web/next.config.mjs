import createMDX from "@next/mdx";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow .mdx files to be treated as pages/components.
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  reactStrictMode: true,
  // Pin the workspace root: an unrelated package-lock.json in a parent dir was
  // making Next infer the wrong root for output file tracing.
  outputFileTracingRoot: __dirname,
  webpack: (config, { webpack }) => {
    // wagmi's connectors barrel drags in the Base/Coinbase account connector,
    // which lazily requires optional @x402/* payment packages we don't install
    // or use (we only use the `injected` connector). Ignore them so the bundle
    // resolves; they are never executed.
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }),
    );
    return config;
  },
};

const withMDX = createMDX({
  // Add markdown/remark/rehype plugins here as the docs grow.
  options: {},
});

export default withMDX(nextConfig);
