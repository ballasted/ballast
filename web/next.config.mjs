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
};

const withMDX = createMDX({
  // Add markdown/remark/rehype plugins here as the docs grow.
  options: {},
});

export default withMDX(nextConfig);
