// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {OpenTreasuryVault} from "./OpenTreasuryVault.sol";

/// @notice The ONE fact this factory needs from BallastFactory: whether a token was
///         actually launched by it. `launchIdOf` is written exactly once, inside
///         `launch()`, never elsewhere (contracts/src/BallastFactory.sol:118,:380) —
///         state on the real, already-deployed factory, not a claim a token makes
///         about itself (see docs/OPEN_TREASURY_DESIGN.md §1.4 for why that
///         distinction matters).
interface IBallastFactoryLaunchId {
    function launchIdOf(address token) external view returns (uint256);
}

/// @title OpenTreasuryVaultFactory — deploys one OpenTreasuryVault clone per token
///
/// @notice Stateless* (only `vaultOf`), permissionless, no owner, no registry beyond
///         `vaultOf`/`VaultCreated` — every vault is independently discoverable.
///         Clones (EIP-1167 minimal proxy) and initializes in the SAME transaction,
///         so there is never a two-step deploy-then-init window for anyone to
///         front-run a bare, uninitialized clone. Every vault this factory creates
///         is configured IDENTICALLY (only `token` varies — no caller-supplied
///         economic parameter exists anywhere in `getOrCreateVault`), so front-
///         running vault creation is a provable non-issue: whoever calls it first
///         gets the exact same result as whoever would have called it second.
contract OpenTreasuryVaultFactory {
    address public immutable implementation;
    address public immutable ballastFactory;
    address public immutable registry;
    address public immutable rewardAsset;
    uint256 public immutable minHoldTime;
    uint256 public immutable rewardsDuration;

    mapping(address token => address vault) public vaultOf;

    event VaultCreated(address indexed token, address indexed vault, address indexed caller);

    error ZeroAddress();
    error ZeroAmount();
    error NotLaunchedToken(address token);

    constructor(
        address ballastFactory_,
        address registry_,
        address rewardAsset_,
        uint256 minHoldTime_,
        uint256 rewardsDuration_
    ) {
        if (ballastFactory_ == address(0) || registry_ == address(0) || rewardAsset_ == address(0)) revert ZeroAddress();
        if (minHoldTime_ == 0 || rewardsDuration_ == 0) revert ZeroAmount();

        implementation = address(new OpenTreasuryVault());
        ballastFactory = ballastFactory_;
        registry = registry_;
        rewardAsset = rewardAsset_;
        minHoldTime = minHoldTime_;
        rewardsDuration = rewardsDuration_;
    }

    /// @notice Returns the existing vault for `token`, or deploys + initializes one
    ///         if this is the first call for that token. Permissionless, idempotent.
    ///         Verifies `token` was launched by the real BallastFactory exactly
    ///         once, here — the fact is permanent, so later deposits never re-check
    ///         it (contracts/src/OpenTreasuryVault.sol has no BallastFactory
    ///         dependency at all).
    function getOrCreateVault(address token) external returns (address vault) {
        address existing = vaultOf[token];
        if (existing != address(0)) return existing;

        if (IBallastFactoryLaunchId(ballastFactory).launchIdOf(token) == 0) revert NotLaunchedToken(token);

        vault = Clones.cloneDeterministic(implementation, _salt(token));
        OpenTreasuryVault(vault).initialize(token, address(this), registry, rewardAsset, minHoldTime, rewardsDuration);
        vaultOf[token] = vault;

        emit VaultCreated(token, vault, msg.sender);
    }

    /// @notice Deterministic vault address for `token`, computable before creation.
    function vaultFor(address token) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(token), address(this));
    }

    function _salt(address token) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }
}
