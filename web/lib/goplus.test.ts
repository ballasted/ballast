import { describe, it, expect } from "vitest";
import { deriveSecurityCheck, goPlusApiUrl } from "./goplus";

describe("deriveSecurityCheck — no fake greens", () => {
  it("an absent field is Unknown, never a default Pass", () => {
    // The exact real-world shape (docs/scanner-evidence/goplus-ballast-v2-2026-09-29.json):
    // an unverified token gets is_open_source:"0" and NO is_honeypot key at all.
    const r = deriveSecurityCheck({ is_open_source: "0" });
    expect(r.scanned).toBe(true);
    expect(r.verifiedSource.status).toBe("fail");
    expect(r.honeypot.status).toBe("unknown");
    expect(r.honeypot.value).not.toMatch(/pass|not a honeypot/i);
    expect(r.anyUnknown).toBe(true);
  });

  it("no entry at all (GoPlus never scanned this address) is unscanned + all unknown", () => {
    const r = deriveSecurityCheck(undefined);
    expect(r.scanned).toBe(false);
    expect(r.verifiedSource.status).toBe("unknown");
    expect(r.honeypot.status).toBe("unknown");
    expect(r.buyTax.status).toBe("unknown");
    expect(r.sellTax.status).toBe("unknown");
    expect(r.cannotBuy.status).toBe("unknown");
    expect(r.transferPausable.status).toBe("unknown");
    expect(r.anyFail).toBe(false);
    expect(r.anyUnknown).toBe(true);
  });

  it("a clean verified token (real BALLAST v1 shape) passes every row", () => {
    const r = deriveSecurityCheck({
      is_open_source: "1",
      is_honeypot: "0",
      buy_tax: "0",
      sell_tax: "0",
      cannot_buy: "0",
      transfer_pausable: "0",
      holder_count: "126",
    });
    expect(r.scanned).toBe(true);
    expect(r.verifiedSource.status).toBe("pass");
    expect(r.honeypot.status).toBe("pass");
    expect(r.buyTax).toEqual({ status: "pass", value: "0%" });
    expect(r.sellTax).toEqual({ status: "pass", value: "0%" });
    expect(r.cannotBuy.status).toBe("pass");
    expect(r.transferPausable.status).toBe("pass");
    expect(r.holderCount).toBe(126);
    expect(r.anyFail).toBe(false);
    expect(r.anyUnknown).toBe(false);
  });

  it("an explicit honeypot flag is a definitive Fail, not Unknown", () => {
    const r = deriveSecurityCheck({ is_honeypot: "1" });
    expect(r.honeypot.status).toBe("fail");
  });

  it("a nonzero reported tax is a definitive Fail with the exact percentage shown", () => {
    const r = deriveSecurityCheck({ sell_tax: "0.05" });
    expect(r.sellTax).toEqual({ status: "fail", value: "5%" });
  });

  it("cannot_buy=1 fails, and it is a distinct check from honeypot", () => {
    const r = deriveSecurityCheck({ cannot_buy: "1", is_honeypot: "0" });
    expect(r.cannotBuy.status).toBe("fail");
    expect(r.honeypot.status).toBe("pass");
  });
});

describe("goPlusApiUrl — proof link", () => {
  it("lowercases addresses and comma-joins them against the chain-4663 endpoint", () => {
    const url = goPlusApiUrl(["0xABC0000000000000000000000000000000000A", "0xDEF0000000000000000000000000000000000B"]);
    expect(url).toBe(
      "https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=0xabc0000000000000000000000000000000000a,0xdef0000000000000000000000000000000000b",
    );
  });
});
