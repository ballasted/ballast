// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BallastFactory} from "../src/BallastFactory.sol";

/// @title ResumeLaunch — seed the pool of a half-launched token
/// @notice A token whose `launch()` succeeded but whose `graduate()` never ran is a
///         dead token: it has no pool, no price. `graduate()` is permissionless, so
///         ANY funded wallet can finish the launch. This script calls it, and is
///         idempotent — if the token is already graduated it no-ops instead of
///         reverting, so it is safe to re-run after a lost/uncertain transaction.
///
/// Defaults resume the first stuck token on mainnet; override via env to resume any:
///   TOKEN   — the token to seed (default: 0x069a…F7F3, the first launch)
///   FACTORY — the BallastFactory (default: the deployed mainnet factory)
///   DRY_RUN — "true" to only read state and simulate, writing nothing
///
///   TOKEN=0x… forge script script/ResumeLaunch.s.sol:ResumeLaunch \
///     --rpc-url $RH_MAINNET_RPC_URL --broadcast
contract ResumeLaunch is Script {
    address constant DEFAULT_FACTORY = 0x069974136c78Cf0F2162463B95321E59F56523D8;
    address constant DEFAULT_TOKEN = 0x069a260370C61d91bd3e9842d81D378F9750F7F3;

    function run() external {
        address factoryAddr = vm.envOr("FACTORY", DEFAULT_FACTORY);
        address token = vm.envOr("TOKEN", DEFAULT_TOKEN);
        bool dryRun = vm.envOr("DRY_RUN", false);
        BallastFactory factory = BallastFactory(factoryAddr);

        console2.log("=== ResumeLaunch ===");
        console2.log("factory:", factoryAddr);
        console2.log("token:  ", token);

        // Confirm it's a real launch and read its current state.
        uint256 idPlus1 = factory.launchIdOf(token);
        require(idPlus1 != 0, "not a launch token on this factory");
        bool already = factory.graduated(token);
        console2.log("graduated (before):", already);
        if (already) {
            console2.log("Already graduated - nothing to do.");
            return;
        }

        if (dryRun) {
            console2.log("DRY-RUN: would call graduate() to seed the pool. No write.");
            return;
        }

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        factory.graduate(token);
        vm.stopBroadcast();

        console2.log("graduated (after): ", factory.graduated(token));
        console2.log("Pool seeded. Token page should now show a live market price.");
    }
}
