// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice Deploys the BuybackBurner for $BALLAST. It starts empty and holds no
///         funds until the platform fee share is routed to it.
///
/// After deploy:
///   1. Set NEXT_PUBLIC_BUYBACK_ADDRESS (web/.env.local + Vercel).
///   2. On FeeConfig, setPlatformVault(<this>) so the platform fee share accrues here.
///   3. Move ownership to the Safe (Ownable2Step): transferOwnership(safe) then the
///      Safe calls acceptOwnership() — same as FeeConfig / AssetRegistry / denylist.
///   4. VERIFY THE SWAP ON A MAINNET FORK before relying on it (it moves funds):
///      fund the contract with WETH past the threshold and call buybackAndBurn(),
///      asserting $BALLAST at 0x…dEaD increased and no WETH is extractable elsewhere.
///
/// Required env:
///   PROTOCOL_OWNER_ADDRESS   initial owner (deployer EOA fine; move to the Safe)
///   DEPLOYER_PRIVATE_KEY     funded deployer
///   POOL_MANAGER             v4 PoolManager
///   WETH                     aeWETH
///   BALLAST_TOKEN            the $BALLAST token (must sort BELOW WETH → currency0)
///   BUYBACK_POOL_HOOK        the hook baked into $BALLAST's pool (a PRIOR hook)
///   BUYBACK_CLAIM_HOOKS      comma-separated hooks whose owed(this) to sweep (where
///                            the platform fee share accrues — the CURRENT hook, plus
///                            any prior hook still owing). Defaults to [POOL_MANAGER-less]
///   BUYBACK_THRESHOLD_WEI    min WETH before a buyback may run (retunable on-chain)
///   BUYBACK_MAX_SLIPPAGE_BPS price-impact cap per buyback, ≤ 2000 (retunable)
contract DeployBuyback is Script {
    function run() external returns (BuybackBurner buyback) {
        address owner = vm.envAddress("PROTOCOL_OWNER_ADDRESS");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address poolManager = vm.envAddress("POOL_MANAGER");
        address weth = vm.envAddress("WETH");
        address ballast = vm.envAddress("BALLAST_TOKEN");
        address poolHook = vm.envAddress("BUYBACK_POOL_HOOK");
        uint256 threshold = vm.envUint("BUYBACK_THRESHOLD_WEI");
        uint256 slippage = vm.envUint("BUYBACK_MAX_SLIPPAGE_BPS");

        require(owner != address(0), "PROTOCOL_OWNER_ADDRESS unset");
        require(ballast < weth, "BALLAST must sort below WETH (currency0)");
        require(slippage <= 2000, "slippage > 20%");

        address[] memory defaultHooks = new address[](1);
        defaultHooks[0] = poolHook;
        address[] memory claimHooks = vm.envOr("BUYBACK_CLAIM_HOOKS", ",", defaultHooks);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(ballast),
            currency1: Currency.wrap(weth),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(poolHook)
        });

        vm.startBroadcast(pk);
        buyback = new BuybackBurner(
            IPoolManager(poolManager), weth, ballast, key, claimHooks, threshold, uint16(slippage), owner
        );
        vm.stopBroadcast();

        console2.log("BuybackBurner:", address(buyback));
        console2.log("Owner:        ", owner);
        console2.log("Next: FeeConfig.setPlatformVault(this), set NEXT_PUBLIC_BUYBACK_ADDRESS, move owner to the Safe.");
    }
}
