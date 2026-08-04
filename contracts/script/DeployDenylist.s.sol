// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MetadataDenylist} from "../src/MetadataDenylist.sol";

/// @notice Deploys the MetadataDenylist — the owner-managed, default-allow display
///         takedown for impersonation/phishing metadata. It starts EMPTY (nothing
///         suppressed) and holds no funds.
///
/// After deploy:
///   1. Set NEXT_PUBLIC_METADATA_DENYLIST_ADDRESS in web/.env.local and on Vercel.
///   2. Transfer ownership to the Safe (Ownable2Step): the deployer calls
///      transferOwnership(safe), then the Safe calls acceptOwnership() — same as
///      FeeConfig and AssetRegistry.
///
/// Required env:
///   PROTOCOL_OWNER_ADDRESS  — initial owner (deployer EOA is fine; move to the Safe)
///   DEPLOYER_PRIVATE_KEY    — funded deployer
///
/// Run (mainnet):
///   forge script script/DeployDenylist.s.sol:DeployDenylist \
///     --rpc-url robinhood_mainnet --broadcast \
///     --verify --verifier blockscout --chain-id 4663
contract DeployDenylist is Script {
    function run() external returns (MetadataDenylist denylist) {
        address owner = vm.envAddress("PROTOCOL_OWNER_ADDRESS");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(owner != address(0), "PROTOCOL_OWNER_ADDRESS unset");

        vm.startBroadcast(pk);
        denylist = new MetadataDenylist(owner);
        vm.stopBroadcast();

        console2.log("MetadataDenylist:", address(denylist));
        console2.log("Owner:           ", owner);
        console2.log("Set NEXT_PUBLIC_METADATA_DENYLIST_ADDRESS to the address above.");
    }
}
