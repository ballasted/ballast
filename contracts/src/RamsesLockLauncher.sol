// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManager} from
    "../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";
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

    INonfungiblePositionManager public immutable positionManager;
    RamsesLocker public immutable locker;
    BallastFeeSplitterFactory public immutable splitterFactory;

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

    constructor(address positionManager_, address locker_, address splitterFactory_) {
        if (positionManager_ == address(0) || locker_ == address(0) || splitterFactory_ == address(0)) {
            revert ZeroAddress();
        }
        positionManager = INonfungiblePositionManager(positionManager_);
        locker = RamsesLocker(locker_);
        splitterFactory = BallastFeeSplitterFactory(splitterFactory_);
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
    function createAndLock(
        MintLegs calldata legs,
        address launchedToken,
        address creatorRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    ) external returns (uint256 tokenId, address splitter) {
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
