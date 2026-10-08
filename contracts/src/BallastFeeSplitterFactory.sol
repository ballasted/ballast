// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {BallastFeeSplitter} from "./BallastFeeSplitter.sol";

/// @title BallastFeeSplitterFactory — deploys one BallastFeeSplitter clone per
///        locked Ramses v3 position
///
/// @notice Stateless, permissionless, no owner, no registry of its own — every
///         splitter is independently discoverable via `SplitterCreated`. Clones
///         (EIP-1167 minimal proxy via OZ's `Clones`) and initializes in this SAME
///         transaction, so there is never a two-step deploy-then-init window for
///         anyone to front-run a bare, uninitialized clone.
///
/// @dev `protocolRecipient` is NOT a caller parameter: it is fixed here, once, as
///      the Ballast protocol Safe, and baked into every splitter this factory
///      creates — removing an entire class of operator error (no one can
///      fat-finger the Safe address while spinning up splitters for N tokens).
///      Each individual splitter's protocol recipient can still self-rotate later
///      (gated to whichever address currently holds that role on THAT splitter),
///      independently of this factory-level constant.
///
///      This factory does NOT enforce any particular `creatorBps`/`protocolBps` —
///      it is intentionally permissionless, exactly like `FeeRouterFactory`, and a
///      splitter it creates has no effect until a real Ramses `lock()` call points
///      a position's `feeReceiver` at it. The guarantee that a REAL locked
///      position only ever uses a FeeConfig-matching split is a property of
///      whatever trusted launcher calls `lock()`, not of this factory — see the
///      Phase 2 design note on the launcher mechanism (not built here).
contract BallastFeeSplitterFactory {
    /// @notice The single implementation contract every clone delegates to.
    address public immutable implementation;
    /// @notice Baked into every splitter this factory creates; immutable per-splitter
    ///         thereafter unless that splitter's current protocol recipient rotates it.
    address public immutable protocolRecipient;

    event SplitterCreated(
        address indexed splitter,
        address indexed token,
        uint256 indexed positionId,
        address locker,
        address caller,
        address creatorRecipient,
        address protocolRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    );

    error ZeroAddress();

    constructor(address protocolRecipient_) {
        if (protocolRecipient_ == address(0)) revert ZeroAddress();
        implementation = address(new BallastFeeSplitter());
        protocolRecipient = protocolRecipient_;
    }

    /// @notice Deploys a new splitter clone for one Ramses position and
    ///         initializes it in the same transaction. Permissionless — anyone
    ///         may call this with any `creatorBps`/`protocolBps` split; a
    ///         splitter only matters once a real `lock()` call actually points a
    ///         position's `feeReceiver` at it (see contract-level note).
    function createSplitter(
        address token,
        address locker,
        uint256 positionId,
        address creatorRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    ) external returns (address splitter) {
        splitter = Clones.clone(implementation);
        BallastFeeSplitter(splitter).initialize(
            token, locker, positionId, creatorRecipient, protocolRecipient, creatorBps, protocolBps
        );

        emit SplitterCreated(
            splitter, token, positionId, locker, msg.sender, creatorRecipient, protocolRecipient, creatorBps, protocolBps
        );
    }
}
