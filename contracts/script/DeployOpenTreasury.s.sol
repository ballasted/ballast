// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OpenTreasuryVaultFactory} from "../src/OpenTreasuryVaultFactory.sol";
import {OpenTreasuryLens} from "../src/OpenTreasuryLens.sol";

/// @title DeployOpenTreasury — deploys OpenTreasuryVaultFactory + OpenTreasuryLens
///        on top of the already-live, UNTOUCHED gen-4 core
///
/// @notice No private key read by this script — sign with a BRAND NEW keystore
///         created specifically for this deploy, e.g.:
///         `--account opentreasury-deployer --password-file
///         ~/.foundry/keystores/opentreasury-deployer.pass`. Must NOT be the
///         compromised deployer 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1 — that
///         address must sign nothing here.
///
///         Deploys only NEW, additive contracts. Does not modify, redeploy, or
///         call any owner-only function on BallastFactory, BallastHook,
///         AssetRegistry, BackingLens, FeeConfig, BallastSeeder, or any router.
///
/// @dev Addresses below are the real, live, VERIFIED gen-4 mainnet addresses
///      (docs/BALLAST_STATE.md, this task's own brief) — a deploy script
///      targeting a specific known deployment is expected to reference it
///      directly; this is not the same as the app-code "never hardcode"
///      convention, which governs runtime reads, not one-time deploy wiring.
///      minHoldTime (24h) and rewardsDuration (7d) match
///      docs/OPEN_TREASURY_DESIGN.md decisions D9/D10 — override via env for a
///      testnet dry-run only, never for the real mainnet deploy.
contract DeployOpenTreasury is Script {
    address constant BALLAST_FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant ASSET_REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant BACKING_LENS = 0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint256 constant MIN_HOLD_TIME = 24 hours;
    uint256 constant REWARDS_DURATION = 7 days;

    function run() external returns (OpenTreasuryVaultFactory factory, OpenTreasuryLens lens) {
        address ballastFactory = vm.envOr("OPEN_TREASURY_BALLAST_FACTORY", BALLAST_FACTORY);
        address registry = vm.envOr("OPEN_TREASURY_ASSET_REGISTRY", ASSET_REGISTRY);
        address backingLens = vm.envOr("OPEN_TREASURY_BACKING_LENS", BACKING_LENS);
        address weth = vm.envOr("OPEN_TREASURY_WETH", WETH);
        uint256 minHoldTime = vm.envOr("OPEN_TREASURY_MIN_HOLD_TIME", MIN_HOLD_TIME);
        uint256 rewardsDuration = vm.envOr("OPEN_TREASURY_REWARDS_DURATION", REWARDS_DURATION);

        vm.startBroadcast();
        factory = new OpenTreasuryVaultFactory(ballastFactory, registry, weth, minHoldTime, rewardsDuration);
        lens = new OpenTreasuryLens(backingLens);
        vm.stopBroadcast();

        console2.log("OpenTreasuryVaultFactory deployed:", address(factory));
        console2.log("OpenTreasuryLens deployed:", address(lens));
        console2.log("implementation (logic contract):", factory.implementation());
        console2.log("--- verify ---");
        console2.log("forge verify-contract", address(factory));
        console2.log("src/OpenTreasuryVaultFactory.sol:OpenTreasuryVaultFactory --verifier blockscout");
        console2.log("--verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
        console2.log("forge verify-contract", address(lens));
        console2.log("src/OpenTreasuryLens.sol:OpenTreasuryLens --verifier blockscout");
        console2.log("--verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
    }
}
