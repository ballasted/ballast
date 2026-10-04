// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BallastV1Claim} from "../src/BallastV1Claim.sol";

/// @title DeployV1Claim — deploys the immutable v1->v2 migration claim contract
///
/// @notice No private key read by this script — sign with `--account
///         v1claim-deployer --password-file ~/.foundry/v1claim-deployer.pass`.
///         This is a BRAND NEW keystore created specifically for this one
///         deploy, never the old (compromised) deployer.
///
/// Env:
///   V1_TOKEN            $BALLAST v1, 0x069a260370C61d91bd3e9842d81D378F9750F7F3
///   MERKLE_ROOT          from data/snapshot/v1_claim_merkle.json's "root"
///   CLAIM_DEADLINE_DAYS  optional, default 7
///   SWEEP_TO             the Safe, 0xEFC97e16a24d2434C7138a2634E554a0631aC079
///
/// $BALLAST v2's swap infra (BALLAST/WETH/HOOK/UniversalRouter/Permit2) is
/// hardcoded below, same convention as DeployBuybackV2.s.sol — these are
/// fixed protocol-level addresses (the pinned v2 token and chain infra), not
/// per-launch addresses, so there is nothing to resolve from a registry.
contract DeployV1Claim is Script {
    address constant BALLAST_V2 = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        address v1Token = vm.envAddress("V1_TOKEN");
        bytes32 root = vm.envBytes32("MERKLE_ROOT");
        uint256 deadlineDays = vm.envOr("CLAIM_DEADLINE_DAYS", uint256(7));
        address sweepTo = vm.envAddress("SWEEP_TO");

        uint256 deadline = block.timestamp + deadlineDays * 1 days;

        console2.log("=== DeployV1Claim ===");
        console2.log("v1Token:", v1Token);
        console2.log("merkleRoot:");
        console2.logBytes32(root);
        console2.log("deadline (unix):", deadline);
        console2.log("sweepTo:", sweepTo);
        console2.log("ballastV2:", BALLAST_V2);
        console2.log("weth:", WETH);
        console2.log("hook:", HOOK);
        console2.log("universalRouter:", UNIVERSAL_ROUTER);
        console2.log("permit2:", PERMIT2);

        vm.startBroadcast();
        BallastV1Claim claim =
            new BallastV1Claim(v1Token, root, deadline, sweepTo, BALLAST_V2, WETH, UNIVERSAL_ROUTER, PERMIT2, HOOK);
        vm.stopBroadcast();

        console2.log("");
        console2.log("BallastV1Claim deployed:", address(claim));
        console2.log("");
        console2.log("NEXT: fund it with the total ETH budget (see");
        console2.log("docs/safe-tx-fund-v1claim.json once this address is filled in),");
        console2.log("then verify: forge verify-contract", address(claim));
        console2.log("src/BallastV1Claim.sol:BallastV1Claim --verifier sourcify --chain-id 4663");
    }
}
