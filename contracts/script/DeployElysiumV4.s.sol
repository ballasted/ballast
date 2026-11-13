// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @title DeployElysiumV4 — TESTNET-ONLY self-deploy of the v4 pieces gen-5 needs
///
/// @notice Elysium TESTNET has no published Uniswap v4 deployment, so we self-deploy the
///         minimum v4 surface gen-5 depends on to exercise the full launch→graduate→swap
///         path end to end:
///
///           - PoolManager            (the singleton gen-5's hook + seeder bind to)
///           - PoolSwapTest           (a router to drive validation swaps)
///           - PoolModifyLiquidityTest(an LP router for controlled-pool checks)
///           - StateView              (read slot0 / fee growth for the frontend)
///           - V4Quoter               (off-chain quotes for the frontend)
///
///         These are deployed from the v4-core/periphery artifacts via `deployCode` —
///         the same mechanism the Gen5 test suite uses, because v4-core's PoolManager is
///         pinned to solc 0.8.26 and cannot be imported into this 0.8.28 script directly.
///
/// @dev STRICTLY TESTNET. This is non-production use of BUSL-1.1 v4-core (permitted for
///      testing — see the runbook). On MAINNET you MUST use the OFFICIAL Uniswap v4
///      deployment published at chain launch and bytecode-verify every address; NEVER run
///      this script against mainnet. The script refuses any chain whose id is not the
///      testnet id in the config.
///
/// Required env:
///   ELYSIUM_CONFIG         — deployments/elysium-testnet.json (used only to assert chainId)
///   DEPLOYER_PRIVATE_KEY   — funded testnet deployer
///
/// Run:
///   ELYSIUM_CONFIG=deployments/elysium-testnet.json \
///   forge script script/DeployElysiumV4.s.sol:DeployElysiumV4 \
///     --rpc-url $ELYSIUM_TESTNET_RPC_URL --sender $DEPLOYER --broadcast
///
/// Then paste the logged addresses into the config's `.v4` block and run DeployElysium.
contract DeployElysiumV4 is Script {
    function run()
        external
        returns (address poolManager, address swapRouter, address lpRouter, address stateView, address v4Quoter)
    {
        string memory json = vm.readFile(vm.envString("ELYSIUM_CONFIG"));
        uint256 cfgChainId = vm.parseJsonUint(json, ".chainId");
        bool isProduction = vm.parseJsonBool(json, ".isProduction");

        require(!isProduction, "DeployElysiumV4 is TESTNET-ONLY; mainnet uses official v4");
        require(cfgChainId == block.chainid, "config chainId != live chainId");

        // No private key read. The signer comes from --account/--sender.
        address deployer = msg.sender;

        console2.log("=== DeployElysiumV4 (TESTNET self-deploy) ===");
        console2.log("chainId  :", block.chainid);
        console2.log("deployer :", deployer);

        vm.startBroadcast();

        poolManager = vm.deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
        swapRouter = vm.deployCode("PoolSwapTest.sol:PoolSwapTest", abi.encode(poolManager));
        lpRouter = vm.deployCode("PoolModifyLiquidityTest.sol:PoolModifyLiquidityTest", abi.encode(poolManager));
        stateView = vm.deployCode("StateView.sol:StateView", abi.encode(poolManager));
        v4Quoter = vm.deployCode("V4Quoter.sol:V4Quoter", abi.encode(poolManager));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== DEPLOYED (paste into the config's `.v4` block) ===");
        console2.log("poolManager   :", poolManager);
        console2.log("positionManager: (none - gen-5 seeder owns + locks its own LP; the");
        console2.log("                  swap/lp routers below cover testnet validation)");
        console2.log("stateView     :", stateView);
        console2.log("v4Quoter      :", v4Quoter);
        console2.log("universalRouter: (none on testnet - use PoolSwapTest below for swaps)");
        console2.log("");
        console2.log("--- testnet-only swap/LP helpers (not config `.v4` fields) ---");
        console2.log("poolSwapTest          :", swapRouter);
        console2.log("poolModifyLiquidityTest:", lpRouter);
        console2.log("");
        console2.log("Next: set ELYSIUM_POOL_MANAGER=%s and re-run the fork test.", poolManager);
    }
}
