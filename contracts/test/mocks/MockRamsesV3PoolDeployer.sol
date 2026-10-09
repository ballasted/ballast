// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal test-only stand-in for Ramses' real PoolDeployer — exposes
///         only `RamsesV3Factory()`, the one call RamsesLockLauncher's
///         constructor makes through `positionManager.deployer()` to derive
///         its factory immutable on-chain.
contract MockRamsesV3PoolDeployer {
    address public immutable RamsesV3Factory;

    constructor(address factory_) {
        RamsesV3Factory = factory_;
    }
}
