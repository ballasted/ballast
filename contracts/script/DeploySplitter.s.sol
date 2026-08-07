// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

/// @notice Deploys the FeeSplitter, to be set as `platformVault` on the PRIOR FeeConfig
///         (0xf814…871304, which governs $BALLAST/CHRS/RCN). It then routes that
///         platform fee share 35% -> the buyback / 65% -> 0x3b4f (both retunable/movable
///         within bounds). Deploy the BuybackBurner FIRST — its address is required here
///         and is IMMUTABLE in the splitter.
///
/// After deploy:
///   1. On the PRIOR FeeConfig 0xf814…871304: setPlatformVault(<this splitter>).
///      (Leave the CURRENT FeeConfig 0xc0b8 pointed at the buyback per the deploy plan.)
///   2. Transfer ownership to the Safe (Ownable2Step): transferOwnership(safe) then the
///      Safe calls acceptOwnership().
///   3. Update the buyback page fee-flow copy to show the 35/65 split on prior-hook pools.
///
/// Required env:
///   PROTOCOL_OWNER_ADDRESS       initial owner (deployer EOA fine; move to the Safe)
///   DEPLOYER_PRIVATE_KEY         funded deployer
///   WETH                         aeWETH
///   NEXT_PUBLIC_BUYBACK_ADDRESS  the deployed BuybackBurner (immutable sink)
/// Optional env (with defaults):
///   SPLITTER_PLATFORM_RECIPIENT  default 0x3b4f…BD85 (the current platform vault)
///   SPLITTER_BUYBACK_BPS         default 3500 (35%); bounded [1000, 9000] by the contract
///   SPLITTER_CLAIM_HOOKS         comma-separated; default [0x9C15…680CC] (the prior hook)
contract DeploySplitter is Script {
    address constant DEFAULT_PLATFORM_RECIPIENT = 0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85;
    address constant PRIOR_HOOK = 0x9C15c992E4De3711715C8B7D717EF46e474680CC;

    function run() external returns (FeeSplitter splitter) {
        require(vm.envAddress("PROTOCOL_OWNER_ADDRESS") != address(0), "PROTOCOL_OWNER_ADDRESS unset");
        require(vm.envAddress("NEXT_PUBLIC_BUYBACK_ADDRESS") != address(0), "buyback unset (deploy it first)");

        address[] memory defaultHooks = new address[](1);
        defaultHooks[0] = PRIOR_HOOK;

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        splitter = new FeeSplitter(
            vm.envAddress("WETH"),
            vm.envAddress("NEXT_PUBLIC_BUYBACK_ADDRESS"),
            vm.envOr("SPLITTER_PLATFORM_RECIPIENT", DEFAULT_PLATFORM_RECIPIENT),
            uint16(vm.envOr("SPLITTER_BUYBACK_BPS", uint256(3500))),
            vm.envOr("SPLITTER_CLAIM_HOOKS", ",", defaultHooks),
            vm.envAddress("PROTOCOL_OWNER_ADDRESS")
        );
        vm.stopBroadcast();

        console2.log("FeeSplitter:", address(splitter));
        console2.log("Next: on PRIOR FeeConfig 0xf814...871304 call setPlatformVault(this), then move owner to the Safe.");
    }
}
