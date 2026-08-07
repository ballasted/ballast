// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @dev The BallastHook fee ledger — the platform's WETH fee share accrues here and is
///      pulled with claim() (which pays msg.sender, i.e. this contract).
interface IBallastHookClaim {
    function claim() external returns (uint256);
    function owed(address recipient) external view returns (uint256);
}

/// @title FeeSplitter — routes a share of the platform's WETH fee to the buyback, the rest to the platform
///
/// @notice Set this as `FeeConfig.platformVault`. The platform's fee share then accrues
///         here as `owed[this]` on each configured hook. Anyone may call `distribute()`:
///         it claims that WETH and splits it — `buybackBps` to the (immutable) buyback
///         contract, the remainder to the owner-set platform recipient. Permissionless
///         and pull-based, so it is a mechanism, not a promise that depends on anyone
///         remembering — the same shape as the buyback itself.
///
/// @dev Trust properties, by construction:
///      • The `buyback` address is IMMUTABLE — the burn-bound share can never be redirected.
///      • `buybackBps` is bounded to [MIN_BUYBACK_BPS, MAX_BUYBACK_BPS] so the owner can
///        retune the split but can never silently starve either side to 0 or take it to 100%.
///      • NO generic withdrawal path: WETH only ever leaves via `distribute()` to the two
///        configured sinks in the capped ratio. The owner may retune the ratio (within
///        bounds), the platform recipient, and which hooks to sweep — never pull funds
///        to an arbitrary destination. The buyback's cut is nailed to a fixed address.
contract FeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    /// @notice Neither side may be starved: the buyback share stays within [10%, 90%].
    uint16 public constant MIN_BUYBACK_BPS = 1_000;
    uint16 public constant MAX_BUYBACK_BPS = 9_000;

    address public immutable weth;
    /// @notice The BuybackBurner. IMMUTABLE — the burn-bound share can never be redirected.
    address public immutable buyback;

    /// @notice Where the platform's remaining share goes (e.g. move to a Safe later).
    address public platformRecipient;
    /// @notice Share of each distribution sent to the buyback, in bps. Retunable within bounds.
    uint16 public buybackBps;

    /// @notice Hooks whose `owed(this)` we sweep before splitting.
    address[] public claimHooks;

    uint256 public totalToBuyback;
    uint256 public totalToPlatform;

    event Distributed(address indexed caller, uint256 toBuyback, uint256 toPlatform);
    event BuybackBpsSet(uint16 bps);
    event PlatformRecipientSet(address indexed recipient);
    event ClaimHooksSet(address[] hooks);

    error ZeroAddress();
    error BpsOutOfBounds();
    error NothingToDistribute();

    constructor(
        address weth_,
        address buyback_,
        address platformRecipient_,
        uint16 buybackBps_,
        address[] memory claimHooks_,
        address owner_
    ) Ownable(owner_) {
        if (weth_ == address(0) || buyback_ == address(0) || platformRecipient_ == address(0)) revert ZeroAddress();
        if (buybackBps_ < MIN_BUYBACK_BPS || buybackBps_ > MAX_BUYBACK_BPS) revert BpsOutOfBounds();
        weth = weth_;
        buyback = buyback_;
        platformRecipient = platformRecipient_;
        buybackBps = buybackBps_;
        claimHooks = claimHooks_;
    }

    // --------------------------------------------------------------------- //
    //  Owner controls — tuning only, never a way to remove the funds        //
    // --------------------------------------------------------------------- //
    function setBuybackBps(uint16 bps) external onlyOwner {
        if (bps < MIN_BUYBACK_BPS || bps > MAX_BUYBACK_BPS) revert BpsOutOfBounds();
        buybackBps = bps;
        emit BuybackBpsSet(bps);
    }

    function setPlatformRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        platformRecipient = recipient;
        emit PlatformRecipientSet(recipient);
    }

    function setClaimHooks(address[] calldata hooks) external onlyOwner {
        claimHooks = hooks;
        emit ClaimHooksSet(hooks);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                //
    // --------------------------------------------------------------------- //
    function claimHooksLength() external view returns (uint256) {
        return claimHooks.length;
    }

    /// @notice WETH available to a distribution right now: held plus still-claimable.
    function accruedWeth() external view returns (uint256 total) {
        total = IERC20(weth).balanceOf(address(this));
        for (uint256 i; i < claimHooks.length; ++i) {
            total += IBallastHookClaim(claimHooks[i]).owed(address(this));
        }
    }

    // --------------------------------------------------------------------- //
    //  Distribute — permissionless                                          //
    // --------------------------------------------------------------------- //
    /// @notice Claim accrued WETH from every configured hook, then split the held balance:
    ///         `buybackBps` to the buyback, the remainder to the platform recipient.
    function distribute() external nonReentrant returns (uint256 toBuyback, uint256 toPlatform) {
        for (uint256 i; i < claimHooks.length; ++i) {
            IBallastHookClaim(claimHooks[i]).claim();
        }
        uint256 bal = IERC20(weth).balanceOf(address(this));
        if (bal == 0) revert NothingToDistribute();

        toBuyback = (bal * buybackBps) / BPS;
        toPlatform = bal - toBuyback; // remainder, so no wei is lost to rounding

        if (toBuyback > 0) IERC20(weth).safeTransfer(buyback, toBuyback);
        if (toPlatform > 0) IERC20(weth).safeTransfer(platformRecipient, toPlatform);

        totalToBuyback += toBuyback;
        totalToPlatform += toPlatform;
        emit Distributed(msg.sender, toBuyback, toPlatform);
    }
}
