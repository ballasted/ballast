// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CreatorSplitterFactory} from "../src/CreatorSplitterFactory.sol";

/// @title DeployCreatorSplitterFactory — deploys the ownerless team-split factory.
///        DRY-RUN ONLY — no broadcast is signed here.
///
/// @notice Sign with `--account <new-keystore> --sender <addr>` and type the
///         password at the interactive prompt. No --password-file, no -k, no
///         private keys. Never the compromised deployer.
///
///         The factory takes no constructor args; each CreatorSplitter it deploys
///         fixes its recipients + bps shares at construction (immutable). See
///         docs/security/creator-splitter.md.
contract DeployCreatorSplitterFactory is Script {
    function run() external returns (CreatorSplitterFactory factory) {
        vm.startBroadcast();
        factory = new CreatorSplitterFactory();
        vm.stopBroadcast();

        console2.log("CreatorSplitterFactory deployed:", address(factory));
        console2.log("VERIFY: forge verify-contract <addr> src/CreatorSplitterFactory.sol:CreatorSplitterFactory");
        console2.log(
            "  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663"
        );
        console2.log("SET IN VERCEL: NEXT_PUBLIC_CREATOR_SPLITTER_FACTORY=<addr>");
    }
}
