import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the OpenAI SDK so no network call happens. create() returns an object with
// .withResponse() (matching the SDK) whose promise we control per model, so we can
// drive the auto→fallback policy and the unavailable paths deterministically.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(public opts: unknown) {}
  }
  return { default: OpenAI };
});

// Import AFTER the mock is registered.
import { callRaeto, getRaetoAccount, RaetoError } from "./raeto";
import { MODEL_AUTO, MODEL_FALLBACK } from "./config";

function okResponse(model: string, content = "ok") {
  const response = { status: 200, headers: new Headers({ "x-raeto-model": model, "x-raeto-cost": "0.0001" }) };
  const data = { choices: [{ message: { content } }] };
  return { withResponse: () => Promise.resolve({ data, response }) };
}

function rejects(err: unknown) {
  return { withResponse: () => Promise.reject(err) };
}

const err403 = (type: string) => ({ status: 403, error: { type }, message: `This key can only use: ${MODEL_FALLBACK}.` });

const OPTS = { route: "suggest", system: "sys", user: "usr", maxTokens: 50, json: true };

beforeEach(() => {
  createMock.mockReset();
  process.env.RAETO_API_KEY = "sk-test-not-a-real-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callRaeto auto→fallback policy", () => {
  it("retries once with gpt-4o-mini when auto routing is locked (model_not_allowed)", async () => {
    createMock.mockImplementation((args: { model: string }) =>
      args.model === MODEL_AUTO ? rejects(err403("model_not_allowed")) : okResponse(MODEL_FALLBACK, "hello"),
    );

    const res = await callRaeto(OPTS);

    expect(res.content).toBe("hello");
    expect(res.meta.model).toBe(MODEL_FALLBACK);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect((createMock.mock.calls[0]![0] as { model: string }).model).toBe(MODEL_AUTO);
    expect((createMock.mock.calls[1]![0] as { model: string }).model).toBe(MODEL_FALLBACK);
  });

  it("also retries on auto_routing_locked", async () => {
    createMock.mockImplementation((args: { model: string }) =>
      args.model === MODEL_AUTO ? rejects(err403("auto_routing_locked")) : okResponse(MODEL_FALLBACK),
    );
    const res = await callRaeto(OPTS);
    expect(res.meta.model).toBe(MODEL_FALLBACK);
  });

  it("surfaces models_misconfigured when the fallback is ALSO refused", async () => {
    createMock.mockImplementation(() => rejects(err403("model_not_allowed")));
    await expect(callRaeto(OPTS)).rejects.toMatchObject({ kind: "models_misconfigured" });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a non-auth-lock error — maps to a typed unavailable error", async () => {
    createMock.mockImplementation(() => rejects({ status: 500, message: "boom" }));
    await expect(callRaeto(OPTS)).rejects.toBeInstanceOf(RaetoError);
    await expect(callRaeto(OPTS)).rejects.toMatchObject({ kind: "upstream" });
    // One attempt per call (no fallback for a 500).
  });

  it("maps 429 and 402 to their kinds", async () => {
    createMock.mockImplementation(() => rejects({ status: 429 }));
    await expect(callRaeto(OPTS)).rejects.toMatchObject({ kind: "rate_limited" });
    createMock.mockImplementation(() => rejects({ status: 402 }));
    await expect(callRaeto(OPTS)).rejects.toMatchObject({ kind: "payment" });
  });

  it("throws not_configured when the key is absent", async () => {
    delete process.env.RAETO_API_KEY;
    await expect(callRaeto(OPTS)).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("returns auto's result directly when auto is permitted", async () => {
    createMock.mockImplementation((args: { model: string }) => okResponse(args.model, "auto-ok"));
    const res = await callRaeto(OPTS);
    expect(res.content).toBe("auto-ok");
    expect(res.meta.model).toBe(MODEL_AUTO);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("getRaetoAccount (availability / unavailable state)", () => {
  it("reports availableUsd from /v1/me", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ available_usd: 10 }) })),
    );
    const acct = await getRaetoAccount();
    expect(acct.availableUsd).toBe(10);
  });

  it("throws a typed error when /v1/me is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    await expect(getRaetoAccount()).rejects.toBeInstanceOf(RaetoError);
  });
});
