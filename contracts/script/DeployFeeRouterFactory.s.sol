// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRouterFactory} from "../src/FeeRouterFactory.sol";

/// @title DeployFeeRouterFactory — deploys the stateless FeeRouterFactory
///
/// @notice No private key read by this script — sign with `--account
///         feerouter-deployer --password-file
///         ~/.foundry/keystores/feerouter-deployer.pass`. This is a BRAND NEW
///         keystore created specifically for this deploy, never the old
///         (compromised) deployer. FeeRouterFactory has no constructor args and no
///         owner — it only ever deploys per-token FeeRouter instances on demand.
///
/// Run:
///   forge script script/DeployFeeRouterFactory.s.sol:DeployFeeRouterFactory \
///     --rpc-url robinhood_mainnet --account feerouter-deployer \
///     --password-file ~/.foundry/keystores/feerouter-deployer.pass --broadcast
contract DeployFeeRouterFactory is Script {
    function run() external returns (FeeRouterFactory factory) {
        vm.startBroadcast();
        factory = new FeeRouterFactory();
        vm.stopBroadcast();

        console2.log("FeeRouterFactory deployed:", address(factory));
        console2.log("NEXT: forge verify-contract", address(factory));
        console2.log("src/FeeRouterFactory.sol:FeeRouterFactory --verifier blockscout");
        console2.log("--verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
    }
}
