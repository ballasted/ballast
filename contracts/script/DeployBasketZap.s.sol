// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BasketZap} from "../src/BasketZap.sol";

/// @title DeployBasketZap — deploys the immutable, ownerless Stock Basket swap helper
///
/// @notice No private key read here — sign with `--account <new-keystore>
///         --password-file <path>`. Use a NEW keystore, never the old deployer
///         (same pattern as DeployV1Claim.s.sol / DeployBuybackV2.s.sol).
///
///         All five constructor addresses are fixed, verified mainnet
///         addresses (docs/BASKET_DISCOVERY.md §1, docs/robinhood-chain-research.md
///         §4) — nothing to configure via env.
///
///         IMPORTANT — read before deploying (docs/BASKET_DISCOVERY.md §2,
///         docs/DECISIONS.md §3): as of this build, NO on-chain WETH pool
///         exists for any of the 16 AssetRegistry-listed assets, so the
///         Stock Basket feature has nothing to swap through on real mainnet
///         yet. Deploying this contract is safe (it holds no funds, has no
///         admin surface, and a swap simply reverts with no route to take) —
///         but the frontend flag (NEXT_PUBLIC_BASKET_ENABLED) and route table
///         (web/lib/basketRoutes.ts) should stay off/empty until a real route
///         is sourced and verified, so the picker never offers a basket that
///         can't execute.
contract DeployBasketZap is Script {
    address constant FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external returns (BasketZap zap) {
        vm.startBroadcast();
        zap = new BasketZap(FACTORY, REGISTRY, WETH, UNIVERSAL_ROUTER, PERMIT2);
        vm.stopBroadcast();

        console2.log("BasketZap deployed:", address(zap));
    }
}
