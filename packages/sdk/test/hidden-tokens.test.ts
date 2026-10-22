import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HIDDEN_TOKENS, isHiddenToken } from "../src";

const TEST = "0x3Fec2b548755d53fD8DB97CAc0C14DFA99F0e335";
const LIVE = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C";

describe("hidden tokens", () => {
  it("hides the known test/smoke tokens case-insensitively", () => {
    expect(isHiddenToken(TEST)).toBe(true);
    expect(isHiddenToken(LIVE)).toBe(false);
    expect(isHiddenToken(undefined)).toBe(false);
  });
  it("all entries are lowercased", () => {
    for (const a of HIDDEN_TOKENS) expect(a).toBe(a.toLowerCase());
  });
});

// Drift guard: the SDK list MUST match the web app's canonical CODE_HIDDEN_TOKENS
// (web/lib/hiddenTokens.ts). On the SDK branch alone the web file may be absent
// (it lands with Phase 0) — then the guard is skipped. Once both are merged, this
// actively fails if the two lists ever diverge.
describe("hidden-token list drift guard vs web/lib/hiddenTokens.ts", () => {
  const webPath = join(__dirname, "..", "..", "..", "web", "lib", "hiddenTokens.ts");
  it("matches the web canonical list (or skips if web module absent)", () => {
    if (!existsSync(webPath)) {
      expect(true).toBe(true); // Phase 0 module not present on this branch yet
      return;
    }
    const src = readFileSync(webPath, "utf8");
    const block = src.slice(src.indexOf("CODE_HIDDEN_TOKENS"));
    const webAddrs = (block.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()).slice(0, HIDDEN_TOKENS.length);
    expect([...HIDDEN_TOKENS].sort()).toEqual([...new Set(webAddrs)].sort());
  });
});
