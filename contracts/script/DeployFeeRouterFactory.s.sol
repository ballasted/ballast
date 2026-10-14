// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRouterFactory} from "../src/FeeRouterFactory.sol";

/// @title DeployFeeRouterFactory — deploys the stateless FeeRouterFactory
///
/// @notice No private key read by this script — sign with the `feerouter-deployer`
///         keystore and type its password at the interactive prompt (never a
///         password file on disk). This is a BRAND NEW keystore created
///         specifically for this deploy, never the old (compromised) deployer.
///         FeeRouterFactory has no constructor args and no owner — it only ever
///         deploys per-token FeeRouter instances on demand.
///
/// Dry-run (simulate, no broadcast — prints the gas estimate):
///   forge script script/DeployFeeRouterFactory.s.sol:DeployFeeRouterFactory \
///     --rpc-url robinhood_mainnet \
///     --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf
///
/// Broadcast (after funding the sender; password typed at the prompt):
///   forge script script/DeployFeeRouterFactory.s.sol:DeployFeeRouterFactory \
///     --rpc-url robinhood_mainnet --account feerouter-deployer \
///     --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf --broadcast
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
