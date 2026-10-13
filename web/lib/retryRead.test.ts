import { describe, it, expect, vi } from "vitest";
import { retryRead } from "./retryRead";

describe("retryRead", () => {
  it("returns the result on the first success, no retry needed", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryRead(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const result = await retryRead(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once every attempt is exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    await expect(retryRead(fn, 3, 1)).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
