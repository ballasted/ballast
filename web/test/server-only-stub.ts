// Vitest stub for the `server-only` package. In the Next.js build `server-only`
// throws if a server module is pulled into a client bundle; under vitest (plain
// Node) there is no such boundary, so we alias it to this empty module so
// server-only libs (lib/ai/*, lib/serverChain, lib/ogTokenData, …) can be unit
// tested. See vitest.config.ts resolve.alias.
export {};
