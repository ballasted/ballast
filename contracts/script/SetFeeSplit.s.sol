// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FeeConfig} from "../src/FeeConfig.sol";

/// @notice Remove the referrer share and move to 65% creator / 35% platform.
///
///         This is the referrer-removal the user asked for. It is a LIVE parameter
///         change on the existing FeeConfig — no redeploy. FeeConfig.setParams is
///         `onlyOwner`, and it is retroactive to every existing pool (the singleton
///         hook reads feeParams live on the next swap), including pools launched by
///         third parties (e.g. $PHIL). For that reason it must be executed BY THE SAFE,
///         not the deployer EOA — the most consequential governance action cannot have
///         happened outside the multisig.
///
///         So this script does NOT broadcast. It prints the exact transaction to submit
///         through the Safe (target + calldata) and, when a fork RPC is available,
///         simulates it as the current owner to prove it won't revert (the split still
///         sums to 10_000 and the fee is within cap).
///
///         Prerequisite: FeeConfig ownership already transferred to and accepted by the
///         Safe (Section B step 2). Until then `owner` is the EOA and the printed tx
///         would revert if submitted from the Safe.
///
///         UI dependency: once this lands, the buyback page fee-flow diagram
///         (web/app/app/buyback/page.tsx — the "creator + platform + referrer shares"
///         node) is wrong and must drop "referrer". Update it in the same change.
///
/// Env:
///   FEE_CONFIG_ADDRESS   the live FeeConfig (0xc0b895…973a594)
///   RH_RPC_URL_PAID      optional; if set, simulates the call on a fork
contract SetFeeSplit is Script {
    // 1% fee unchanged; referrer share removed and folded into the creator share.
    uint16 constant FEE_BPS = 100; // 1%
    uint16 constant CREATOR_BPS = 6_500; // 65%
    uint16 constant PLATFORM_BPS = 3_500; // 35%
    uint16 constant REFERRER_BPS = 0; // removed

    function run() external {
        address feeConfig = vm.envAddress("FEE_CONFIG_ADDRESS");

        // Sanity: the split must sum to exactly 10_000 or setParams reverts BadSplit.
        require(uint256(CREATOR_BPS) + PLATFORM_BPS + REFERRER_BPS == 10_000, "split != 10000");

        bytes memory data = abi.encodeCall(
            FeeConfig.setParams, (FEE_BPS, CREATOR_BPS, PLATFORM_BPS, REFERRER_BPS)
        );

        console2.log("=== Submit this through the Safe (Ownable2Step owner) ===");
        console2.log("to:   ", feeConfig);
        console2.log("value: 0");
        console2.log("data:");
        console2.logBytes(data);
        console2.log("=== decoded: setParams(100, 6500, 3500, 0)  [1% fee, 65/35, no referrer] ===");

        // Optional simulation to prove the tx won't revert before it reaches the Safe.
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) {
            console2.log("(set RH_RPC_URL_PAID to simulate against the live owner)");
            return;
        }
        vm.createSelectFork(url);
        FeeConfig cfg = FeeConfig(feeConfig);
        address owner = cfg.owner();
        console2.log("simulating as current owner:", owner);

        vm.prank(owner);
        cfg.setParams(FEE_BPS, CREATOR_BPS, PLATFORM_BPS, REFERRER_BPS);

        (uint16 f, uint16 c, uint16 p, uint16 r,) = cfg.feeParams();
        require(f == FEE_BPS && c == CREATOR_BPS && p == PLATFORM_BPS && r == REFERRER_BPS, "sim mismatch");
        console2.log("simulation OK: fee/creator/platform/referrer =", f, c);
        console2.log("                                              ", p, r);
    }
}
