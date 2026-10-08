// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for Ramses' Voter, covering only the one call
///         RamsesLocker makes: `claimClGaugeRewards`. Pays out whatever has
///         been pre-funded via `fundRewards` for the requested tokens, to
///         msg.sender (the locker) — modeling the real effect (gauge rewards
///         land on the locker, which then forwards the delta to the fee
///         receiver). Not a vendored file; see MockRamsesPositionManager.sol
///         for why this isn't the authoritative proof.
contract MockRamsesVoter {
    using SafeERC20 for IERC20;

    mapping(address => address) public gaugeForPool_;
    mapping(address => uint256) public stash; // per reward token

    function setGaugeForPool(address pool, address gauge) external {
        gaugeForPool_[pool] = gauge;
    }

    function gaugeForPool(address pool) external view returns (address) {
        return gaugeForPool_[pool];
    }

    /// @dev Test-only: pulls `amount` of `token` from the caller into this
    ///      contract's stash, to be paid out on the next matching claim.
    function fundRewards(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        stash[token] += amount;
    }

    function claimClGaugeRewards(
        address[] calldata, /* gauges */
        address[][] calldata rewardTokens,
        uint256[][] calldata, /* tokenIds */
        address[] calldata /* managers */
    ) external {
        address[] calldata tokens = rewardTokens[0];
        for (uint256 i; i < tokens.length; ++i) {
            uint256 amount = stash[tokens[i]];
            if (amount == 0) continue;
            stash[tokens[i]] = 0;
            IERC20(tokens[i]).safeTransfer(msg.sender, amount);
        }
    }
}
