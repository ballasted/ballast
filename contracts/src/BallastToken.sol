// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title BallastToken
/// @notice A launch's project token: ERC-20, fixed supply, mint authority
///         renounced. The full supply is minted once in the constructor and there
///         is NO mint function anywhere — so no admin mint can ever occur
///         (build-spec §4.1).
///
/// @dev The treasury pointer is "immutable in spirit" but implemented as a
///      write-once initializer, not the `immutable` keyword. The token and its
///      ProjectTreasury reference each other at deploy time (the treasury needs the
///      token address for its self-backing block, the token needs the treasury
///      address to publish it), which is a circular constructor dependency. The
///      factory resolves it by deploying the token, then the treasury (passing the
///      token), then calling `initTreasury` exactly once. After that call the
///      pointer can NEVER change — the treasury cannot be swapped later, which is
///      the guarantee the spec requires.
contract BallastToken is ERC20 {
    /// @notice The factory that launched this token (the only caller of initTreasury).
    address public immutable factory;
    /// @notice The creator who launched the project.
    address public immutable creator;

    /// @notice The project's ProjectTreasury. Set once, at launch, then permanent.
    address public treasury;
    bool private _treasurySet;

    error OnlyFactory();
    error TreasuryAlreadySet();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint256 supply, address creator_, address mintTo)
        ERC20(name_, symbol_)
    {
        if (creator_ == address(0) || mintTo == address(0)) revert ZeroAddress();
        factory = msg.sender;
        creator = creator_;
        // Full fixed supply minted once. No mint function exists => mint authority
        // is renounced by construction; supply is permanently fixed.
        _mint(mintTo, supply);
    }

    /// @notice Publish the treasury address exactly once, callable only by the
    ///         factory during launch. Reverts on any later attempt — the pointer is
    ///         permanent.
    function initTreasury(address treasury_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (_treasurySet) revert TreasuryAlreadySet();
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        _treasurySet = true;
    }
}
