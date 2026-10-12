// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stands in for BallastFactory's (launchIdOf, launches) pair — the only
///         two things BasketZap reads to resolve a launch's creator. The real
///         factory's `Launch` struct also carries a dynamic `quoteAssets` array,
///         which Solidity's auto-generated getter omits from the tuple; this
///         mock mirrors that exact 3-value return shape (token, treasury,
///         creator) so BasketZap's decode path is exercised faithfully.
contract MockBasketFactory {
    struct Launch {
        address token;
        address treasury;
        address creator;
    }

    Launch[] internal _launches;
    mapping(address => uint256) public launchIdOf;

    function addLaunch(address token, address treasury, address creator) external returns (uint256 id) {
        _launches.push(Launch({token: token, treasury: treasury, creator: creator}));
        id = _launches.length - 1;
        launchIdOf[token] = id + 1;
    }

    function launches(uint256 id) external view returns (address token, address treasury, address creator) {
        Launch storage l = _launches[id];
        return (l.token, l.treasury, l.creator);
    }
}
