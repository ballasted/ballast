// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title HolderStakingVault — opt-in staking for one BALLAST token's holder-rewards bucket
///
/// @notice Stake the project token, earn pro-rata rewards in the fee currency (WETH
///         in v1), unstake anytime — no lockup, no APR quoted anywhere (copy rule:
///         "rewards paid to stakers", never "yield"/"APR"). Pools and the dead
///         address never stake here, so they structurally never earn.
///
/// @dev Standard Synthetix-style reward-per-token accumulator. One real wrinkle
///      handled explicitly (and unit-tested): `notifyReward` while `totalStaked == 0`
///      would divide by zero if folded into `rewardPerTokenStored` directly. Instead
///      it accumulates in `pendingReward` and is folded into the NEXT successful
///      notify once someone has staked — no reward is ever stranded, and no early
///      staker is unfairly diluted by a reward that arrived before anyone staked.
///      One caller only: the FeeRouter this vault was deployed for (immutable).
contract HolderStakingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant PRECISION = 1e18;

    /// @notice The BALLAST project token — what gets staked.
    address public immutable token;
    /// @notice The currency rewards are paid in (WETH in v1).
    address public immutable rewardCurrency;
    /// @notice The only address allowed to call notifyReward.
    address public immutable router;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    uint256 public rewardPerTokenStored;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// @notice Reward received while totalStaked == 0, carried to the next notify.
    uint256 public pendingReward;

    uint256 public totalRewardsNotified;
    uint256 public totalRewardsClaimed;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardNotified(uint256 amount, bool folded, uint256 carriedPending);
    event RewardClaimed(address indexed user, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotRouter();
    error InsufficientBalance();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    constructor(address token_, address rewardCurrency_, address router_) {
        if (token_ == address(0) || rewardCurrency_ == address(0) || router_ == address(0)) revert ZeroAddress();
        token = token_;
        rewardCurrency = rewardCurrency_;
        router = router_;
    }

    // --------------------------------------------------------------------- //
    //  Staking                                                               //
    // --------------------------------------------------------------------- //

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        totalStaked += amount;
        balanceOf[msg.sender] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        _updateReward(msg.sender);
        totalStaked -= amount;
        balanceOf[msg.sender] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _updateReward(msg.sender);
        amount = rewards[msg.sender];
        if (amount != 0) {
            rewards[msg.sender] = 0;
            totalRewardsClaimed += amount;
            IERC20(rewardCurrency).safeTransfer(msg.sender, amount);
        }
        emit RewardClaimed(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //  Rewards in — router only                                             //
    // --------------------------------------------------------------------- //

    /// @notice The router must have already transferred `amount` of rewardCurrency
    ///         to this vault before calling. Pull-based on the stake side, push-based
    ///         here because only the router (not stakers) triggers a notification.
    function notifyReward(uint256 amount) external onlyRouter nonReentrant {
        uint256 total = amount + pendingReward;
        if (total == 0) return;
        if (totalStaked == 0) {
            pendingReward = total;
            emit RewardNotified(amount, false, total);
            return;
        }
        rewardPerTokenStored += (total * PRECISION) / totalStaked;
        pendingReward = 0;
        totalRewardsNotified += total;
        emit RewardNotified(amount, true, 0);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                 //
    // --------------------------------------------------------------------- //

    function claimable(address account) external view returns (uint256) {
        return rewards[account] + (balanceOf[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / PRECISION;
    }

    // --------------------------------------------------------------------- //
    //  Internal                                                              //
    // --------------------------------------------------------------------- //

    function _updateReward(address account) internal {
        rewards[account] += (balanceOf[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / PRECISION;
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }
}
