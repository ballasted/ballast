// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployElysium} from "../../script/DeployElysium.s.sol";

/// @dev Offline guard that script/DeployElysium.s.sol reads every config path/type the
///      way the live deploy will — a mistyped JSON key would otherwise only surface at
///      broadcast time. Runs the parser against a fully-populated fixture (no broadcast),
///      and spot-checks validate() rejects the ways a real config goes wrong.
contract DeployElysiumConfigTest is Test {
    DeployElysium script;
    string constant FIXTURE = "test/elysium/fixtures/elysium-fixture.json";

    function setUp() public {
        script = new DeployElysium();
    }

    function test_LoadConfig_ParsesEveryField() public view {
        DeployElysium.Cfg memory c = script.loadConfig(FIXTURE);

        assertEq(c.chainId, 31337, "chainId");
        assertFalse(c.isProduction, "isProduction");
        assertEq(c.poolManager, 0x1111111111111111111111111111111111111111, "poolManager");
        assertEq(c.whype, 0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234, "whype");
        assertEq(c.openingTickWhype, -174300, "openingTick");
        assertEq(c.tickSpacing, int24(60), "tickSpacing");
        assertEq(c.protocolFeeBps, 2000, "protocolFeeBps");
        assertEq(c.minFeeBps, 100, "minFeeBps");
        assertEq(c.maxFeeBps, 1000, "maxFeeBps");
        assertFalse(c.treasuryEnabled, "treasuryEnabled");
        assertEq(c.burnDestination, 0x000000000000000000000000000000000000bEEF, "burnDest");
        assertEq(c.owner, 0x00000000000000000000000000000000000050fe, "owner");
        assertEq(c.routerMaxSlippageBps, 2000, "routerMaxSlippageBps");
        // "0" in config means unlimited.
        assertEq(c.routerMaxRoutePerCall, type(uint256).max, "maxRoutePerCall -> unlimited");
        assertEq(c.routerRouteCooldown, 3600, "routeCooldown");
    }

    function test_Validate_AcceptsFixture() public {
        DeployElysium.Cfg memory c = script.loadConfig(FIXTURE);
        // validate() checks poolManager/whype have code on this chain.
        vm.etch(c.poolManager, hex"600160005260206000f3");
        vm.etch(c.whype, hex"600160005260206000f3");
        script.validate(c); // must not revert
    }

    function test_Validate_RejectsTreasuryEnabled() public {
        DeployElysium.Cfg memory c = _coded();
        c.treasuryEnabled = true;
        vm.expectRevert(bytes("treasuryEnabled must be false on Elysium (no feeds)"));
        script.validate(c);
    }

    function test_Validate_RejectsMisalignedOpeningTick() public {
        DeployElysium.Cfg memory c = _coded();
        c.openingTickWhype = -174299; // not a multiple of 60
        vm.expectRevert(bytes("openingTick not spacing-aligned"));
        script.validate(c);
    }

    function test_Validate_RejectsBadFeeBounds() public {
        DeployElysium.Cfg memory c = _coded();
        c.minFeeBps = 2000;
        c.maxFeeBps = 1000; // min > max
        vm.expectRevert(bytes("fee bounds invalid"));
        script.validate(c);
    }

    function test_Validate_RejectsWrongChainId() public {
        DeployElysium.Cfg memory c = _coded();
        c.chainId = 99801; // != block.chainid (31337)
        vm.expectRevert(bytes("config chainId != live chainId"));
        script.validate(c);
    }

    function _coded() internal returns (DeployElysium.Cfg memory c) {
        c = script.loadConfig(FIXTURE);
        vm.etch(c.poolManager, hex"600160005260206000f3");
        vm.etch(c.whype, hex"600160005260206000f3");
    }
}
