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
        // Env read inline (a script pays no gas) to keep the stack shallow — the
        // constructor takes 8 params and the default profile has no viaIR, so binding
        // every value to a named local trips "stack too deep".
        require(vm.envAddress("PROTOCOL_OWNER_ADDRESS") != address(0), "PROTOCOL_OWNER_ADDRESS unset");
        require(vm.envAddress("BALLAST_TOKEN") < vm.envAddress("WETH"), "BALLAST must sort below WETH (currency0)");
        require(vm.envUint("BUYBACK_MAX_SLIPPAGE_BPS") <= 2000, "slippage > 20%");

        address[] memory defaultHooks = new address[](1);
        defaultHooks[0] = vm.envAddress("BUYBACK_POOL_HOOK");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(vm.envAddress("BALLAST_TOKEN")),
            currency1: Currency.wrap(vm.envAddress("WETH")),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(vm.envAddress("BUYBACK_POOL_HOOK"))
        });

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        buyback = new BuybackBurner(
            IPoolManager(vm.envAddress("POOL_MANAGER")),
            vm.envAddress("WETH"),
            vm.envAddress("BALLAST_TOKEN"),
            key,
            vm.envOr("BUYBACK_CLAIM_HOOKS", ",", defaultHooks),
            vm.envUint("BUYBACK_THRESHOLD_WEI"),
            uint16(vm.envUint("BUYBACK_MAX_SLIPPAGE_BPS")),
            vm.envAddress("PROTOCOL_OWNER_ADDRESS")
        );
        vm.stopBroadcast();

        console2.log("BuybackBurner:", address(buyback));
        console2.log("Owner:        ", vm.envAddress("PROTOCOL_OWNER_ADDRESS"));
        console2.log("Next: FeeConfig.setPlatformVault(this), set NEXT_PUBLIC_BUYBACK_ADDRESS, move owner to the Safe.");
    }
}
