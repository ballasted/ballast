// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @title FeeConfig
/// @notice Owner-managed global fee parameters + referrer allowlist, read LIVE by
///         the singleton BallastHook. One config serves every pool, so the fee and
///         split can be retuned without redeploying pools (CLAUDE.md: read
///         owner-settable globals live, never hardcode economic parameters).
///
/// @dev Referrers are allowlisted from day one. `hookData` on a swap is
///      swapper-controlled, so an open referrer field would let sophisticated
///      traders self-refer for a 15% rebate that ordinary UI users never get — a
///      hidden discount on a platform whose pitch is that nothing is hidden, and
///      hard to remove later once pools rely on it. Unknown/unregistered referrer
///      => the referrer share rolls to the platform (see effectiveReferrer).
contract FeeConfig is Ownable {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // 10% hard cap (sanity)

    /// @notice Where the platform's fee share accrues.
    address public platformVault;

    /// @notice Total swap fee on the WETH leg, in bps (100 = 1%).
    uint16 public feeBps;
    /// @notice Split of the collected fee, all out of BPS; must sum to BPS.
    uint16 public creatorBps;
    uint16 public platformBps;
    uint16 public referrerBps;

    /// @notice Owner-managed referrer allowlist (registration is manual/off-chain
    ///         for now; opening it up later is the easy direction).
    mapping(address => bool) public isReferrer;

    event ParamsUpdated(uint16 feeBps, uint16 creatorBps, uint16 platformBps, uint16 referrerBps);
    event PlatformVaultUpdated(address indexed vault);
    event ReferrerSet(address indexed referrer, bool allowed);

    error BadSplit();
    error BadFee();
    error ZeroAddress();

    constructor(address owner_, address platformVault_) Ownable(owner_) {
        if (platformVault_ == address(0)) revert ZeroAddress();
        platformVault = platformVault_;
        feeBps = 100; // 1%
        creatorBps = 5_000; // 50% of the fee
        platformBps = 3_500; // 35%
        referrerBps = 1_500; // 15%
    }

    /// @notice Update fee + split. Split must sum to exactly BPS; fee is capped.
    function setParams(uint16 feeBps_, uint16 creatorBps_, uint16 platformBps_, uint16 referrerBps_)
        external
        onlyOwner
    {
        if (feeBps_ == 0 || feeBps_ > MAX_FEE_BPS) revert BadFee();
        if (uint256(creatorBps_) + platformBps_ + referrerBps_ != BPS) revert BadSplit();
        feeBps = feeBps_;
        creatorBps = creatorBps_;
        platformBps = platformBps_;
        referrerBps = referrerBps_;
        emit ParamsUpdated(feeBps_, creatorBps_, platformBps_, referrerBps_);
    }

    function setPlatformVault(address vault) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        platformVault = vault;
        emit PlatformVaultUpdated(vault);
    }

    function setReferrer(address referrer, bool allowed) external onlyOwner {
        if (referrer == address(0)) revert ZeroAddress();
        isReferrer[referrer] = allowed;
        emit ReferrerSet(referrer, allowed);
    }

    /// @notice Resolve a swap-supplied referrer: an allowlisted address maps to
    ///         itself; anything else maps to address(0), telling the hook to roll
    ///         the referrer share to the platform.
    function effectiveReferrer(address referrer) external view returns (address) {
        return isReferrer[referrer] ? referrer : address(0);
    }

    /// @notice Full fee params in one read for the hook.
    function feeParams()
        external
        view
        returns (uint16 feeBps_, uint16 creatorBps_, uint16 platformBps_, uint16 referrerBps_, address platformVault_)
    {
        return (feeBps, creatorBps, platformBps, referrerBps, platformVault);
    }
}
