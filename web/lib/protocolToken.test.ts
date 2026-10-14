import { describe, it, expect } from "vitest";
import { PROTOCOL_TOKEN_ADDRESS } from "@/components/app/token/ProtocolTokenNotice";

const V1 = "0x069a260370c61d91bd3e9842d81d378f9750f7f3";
const V2 = "0xdc605041f02e41cbd8fdc347023e93c4c3fa243c";

// With NEXT_PUBLIC_PINNED_TOKEN_ADDRESS unset (the case in CI/tests), the pinned
// protocol token must default to v2 — NEVER the retired v1. This guards against
// the default ever regressing to v1 (which would re-pin v1 on Discover and make
// the buyback page read v1's dead balance under a "v2 burned" label).
describe("PROTOCOL_TOKEN_ADDRESS default", () => {
  it("defaults to v2, not v1", () => {
    expect(PROTOCOL_TOKEN_ADDRESS.toLowerCase()).toBe(V2);
    expect(PROTOCOL_TOKEN_ADDRESS.toLowerCase()).not.toBe(V1);
  });
});
