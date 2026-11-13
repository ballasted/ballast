// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @title DeployElysiumLens — deploy the STANDARD v4 read lenses on Elysium (99901).
///
/// Elysium's v4 deployment ships the PoolManager + UniversalRouter, but NOT StateView /
/// V4Quoter (the Uniswap official list has no 99901 entry). These two are **stateless read
/// lenses** that only hold an immutable `poolManager` and read its storage — none of the
/// Robinhood `minHopPriceX36` swap-path fork lives in them, so deploying them from this
/// repo's v4-periphery is safe and gives the Elysium frontend clean pool-state reads
/// (StateView) and off-chain quotes (V4Quoter). No owner, no admin.
///
/// Verify after deploy: StateView.poolManager() == V4Quoter.poolManager() == the live
/// PoolManager 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1.
///
/// Run (no key — signer from --account/--sender):
///   forge script script/DeployElysiumLens.s.sol:DeployElysiumLens \
///     --rpc-url $ELY_MAINNET_RPC --account <KEYSTORE> --sender $ELY_MAINNET_DEPLOYER \
///     --broadcast --slow
contract DeployElysiumLens is Script {
    address constant POOL_MANAGER = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;

    function run() external returns (address stateView, address v4Quoter) {
        require(POOL_MANAGER.code.length > 0, "poolManager has no code on this chain");

        vm.startBroadcast();
        stateView = deployCode("StateView.sol:StateView", abi.encode(POOL_MANAGER));
        v4Quoter = deployCode("V4Quoter.sol:V4Quoter", abi.encode(POOL_MANAGER));
        vm.stopBroadcast();

        // Both must point at the live PoolManager.
        (bool a, bytes memory ra) = stateView.staticcall(abi.encodeWithSignature("poolManager()"));
        (bool b, bytes memory rb) = v4Quoter.staticcall(abi.encodeWithSignature("poolManager()"));
        require(a && abi.decode(ra, (address)) == POOL_MANAGER, "stateView.poolManager mismatch");
        require(b && abi.decode(rb, (address)) == POOL_MANAGER, "v4Quoter.poolManager mismatch");

        console2.log("=== DEPLOYED (paste into deployments/elysium-mainnet.json .v4) ===");
        console2.log("stateView:", stateView);
        console2.log("v4Quoter :", v4Quoter);
    }
}
