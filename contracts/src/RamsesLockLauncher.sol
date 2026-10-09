// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManager} from
    "../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";
import {IRamsesV3Factory} from "../lib/ramses-v3-contracts/contracts/CL/core/interfaces/IRamsesV3Factory.sol";
import {IRamsesV3PoolDeployer} from
    "../lib/ramses-v3-contracts/contracts/CL/core/interfaces/IRamsesV3PoolDeployer.sol";
import {IRamsesV3Pool} from "../lib/ramses-v3-contracts/contracts/CL/core/interfaces/IRamsesV3Pool.sol";
import {RamsesLocker} from "../lib/ramses-v3-contracts/contracts/RamsesLocker.sol";
import {BallastFeeSplitterFactory} from "./BallastFeeSplitterFactory.sol";
import {BallastFeeSplitter} from "./BallastFeeSplitter.sol";

/// @title RamsesLockLauncher — mints one Ramses v3 CL position and permanently
///        locks it to a fresh BallastFeeSplitter, atomically
///
/// @notice This is the ONLY intended way a Ballast-launched position's fees are
///         ever routed to a splitter: mint -> approve -> lock, all in one
///         transaction, so the NFT is never held by this contract (or anyone
///         else) outside of that single call, and it is never transferred to
///         `locker` any way other than `lock()`'s own `transferFrom`.
///
/// @dev Stateless, permissionless, no owner, no admin, no pause, no upgrade
///      path, no rescue/sweep. Builds `MintParams.recipient` itself (always
///      `address(this)`) instead of trusting a caller-supplied struct, so the
///      position is always actually minted TO this contract — a caller
///      cannot point `recipient` elsewhere and later claim the launcher
///      "didn't really hold it". Caller-supplied `amount0Desired`/
///      `amount1Desired` are pulled via `transferFrom` (caller must approve
///      this contract first); any leftover dust after `mint()` (Ramses may
///      use less than desired) is refunded to the caller in the same tx, and
///      this contract's balance of both leg tokens is zero again afterward —
///      see the invariant test in `RamsesLockLauncher.t.sol`.
contract RamsesLockLauncher {
    using SafeERC20 for IERC20;

    /// @notice Ceiling on the caller-supplied price tolerance (§1), same
    ///         magnitude and same simplification as FeeRouter/BuybackBurnerV2's
    ///         MAX_SLIPPAGE_BPS: applied directly to sqrtPriceX96, not to the
    ///         squared (linear) price, so the effective linear-price tolerance
    ///         is roughly 2x this bps figure for small deviations. That's the
    ///         right shape here too — this is a front-run/gross-manipulation
    ///         backstop, not execution-slippage precision.
    uint16 public constant MAX_PRICE_DEVIATION_BPS = 2_000;
    uint256 internal constant BPS = 10_000;

    INonfungiblePositionManager public immutable positionManager;
    RamsesLocker public immutable locker;
    BallastFeeSplitterFactory public immutable splitterFactory;
    /// @notice Derived on-chain from `positionManager.deployer()` ->
    ///         `IRamsesV3PoolDeployer.RamsesV3Factory()` — the exact same path
    ///         Ramses' own periphery (`PoolInitializer`) uses to resolve the
    ///         factory. No separate factory address is ever taken as a
    ///         constructor input, so there is no way to deploy this launcher
    ///         against a mismatched/wrong factory.
    IRamsesV3Factory public immutable v3Factory;

    event CreatedAndLocked(
        uint256 indexed tokenId,
        address indexed splitter,
        address indexed launchedToken,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1,
        address creatorRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    );

    error ZeroAddress();
    /// @notice `maxPriceDeviationBps` exceeded MAX_PRICE_DEVIATION_BPS.
    error DeviationTooWide();
    /// @notice The pool already exists and is already initialized, at a price
    ///         outside the caller's expected tolerance band — refuses to lock
    ///         liquidity into a pool whose price it didn't set and can't trust.
    error PoolPriceOutOfBounds(uint160 actualSqrtPriceX96, uint160 expectedLower, uint160 expectedUpper);

    constructor(address positionManager_, address locker_, address splitterFactory_) {
        if (positionManager_ == address(0) || locker_ == address(0) || splitterFactory_ == address(0)) {
            revert ZeroAddress();
        }
        positionManager = INonfungiblePositionManager(positionManager_);
        locker = RamsesLocker(locker_);
        splitterFactory = BallastFeeSplitterFactory(splitterFactory_);
        v3Factory = IRamsesV3Factory(IRamsesV3PoolDeployer(positionManager.deployer()).RamsesV3Factory());
    }

    struct MintLegs {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice Mints a Ramses v3 CL position from caller-supplied token amounts
    ///         (typically single-sided — one of `amount0Desired`/`amount1Desired`
    ///         is 0, same shape as a fresh Ballast launch's one-sided seed),
    ///         deploys a fresh BallastFeeSplitter for it, and locks the position
    ///         to that splitter forever — all in this one call.
    /// @param legs The position to mint. `recipient` is NOT part of this struct:
    ///             it is always `address(this)`, set internally.
    /// @param launchedToken The Ballast token this position's fees belong to
    ///        (informational on the splitter; never checked against token0/token1
    ///        here — the splitter is balance-based and prices nothing).
    /// @param creatorRecipient Where the creator's share of fees goes.
    /// @param creatorBps / protocolBps Must sum to 10,000 (enforced by the
    ///        splitter's own `initialize`).
    /// @param expectedSqrtPriceX96 The caller's expected current (or, for a
    ///        pool that doesn't exist yet, intended initial) price. ALWAYS
    ///        required and ALWAYS enforced — see `_ensurePoolPrice`.
    /// @param maxPriceDeviationBps Tolerance around `expectedSqrtPriceX96`,
    ///        capped at MAX_PRICE_DEVIATION_BPS. Only consulted when the pool
    ///        already exists and is already initialized (nothing left for
    ///        this call to set) — ignored (no tolerance needed) when this
    ///        call is the one creating or initializing the pool.
    function createAndLock(
        MintLegs calldata legs,
        address launchedToken,
        address creatorRecipient,
        uint16 creatorBps,
        uint16 protocolBps,
        uint160 expectedSqrtPriceX96,
        uint16 maxPriceDeviationBps
    ) external returns (uint256 tokenId, address splitter) {
        if (maxPriceDeviationBps > MAX_PRICE_DEVIATION_BPS) revert DeviationTooWide();
        _ensurePoolPrice(legs.token0, legs.token1, legs.tickSpacing, expectedSqrtPriceX96, maxPriceDeviationBps);

        // Pull by ACTUAL balance delta, not the requested amount — a
        // fee-on-transfer token would otherwise leave this contract holding
        // less than `legs.amountXDesired`, and approving/minting against the
        // requested (not received) amount would either revert the mint
        // outright or, worse, silently approve more than this contract holds.
        uint256 received0 = legs.amount0Desired > 0 ? _pullExact(legs.token0, legs.amount0Desired) : 0;
        uint256 received1 = legs.amount1Desired > 0 ? _pullExact(legs.token1, legs.amount1Desired) : 0;
        if (received0 > 0) IERC20(legs.token0).forceApprove(address(positionManager), received0);
        if (received1 > 0) IERC20(legs.token1).forceApprove(address(positionManager), received1);

        uint256 amount0;
        uint256 amount1;
        (tokenId,, amount0, amount1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: legs.token0,
                token1: legs.token1,
                tickSpacing: legs.tickSpacing,
                tickLower: legs.tickLower,
                tickUpper: legs.tickUpper,
                amount0Desired: received0,
                amount1Desired: received1,
                amount0Min: legs.amount0Min,
                amount1Min: legs.amount1Min,
                recipient: address(this),
                deadline: legs.deadline
            })
        );

        // Reset any residual approval, then refund whatever mint() didn't spend.
        if (received0 > 0) {
            IERC20(legs.token0).forceApprove(address(positionManager), 0);
            uint256 dust0 = received0 - amount0;
            if (dust0 > 0) IERC20(legs.token0).safeTransfer(msg.sender, dust0);
        }
        if (received1 > 0) {
            IERC20(legs.token1).forceApprove(address(positionManager), 0);
            uint256 dust1 = received1 - amount1;
            if (dust1 > 0) IERC20(legs.token1).safeTransfer(msg.sender, dust1);
        }

        splitter = splitterFactory.createSplitter(
            launchedToken, address(locker), tokenId, creatorRecipient, creatorBps, protocolBps
        );

        // This contract is `ownerOf(tokenId)` right now — approve the locker,
        // then lock in the same call. `lock()` pulls the NFT via its own
        // `transferFrom`; it is never sent here any other way.
        positionManager.approve(address(locker), tokenId);
        locker.lock(tokenId, splitter);

        emit CreatedAndLocked(
            tokenId,
            splitter,
            launchedToken,
            legs.token0,
            legs.token1,
            amount0,
            amount1,
            creatorRecipient,
            creatorBps,
            protocolBps
        );
    }

    /// @dev Closes the pool-init front-running window: a Ramses CL pool's
    ///      genesis price can be set by ANYONE via the position manager's
    ///      permissionless `createAndInitializePoolIfNecessary` (or directly
    ///      via the factory's `createPool`/a pool's own `initialize`) — if this
    ///      launcher minted into an existing pool without checking its price,
    ///      a front-runner could set a manipulated genesis price and the
    ///      creator's liquidity (locked forever immediately after) would be
    ///      minted against it with no recourse. This function makes the three
    ///      possible pool states safe:
    ///        1. Doesn't exist yet -> THIS call creates it, atomically, at
    ///           `expectedSqrtPriceX96` — nothing else can get there first
    ///           inside this same transaction.
    ///        2. Exists but was never initialized (defensive — Ramses' own
    ///           factory's `createPool` always initializes, so this should be
    ///           unreachable in practice, but costs nothing to handle) -> THIS
    ///           call initializes it at `expectedSqrtPriceX96`.
    ///        3. Already exists AND is already initialized, by an earlier call
    ///           to this launcher or by anyone else -> verify its CURRENT
    ///           price is within `maxPriceDeviationBps` of what the caller
    ///           expected. Revert if not. Never silently proceed.
    function _ensurePoolPrice(
        address token0,
        address token1,
        int24 tickSpacing,
        uint160 expectedSqrtPriceX96,
        uint16 maxDeviationBps
    ) internal {
        address pool = v3Factory.getPool(token0, token1, tickSpacing);
        if (pool == address(0)) {
            v3Factory.createPool(token0, token1, tickSpacing, expectedSqrtPriceX96);
            return;
        }
        (uint160 currentSqrtPriceX96,,,,,,) = IRamsesV3Pool(pool).slot0();
        if (currentSqrtPriceX96 == 0) {
            IRamsesV3Pool(pool).initialize(expectedSqrtPriceX96);
            return;
        }
        uint256 lower = (uint256(expectedSqrtPriceX96) * (BPS - maxDeviationBps)) / BPS;
        uint256 upper = (uint256(expectedSqrtPriceX96) * (BPS + maxDeviationBps)) / BPS;
        if (currentSqrtPriceX96 < lower || currentSqrtPriceX96 > upper) {
            revert PoolPriceOutOfBounds(currentSqrtPriceX96, uint160(lower), uint160(upper));
        }
    }

    /// @dev Pulls `amount` of `token` from `msg.sender`, returning the amount
    ///      this contract's balance ACTUALLY increased by (handles
    ///      fee-on-transfer tokens; for a standard token this always equals
    ///      `amount`).
    function _pullExact(address token, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }
}
