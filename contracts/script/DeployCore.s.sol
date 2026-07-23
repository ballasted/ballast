// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {BackingLens} from "../src/BackingLens.sol";

/// @notice Deploys the two chain-independent core contracts: the global asset
///         allowlist and the backing-read Lens.
///
///         ProjectTreasury is deployed per-launch by BallastFactory, so it is not
///         deployed here. The factory + token + Uniswap v4 pool are intentionally
///         NOT in this script: pool routing depends on the modified UniversalRouter
///         whose v4 swap-struct encoding (`minHopPriceX36`) must be verified
///         independently first — see docs/robinhood-chain-research.md §4.
///
/// Required env:
///   PROTOCOL_OWNER_ADDRESS         — owner of the registry (use a multisig on mainnet)
///   SEQUENCER_UPTIME_FEED_ADDRESS  — Chainlink L2 sequencer feed for this chain
///   DEPLOYER_PRIVATE_KEY           — funded deployer
///
/// Run (testnet):
///   forge script script/DeployCore.s.sol:DeployCore \
///     --rpc-url robinhood_testnet --broadcast \
///     --verify --verifier blockscout --chain-id 46630
contract DeployCore is Script {
    function run() external returns (AssetRegistry registry, BackingLens lens) {
        address owner = vm.envAddress("PROTOCOL_OWNER_ADDRESS");
        // Optional: Robinhood Chain (4663) has no L2 sequencer uptime feed today.
        // When unset, BackingLens reports sequencerStatus = Unknown and still
        // values (the UI surfaces "sequencer unverifiable"). Set it later — with no
        // code change — if Chainlink publishes one.
        address sequencerFeed = vm.envOr("SEQUENCER_UPTIME_FEED_ADDRESS", address(0));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        require(owner != address(0), "PROTOCOL_OWNER_ADDRESS unset");
        if (sequencerFeed == address(0)) {
            console2.log("WARNING: no SEQUENCER_UPTIME_FEED_ADDRESS set - status will be Unknown");
        }

        vm.startBroadcast(pk);
        registry = new AssetRegistry(owner);
        lens = new BackingLens(sequencerFeed);
        vm.stopBroadcast();

        console2.log("AssetRegistry:", address(registry));
        console2.log("BackingLens:  ", address(lens));
        console2.log("Registry owner:", owner);
        console2.log("Sequencer feed:", sequencerFeed);
    }
}
