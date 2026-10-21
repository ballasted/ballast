// SPDX-License-Identifier: MIT
// 0.8.26 (not the repo's usual 0.8.28) — BasketStockBuyer inherits v4-periphery's
// V4Router, pinned to 0.8.26. Same reason DeployBasketZap.s.sol carries the pin.
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BasketStockBuyer} from "../src/BasketStockBuyer.sol";
import {BasketZap} from "../src/BasketZap.sol";
import {DeployBasketZap} from "./DeployBasketZap.s.sol";

/// @title DeployBasketStockBuyer — deploys the RoundupRouter IStockBuyer adapter.
///        DRY-RUN ONLY — no broadcast signed here.
///
/// @notice Sign with `--account <new-keystore> --sender <addr>` (interactive
///         password). No private keys. Never the compromised deployer.
///
///         Reuses DeployBasketZap's EXACT, already-verified fablesHops/ramsesRoutes
///         tables VERBATIM (translated field-for-field into BasketStockBuyer's
///         identically-shaped structs) so the round-up stock leg routes through the
///         same pools, verified the same way, as the live BasketZap — not re-derived.
///
///         ⚠️ BasketStockBuyer routes user funds and is NOT fork-tested on 4663 nor
///         audited. Both are REQUIRED before it is wired into RoundupRouter and the
///         NEXT_PUBLIC_ROUNDUP_ROUTER flag is enabled. See docs/security/roundups.md.
contract DeployBasketStockBuyer is Script {
    function run() external returns (BasketStockBuyer buyer) {
        DeployBasketZap zapCfg = new DeployBasketZap();
        BasketZap.FablesHop[] memory zf = zapCfg.buildFablesHops();
        BasketZap.RamsesRoute[] memory zr = zapCfg.buildRamsesRoutes();

        BasketStockBuyer.FablesHop[] memory hops = new BasketStockBuyer.FablesHop[](zf.length);
        for (uint256 i = 0; i < zf.length; i++) {
            hops[i] =
                BasketStockBuyer.FablesHop(zf[i].currency0, zf[i].currency1, zf[i].fee, zf[i].tickSpacing, zf[i].hooks);
        }
        BasketStockBuyer.RamsesRoute[] memory routes = new BasketStockBuyer.RamsesRoute[](zr.length);
        for (uint256 i = 0; i < zr.length; i++) {
            routes[i] = BasketStockBuyer.RamsesRoute(zr[i].pool, zr[i].tokenA, zr[i].tokenB);
        }

        vm.startBroadcast();
        buyer =
            new BasketStockBuyer(zapCfg.REGISTRY(), IPoolManager(zapCfg.POOL_MANAGER()), zapCfg.WETH(), hops, routes);
        vm.stopBroadcast();

        console2.log("BasketStockBuyer deployed:", address(buyer));
        console2.log("NEXT: fork-test + audit, then set ROUNDUP_STOCK_BUYER and run DeployRoundups.");
        console2.log("VERIFY: forge verify-contract <addr> src/BasketStockBuyer.sol:BasketStockBuyer");
        console2.log("  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
    }
}
