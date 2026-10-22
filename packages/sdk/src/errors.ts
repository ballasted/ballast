// Typed, readable SDK errors. Every thrown error is a BallastSdkError subclass so
// callers can `instanceof`-narrow and show a sensible message. These are raised at
// the SDK boundary (param validation, simulate failures) — on-chain reverts are
// surfaced via SimulationError with the decoded reason where viem provides one.

export class BallastSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A parameter failed validation before any RPC call. */
export class ValidationError extends BallastSdkError {}

/** A requested token/launch/router could not be resolved on-chain. */
export class NotFoundError extends BallastSdkError {}

/** The parent token is not a Ballast launch (launch() would revert NotBallastParent). */
export class NotBallastParentError extends ValidationError {
  constructor(public readonly parent: string) {
    super(`Parent ${parent} is not a Ballast-launched token with a live WETH pool.`);
  }
}

/** A stock asset is not on the AssetRegistry allowlist or is not routable. */
export class AssetNotAllowedError extends ValidationError {
  constructor(public readonly asset: string) {
    super(`Asset ${asset} is not an allowlisted, routable Ballast asset.`);
  }
}

/** A FeeRouter v2 scheduleSplit violates the asymmetric-delay rules. */
export class SplitDelayError extends ValidationError {}

/** A fee split's buckets don't sum to 10,000 bps, or a bucket is out of range. */
export class SplitShapeError extends ValidationError {}

/** `simulateContract` / `estimateGas` reverted; `reason` is the decoded revert. */
export class SimulationError extends BallastSdkError {
  constructor(
    message: string,
    public readonly reason?: string,
    public readonly cause?: unknown,
  ) {
    super(reason ? `${message}: ${reason}` : message);
  }
}

/** A read returned data in an unexpected shape (e.g. ABI/selector drift). */
export class DecodeError extends BallastSdkError {}
