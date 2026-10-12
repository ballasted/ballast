// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TestPoolSeeder} from "../../test/helpers/TestPoolSeeder.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BasketZap} from "../../src/BasketZap.sol";

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
///         Before running this script, the Playwright global-setup funds that
///         EOA with real WETH and NVDA on the live Anvil node via
///         `anvil_setStorageAt` (web/e2e/fund-account.mjs) — `vm.deal`/StdCheats'
///         `deal()` only mutate forge's own LOCAL simulation and never reach a
///         separately-running Anvil node's real state when a script finishes
///         and replays its recorded broadcast transactions, so funding must
///         happen via Anvil's own RPC extension first. Once funded for real,
///         every step below is a genuine broadcast transaction: deploy
///         BasketZap, deploy TestPoolSeeder (test-only, never deployed to
///         mainnet — see that file's header for why this doesn't touch
///         AssetRegistry or any privileged account), transfer WETH/NVDA into
///         it, seed a real two-sided v4 pool, and create one fresh launch via
///         the REAL BallastFactory.
///
///         Prints a single JSON line the Playwright global-setup script parses
///         to wire up the browser's env.
contract DeploySetupBasketE2E is Script {
    address constant FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    uint24 constant TEST_FEE = 3000;
    int24 constant TEST_TICK_SPACING = 60;
    int24 constant TEST_RANGE = 20_000;

    // Anvil's well-known default account #0 — public, zero-value, printed by
    // every `anvil` instance on startup. Never used against real mainnet.
    uint256 constant ANVIL_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        address me = vm.addr(ANVIL_PK);
        uint256 wethAmt = 50 ether;
        uint256 nvdaAmt = 1_000_000 ether;

        vm.startBroadcast(ANVIL_PK);

        BasketZap zap = new BasketZap(FACTORY, REGISTRY, WETH, UNIVERSAL_ROUTER, PERMIT2);
        TestPoolSeeder seeder = new TestPoolSeeder(IPoolManager(POOL_MANAGER));

        IERC20(WETH).transfer(address(seeder), wethAmt);
        IERC20(NVDA).transfer(address(seeder), nvdaAmt);
        seeder.seed(WETH, NVDA, TEST_FEE, TEST_TICK_SPACING, TEST_RANGE, wethAmt, nvdaAmt);

        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        (, address token, address treasury) =
            IBallastFactoryFull(FACTORY).launch("E2E Basket Launch", "E2EB", 7 days, "ipfs://e2e-test", quoteAssets);

        vm.stopBroadcast();

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
                '","fee":',
                vm.toString(uint256(TEST_FEE)),
                ',"tickSpacing":',
                vm.toString(uint256(uint24(TEST_TICK_SPACING))),
                "}"
            )
        );
        console2.log("===BASKET_E2E_JSON_END===");
    }
}
