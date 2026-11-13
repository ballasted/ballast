// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title TestStockToken — a TESTNET-ONLY mock equity token for Elysium gen-5 dev
///
/// @notice NOT a real asset. NOT backed by anything. Exists only so Elysium testnet
///         has stock-shaped ERC-20s (tNVDA, tSPY) to build and test swap pairs and
///         allowlist plumbing against while no bridged xStocks/Ondo assets exist.
///
/// @dev Name and symbol are deliberately prefixed to make it impossible to mistake
///      for a real asset in any UI or explorer. There is a permissionless `mint`
///      faucet — acceptable because this contract must NEVER be deployed on mainnet
///      (it is absent from deployments/elysium-mainnet.json by construction). 18
///      decimals to match the ERC-8056 stock-token shape gen-5 pools expect.
contract TestStockToken is ERC20 {
    uint8 private constant _DECIMALS = 18;

    constructor(string memory name_, string memory symbol_, uint256 initialMint, address mintTo)
        ERC20(string.concat("Ballast TESTNET ", name_), string.concat("t", symbol_))
    {
        if (initialMint != 0 && mintTo != address(0)) _mint(mintTo, initialMint);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Open faucet — testnet only. Mint yourself test balance.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
