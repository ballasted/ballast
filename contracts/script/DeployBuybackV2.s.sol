// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";

/// @title DeployBuybackV2 — deploys the immutable, ownerless $BALLAST v2 buyback burner
///
/// @notice No private key read here — sign with `--account <new-keystore>
///         --password-file <path>`. Use a NEW keystore, never the old deployer
///         (same pattern as DeployV1Claim.s.sol).
///
/// Env (all have sane defaults baked in below; override only if something changed):
///   MAX_WETH_PER_CALL     wei, default 0.02 ether (~$54 at $2,713.73/ETH,
///                         2026-09-29) — a conservative slice of the WETH pool's
///                         ~$2,834 total reserve; the 10% default slippage bound
///                         is the real per-call protection, this just caps total
///                         $ exposure per cooldown window.
///   MAX_NVDA_PER_CALL     wei (18 decimals), default 0.5e18 (~$115 at
///                         $230.56/share, 2026-09-29) — similarly conservative
///                         against the NVDA pool's ~$2,842 total reserve.
///   COOLDOWN_SECONDS      default 3600 (1 hour), PER ASSET (buying via WETH and
///                         NVDA have independent cooldowns).
///   MAX_SLIPPAGE_BPS      default 1000 (10%) — tighter than the contract's own
///                         hard MAX_SLIPPAGE_BPS ceiling of 2000 (20%).
contract DeployBuybackV2 is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant BALLAST = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;

    function run() external {
        uint256 maxWeth = vm.envOr("MAX_WETH_PER_CALL", uint256(0.02 ether));
        uint256 maxNvda = vm.envOr("MAX_NVDA_PER_CALL", uint256(0.5e18));
        uint256 cooldown = vm.envOr("COOLDOWN_SECONDS", uint256(3600));
        uint16 maxSlippageBps = uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(1000)));

        PoolKey memory wethKey = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(BALLAST),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });
        PoolKey memory nvdaKey = PoolKey({
            currency0: Currency.wrap(NVDA),
            currency1: Currency.wrap(BALLAST),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });

        console2.log("=== DeployBuybackV2 ===");
        console2.log("maxWethPerCall:", maxWeth);
        console2.log("maxNvdaPerCall:", maxNvda);
        console2.log("cooldownSeconds:", cooldown);
        console2.log("maxSlippageBps:", maxSlippageBps);

        vm.startBroadcast();
        BuybackBurnerV2 bb = new BuybackBurnerV2(
            IPoolManager(POOL_MANAGER), BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, maxSlippageBps
        );
        vm.stopBroadcast();

        console2.log("");
        console2.log("BuybackBurnerV2 deployed:", address(bb));
        console2.log("NEXT: Safe sends a share of claimed fees here (see");
        console2.log("docs/safe-tx-fund-buybackv2.json), then verify:");
        console2.log("forge verify-contract", address(bb));
        console2.log("src/BuybackBurnerV2.sol:BuybackBurnerV2 --verifier sourcify --chain-id 4663");
    }
}
