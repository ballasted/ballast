// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stands in for BallastFactory's launchIdOf ledger — the real factory is
///         frozen and heavy to deploy for unit tests (see FeeRouter.t.sol's same
///         MockRouterFactory precedent). OpenTreasuryVaultFactory only ever reads
///         this one function.
contract MockBallastFactoryLaunchId {
    mapping(address => uint256) public launchIdOf;
    uint256 internal _next = 1;

    function markLaunched(address token) external {
        if (launchIdOf[token] == 0) {
            launchIdOf[token] = _next++;
        }
    }
}
