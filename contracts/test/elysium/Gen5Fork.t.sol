// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Fork harness against Elysium testnet (chain 99801). Skips unless
///      ELYSIUM_TESTNET_RPC_URL is set, so `forge test` stays green offline.
///
///      Today it verifies the infrastructure gen-5 depends on that ALREADY exists on
///      testnet (WHYPE identity, Multicall3, CREATE2 deployer, Permit2). Once you
///      self-deploy v4-core on testnet and fill deployments/elysium-testnet.json, set
///      ELYSIUM_POOL_MANAGER to exercise the live PoolManager too. No broadcast, reads
///      only.
contract Gen5ForkTest is Test {
    address constant WHYPE = 0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234;
    address constant USDC = 0x7D29d8047B905000459c0E80c34a26CeedcB47b2;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bool forked;

    function setUp() public {
        string memory url = vm.envOr("ELYSIUM_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            return; // skip offline
        }
        vm.createSelectFork(url);
        assertEq(block.chainid, 99801, "not Elysium testnet");
        forked = true;
    }

    function test_Infra_Present() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertGt(WHYPE.code.length, 0, "WHYPE");
        assertGt(USDC.code.length, 0, "USDC");
        assertGt(MULTICALL3.code.length, 0, "Multicall3");
        assertGt(CREATE2_DEPLOYER.code.length, 0, "CREATE2 deployer");
        assertGt(PERMIT2.code.length, 0, "Permit2");
    }

    function test_WHYPE_Identity() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(IERC20Metadata(WHYPE).decimals(), 18, "WHYPE decimals");
        assertEq(IERC20Metadata(WHYPE).symbol(), "WHYPE", "WHYPE symbol");
    }

    function test_PoolManager_IfDeployed() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address pm = vm.envOr("ELYSIUM_POOL_MANAGER", address(0));
        if (pm == address(0)) {
            vm.skip(true); // v4 not self-deployed yet
            return;
        }
        assertGt(pm.code.length, 0, "PoolManager has code");
    }
}
