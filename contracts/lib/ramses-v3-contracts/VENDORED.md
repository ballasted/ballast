# Vendored: RamsesLocker + its import closure

Source: https://github.com/RamsesExchange/ramses-v3-contracts
Pinned commit: `cfa91a1777a53b752d2be29f4c7f0a083005eb55` (fetched 2026-10-09, HEAD of `main` at fetch time)

This is NOT a full checkout of that repo. It is the exact 19-file import closure
needed to compile `RamsesLocker.sol` standalone — `RamsesLocker.sol` itself plus
every interface/library it transitively imports, fetched byte-for-byte via
`raw.githubusercontent.com` at the pinned commit and placed at the same relative
paths so the file's own `./CL/...`-style relative imports resolve unmodified.

Do not hand-edit anything under `contracts/`. To update the pin, re-fetch the
same file list at a new commit and replace this README's hash.

Files (relative to `contracts/`):
- RamsesLocker.sol
- CL/periphery/interfaces/{INonfungiblePositionManager,IPoolInitializer,IPeripheryPayments,IPeripheryImmutableState,IPeripheryErrors}.sol
- CL/periphery/libraries/PoolAddress.sol
- CL/core/interfaces/IRamsesV3Pool.sol
- CL/core/interfaces/pool/{IRamsesV3PoolImmutables,IRamsesV3PoolState,IRamsesV3PoolDerivedState,IRamsesV3PoolActions,IRamsesV3PoolOwnerActions,IRamsesV3PoolErrors,IRamsesV3PoolEvents}.sol
- CL/core/libraries/{FullMath,FixedPoint128}.sol
- CL/gauge/interfaces/IGaugeV3.sol
- interfaces/IVoter.sol

`RamsesLocker.sol` imports `@openzeppelin/contracts/...` (OZ 5.1.0, per the
source repo's own `foundry.toml` dependency pin). This repo's top-level
`lib/openzeppelin-contracts` is also pinned to 5.1.0 (exact match) — see the
`ramses-v3-contracts/:@openzeppelin/=` path-scoped remapping in
`contracts/foundry.toml`, which points ONLY files under this vendored tree at
that copy. (The existing unscoped `@openzeppelin/` remapping in this repo
points at `lib/v4-core/lib/openzeppelin-contracts`, OZ 5.0.2 — left untouched
since nothing else uses that prefix today; scoping avoids a version-pin
collision between the two.)

`PoolAddress.POOL_INIT_CODE_HASH` is a constant baked into this pinned
version of the library. It is used by `RamsesLocker.lock()` to derive
`poolOf[tokenId]` from `(token0, token1, tickSpacing)` alone — it does NOT
query a factory. If Robinhood Chain's deployed Ramses CL pools were compiled
with different bytecode (different init code hash), this computed address
would silently diverge from the real pool address, corrupting
`collectRewards`/`pendingFees` (both key off `poolOf[tokenId]`). **This must
be verified against a real deployed pool before relying on
`collectRewards`/`pendingFees` in production** — see
`test/BallastFeeSplitterFork.t.sol`'s `test_fork_poolAddressComputationMatchesReal`.
