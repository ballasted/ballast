// SPDX-License-Identifier: MIT
// 0.8.26 — shares BasketZap's import graph (v4-periphery's V4Router).
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BasketZap} from "../../src/BasketZap.sol";
import {DeployBasketZap} from "../DeployBasketZap.s.sol";

interface IBallastFactoryFull {
    function launch(string calldata name_, string calldata symbol_, uint256 noticePeriod, string calldata metadataURI, address[] calldata quoteAssets_)
        external
        returns (uint256 id, address token, address treasury);
}

/// @title DeploySetupBasketE2E — TEST-ONLY fixture for the Playwright e2e suite.
///
/// @notice Run ONLY against a local Anvil fork (`--rpc-url http://127.0.0.1:8545`),
///         NEVER against real Robinhood Chain. Uses Anvil's universally-known
///         default dev account #0 (zero real value, printed in Anvil's own
///         startup banner) as both deployer and the fresh launch's creator.
///
///         REWRITE (docs/BASKET_DISCOVERY.md, this session): the prior
///         version of this fixture seeded a throwaway WETH/NVDA v4 pool via
///         TestPoolSeeder, because at the time no real route existed for any
///         AssetRegistry-listed asset. Real routes now exist (the exact same
///         Fables/Ramses tables BallastRouterV2 and BasketZap were deployed
///         with, read live off the SAME forked mainnet state this script
///         runs against) — so the fixture now deploys BasketZap with the
///         real tables and the e2e test swaps against the REAL NVDA/WETH
///         Ramses pool, no seeding needed. This also drops the manual
///         `anvil_setStorageAt` WETH/NVDA balance hack from
///         web/e2e/global-setup.ts's funding step — Anvil's default dev
///         account already starts with a large native ETH balance, which is
///         now the only currency BasketZap's creator-side flow needs to hold
///         before swapping.
///
///         Prints a single JSON line the Playwright global-setup script parses
///         to wire up the browser's env.
contract DeploySetupBasketE2E is Script {
    address constant FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    // Anvil's well-known default account #0 — public, zero-value, printed by
    // every `anvil` instance on startup. Never used against real mainnet.
    uint256 constant ANVIL_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        address me = vm.addr(ANVIL_PK);

        DeployBasketZap deployHelper = new DeployBasketZap();

        vm.startBroadcast(ANVIL_PK);

        BasketZap zap = new BasketZap(
            FACTORY,
            deployHelper.REGISTRY(),
            IPoolManager(deployHelper.POOL_MANAGER()),
            WETH,
            deployHelper.buildFablesHops(),
            deployHelper.buildRamsesRoutes()
        );

        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        (, address token, address treasury) =
            IBallastFactoryFull(FACTORY).launch("E2E Basket Launch", "E2EB", 7 days, "ipfs://e2e-test", quoteAssets);

        vm.stopBroadcast();

        // NVDA's real Ramses route is index 0 (WETH/NVDA direct) —
        // web/e2e/global-setup.ts wires this exact index into the picker's
        // test fixture, same convention as web/lib/routerV2.ts.
        console2.log("===BASKET_E2E_JSON_START===");
        console2.log(
            string.concat(
                "{",
                '"basketZap":"',
                vm.toString(address(zap)),
                '","token":"',
                vm.toString(token),
                '","treasury":"',
                vm.toString(treasury),
                '","creator":"',
                vm.toString(me),
                '","nvda":"',
                vm.toString(NVDA),
                '","ramsesHopIdx":[0]',
                "}"
            )
        );
        console2.log("===BASKET_E2E_JSON_END===");
    }
}
