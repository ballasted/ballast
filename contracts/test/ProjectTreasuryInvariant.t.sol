// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AssetRegistry, MarketHours} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Drives random valid sequences over the treasury and tracks ghost totals,
///      so the invariants below hold under ANY ordering of deposits / proposals /
///      accepts / declines / reclaims / announce / execute / cancel.
contract TreasuryHandler is Test {
    ProjectTreasury public t;
    MockERC20 public asset;
    address public creator = makeAddr("creator");
    address[3] public tps = [makeAddr("tp0"), makeAddr("tp1"), makeAddr("tp2")];

    uint256 public gCreatorDeposited;
    uint256 public gCreatorWithdrawn;
    uint256 public gThirdPartyAccepted;

    uint256[] internal pending; // proposeDeposit ids not yet resolved
    uint256 internal activeWithdrawalId;
    uint256 internal activeWithdrawalAmt;

    uint256 constant MINTED = 1e30;

    constructor(ProjectTreasury t_, MockERC20 asset_) {
        t = t_;
        asset = asset_;
        asset.mint(creator, MINTED);
        vm.prank(creator);
        asset.approve(address(t), type(uint256).max);
        for (uint256 i = 0; i < tps.length; i++) {
            asset.mint(tps[i], MINTED);
            vm.prank(tps[i]);
            asset.approve(address(t), type(uint256).max);
        }
    }

    function creatorDeposit(uint256 amt) public {
        amt = bound(amt, 1e15, 1e24);
        if (asset.balanceOf(creator) < amt) return;
        vm.prank(creator);
        t.deposit(address(asset), amt);
        gCreatorDeposited += amt;
    }

    function proposeAccept(uint256 who, uint256 amt) public {
        address tp = tps[who % tps.length];
        amt = bound(amt, 1e15, 1e24);
        if (asset.balanceOf(tp) < amt) return;
        vm.prank(tp);
        uint256 id = t.proposeDeposit(address(asset), amt, keccak256("d"));
        vm.prank(creator);
        t.acceptDeposit(id);
        gThirdPartyAccepted += amt;
    }

    function proposeDecline(uint256 who, uint256 amt) public {
        address tp = tps[who % tps.length];
        amt = bound(amt, 1e15, 1e24);
        if (asset.balanceOf(tp) < amt) return;
        vm.prank(tp);
        uint256 id = t.proposeDeposit(address(asset), amt, keccak256("d"));
        vm.prank(creator);
        t.declineDeposit(id); // returns funds; not locked, not creator-withdrawable
    }

    function announce(uint256 amt) public {
        if (activeWithdrawalId != 0) return;
        uint256 avail = t.creatorWithdrawable(address(asset));
        if (avail == 0) return;
        amt = bound(amt, 1, avail);
        vm.prank(creator);
        activeWithdrawalId = t.announceWithdrawal(address(asset), amt);
        activeWithdrawalAmt = amt;
    }

    function executeWithdrawal(uint256 warpBy) public {
        if (activeWithdrawalId == 0) return;
        vm.warp(block.timestamp + t.noticePeriod() + bound(warpBy, 0, 5 days));
        vm.prank(creator);
        t.executeWithdrawal(activeWithdrawalId);
        gCreatorWithdrawn += activeWithdrawalAmt;
        activeWithdrawalId = 0;
    }

    function cancel() public {
        if (activeWithdrawalId == 0) return;
        vm.prank(creator);
        t.cancelWithdrawal(activeWithdrawalId);
        activeWithdrawalId = 0;
    }
}

contract ProjectTreasuryInvariantTest is Test {
    ProjectTreasury treasury;
    AssetRegistry registry;
    MockERC20 asset;
    MockERC20 projectToken;
    TreasuryHandler handler;
    address owner = makeAddr("owner");

    function setUp() public {
        registry = new AssetRegistry(owner);
        asset = new MockERC20("Asset", "AST", 18);
        projectToken = new MockERC20("PRJ", "PRJ", 18);
        vm.prank(owner);
        registry.setAsset(address(asset), address(0xFEED), 3 days, 1e12, MarketHours.UsEquities24_5);

        // creator == the handler's creator address.
        treasury = new ProjectTreasury(address(projectToken), makeAddr("creator"), 30 days, address(registry));
        handler = new TreasuryHandler(treasury, asset);
        targetContract(address(handler));
    }

    /// The creator can never withdraw more than they deposited — under any sequence.
    function invariant_creatorNeverOverWithdraws() public view {
        assertLe(handler.gCreatorWithdrawn(), handler.gCreatorDeposited(), "creator withdrew more than deposited");
    }

    /// Withdrawable accounting is exactly deposits minus withdrawals.
    function invariant_withdrawableAccounting() public view {
        assertEq(
            treasury.creatorWithdrawable(address(asset)),
            handler.gCreatorDeposited() - handler.gCreatorWithdrawn(),
            "withdrawable != deposited - withdrawn"
        );
    }

    /// Accepted third-party deposits are PERMANENTLY locked: lockedBalance equals
    /// everything ever accepted (never withdrawn by anyone), and those tokens are
    /// always physically present in the treasury.
    function invariant_thirdPartyNeverWithdrawable() public view {
        assertEq(treasury.lockedBalance(address(asset)), handler.gThirdPartyAccepted(), "locked != accepted");
        assertGe(
            asset.balanceOf(address(treasury)),
            treasury.lockedBalance(address(asset)) + treasury.creatorWithdrawable(address(asset)),
            "treasury short of locked + withdrawable"
        );
    }
}
