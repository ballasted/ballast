// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Models the access-control gate the Session 0 probe found on a real
///         Robinhood Stock Token. Every SGOV transfer/approve delegates through an
///         `AccessControlsRegistry` that checks a global `paused()` flag and an
///         `isBlocked(address)` deny-list on BOTH parties.
///
/// @dev Faithful to what the mainnet trace showed:
///        - `transfer` / `transferFrom` / `approve` are GATED (paused + isBlocked).
///        - `balanceOf` / `totalSupply` / `decimals` are NOT gated — reads always
///          work, even while paused. Valuation depends on this.
///        - ERC-8056 surface (`uiMultiplier`, `oraclePaused`, `balanceOfUI`,
///          `totalSupplyUI`) is present. Note `paused` (transfer gate) and
///          `oraclePaused` (advisory corporate-action flag) are DIFFERENT flags.
contract MockStockToken is ERC20 {
    uint8 private immutable _decimals;

    bool public paused; // AccessControlsRegistry.paused() — transfer gate
    bool public oraclePaused; // ERC-8056 advisory corporate-action flag
    uint256 public uiMultiplier = 1e18; // ERC-8056; 1e18 = 1.0
    mapping(address => bool) public isBlocked; // deny-list

    error TransfersPaused();
    error AddressBlocked(address who);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // --- issuer controls (test knobs mirroring the registry) --------------
    function setPaused(bool p) external {
        paused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    function setBlocked(address who, bool blocked) external {
        isBlocked[who] = blocked;
    }

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    // --- ERC-8056 UI helpers (ungated reads) ------------------------------
    function balanceOfUI(address account) external view returns (uint256) {
        return (balanceOf(account) * uiMultiplier) / 1e18;
    }

    function totalSupplyUI() external view returns (uint256) {
        return (totalSupply() * uiMultiplier) / 1e18;
    }

    // --- gated mutating paths ---------------------------------------------
    function approve(address spender, uint256 value) public override returns (bool) {
        _gate(msg.sender, spender);
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Skip block/pause checks for mint (from==0) / burn (to==0) so test setup
        // can fund actors; real transfers between two real addresses are gated.
        if (from != address(0) && to != address(0)) {
            _gate(from, to);
        }
        super._update(from, to, value);
    }

    function _gate(address a, address b) internal view {
        if (paused) revert TransfersPaused();
        if (isBlocked[a]) revert AddressBlocked(a);
        if (isBlocked[b]) revert AddressBlocked(b);
    }
}
