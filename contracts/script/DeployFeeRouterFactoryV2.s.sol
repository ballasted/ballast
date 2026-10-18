// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRouterFactoryV2} from "../src/FeeRouterFactoryV2.sol";

/// @title DeployFeeRouterFactoryV2 — deploys the stateless FeeRouterFactoryV2
///
/// @notice Sign with the `feerouter-deployer` keystore and type its password at the
///         interactive prompt (never a password file on disk, never -k). This is the
///         SAME brand-new keystore used for v1; v2 does NOT touch the deployed v1
///         factory or any live contract. FeeRouterFactoryV2's only constructor arg
///         is the immutable BasketZap address (for FeeRouterV2.runBasket); no owner.
///
/// Dry-run (simulate, no broadcast — prints the gas estimate + predicted address):
///   forge script script/DeployFeeRouterFactoryV2.s.sol:DeployFeeRouterFactoryV2 \
///     --rpc-url robinhood_mainnet \
///     --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf
///
/// Broadcast (password typed at the prompt):
///   forge script script/DeployFeeRouterFactoryV2.s.sol:DeployFeeRouterFactoryV2 \
///     --rpc-url robinhood_mainnet --account feerouter-deployer \
///     --sender 0xD316888628c75A87e15A15DE36821Fe7371f0cBf --broadcast
contract DeployFeeRouterFactoryV2 is Script {
    /// @notice The live, immutable BasketZap on Robinhood Chain (4663) — every
    ///         FeeRouterV2 this factory deploys is wired to it for runBasket.
    address constant BASKET_ZAP = 0x87c046aB0fB8B7B86BA1a62A956242d499051aBA;

    function run() external returns (FeeRouterFactoryV2 factory) {
        vm.startBroadcast();
        factory = new FeeRouterFactoryV2(BASKET_ZAP);
        vm.stopBroadcast();

        console2.log("FeeRouterFactoryV2 deployed:", address(factory));
        console2.log("NEXT: forge verify-contract", address(factory));
        console2.log("src/FeeRouterFactoryV2.sol:FeeRouterFactoryV2 --verifier blockscout");
        console2.log("--verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
        console2.log("THEN set NEXT_PUBLIC_FEE_ROUTER_FACTORY_V2_ADDRESS to the address above");
    }
}
