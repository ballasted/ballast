// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {RamsesLockLauncher} from "../src/RamsesLockLauncher.sol";

/// @title DeployRamsesLockLauncher — deploys RamsesLockLauncher wired to the
///        REAL canonical RamsesLocker and a given BallastFeeSplitterFactory
///
/// @notice Run this LAST in the Ramses deploy sequence, after
///         DeployProtocolFeeSink.s.sol has produced a factory address:
///           1. DeployProtocolFeeSink.s.sol -> ProtocolFeeSink, BallastFeeSplitterFactory
///           2. DeployRamsesLockLauncher.s.sol (this script) -> RamsesLockLauncher
///
/// @dev No private key read here — sign with `--account <keystore> --sender
///      <address>`. The human types the keystore password themselves; never
///      pass `--password-file`.
///
///      LOCKER is Ramses' own canonical deployment (verified 2026-10-09 —
///      positionManager()/poolDeployer()/voter() all match expected, no
///      EIP-1967 proxy slots, runtime bytecode byte-for-byte identical to our
///      vendored source at solc 0.8.30/optimizer 300/cancun/via_ir=true
///      outside the 3 immutable slots and the expected CBOR metadata hash —
///      see contracts/lib/ramses-v3-contracts/VENDORED.md and
///      test/BallastFeeSplitterFork.t.sol's contract-level doc). This script
///      RE-VERIFIES the same three links live before broadcasting anything.
///
/// Usage:
///   DRY_RUN=true forge script script/DeployRamsesLockLauncher.s.sol:DeployRamsesLockLauncher \
///     --rpc-url robinhood_mainnet --sender <your-address> \
///     --sig "run(address)" <FACTORY_ADDRESS_FROM_STEP_1>
///
///   forge script script/DeployRamsesLockLauncher.s.sol:DeployRamsesLockLauncher \
///     --rpc-url robinhood_mainnet --account <keystore> --sender <your-address> \
///     --sig "run(address)" <FACTORY_ADDRESS_FROM_STEP_1> --broadcast
contract DeployRamsesLockLauncher is Script {
    address constant POSITION_MANAGER = 0x2eBd7B85a4E08D5B508b04BA147976C94afE6590;
    address constant POOL_DEPLOYER = 0x4b37359BF291AbE8453692DB58d515a8b013Dca9;
    address constant LOCKER = 0xF6CD2e03259150D4FF745CDd620c09FBF30DE1dC;
    address constant VOTER = 0x30032D41868906f0376eC4D87B3D3Ac4064e7A97;

    function run(address splitterFactory) external returns (RamsesLockLauncher launcher) {
        bool dryRun = vm.envOr("DRY_RUN", false);
        address sender = msg.sender;

        console2.log("=== DeployRamsesLockLauncher ===");
        console2.log("mode:", dryRun ? "DRY-RUN (no broadcast)" : "BROADCAST");
        console2.log("sender:", sender);
        console2.log("positionManager:", POSITION_MANAGER);
        console2.log("locker:", LOCKER);
        console2.log("splitterFactory:", splitterFactory);
        require(splitterFactory != address(0), "splitterFactory required (step 1 output)");

        // Re-verify the locker live, every time, right before using it.
        (bool ok1, bytes memory r1) = LOCKER.staticcall(abi.encodeWithSignature("positionManager()"));
        (bool ok2, bytes memory r2) = LOCKER.staticcall(abi.encodeWithSignature("poolDeployer()"));
        (bool ok3, bytes memory r3) = LOCKER.staticcall(abi.encodeWithSignature("voter()"));
        require(ok1 && ok2 && ok3, "LOCKER: one or more immutable getters reverted -- stop");
        require(abi.decode(r1, (address)) == POSITION_MANAGER, "LOCKER.positionManager() mismatch -- stop");
        require(abi.decode(r2, (address)) == POOL_DEPLOYER, "LOCKER.poolDeployer() mismatch -- stop");
        require(abi.decode(r3, (address)) == VOTER, "LOCKER.voter() mismatch -- stop");
        console2.log("LOCKER wiring re-verified live: OK");

        // The launcher derives v3Factory itself on-chain from
        // positionManager.deployer() -> IRamsesV3PoolDeployer.RamsesV3Factory()
        // (see RamsesLockLauncher's constructor) -- nothing to pass in, but
        // resolve + log it here too so the dry-run output shows exactly what
        // the constructor will land on before any broadcast.
        (bool ok4, bytes memory r4) = POSITION_MANAGER.staticcall(abi.encodeWithSignature("deployer()"));
        require(ok4, "POSITION_MANAGER.deployer() reverted -- stop");
        require(abi.decode(r4, (address)) == POOL_DEPLOYER, "POSITION_MANAGER.deployer() mismatch -- stop");
        (bool ok5, bytes memory r5) = POOL_DEPLOYER.staticcall(abi.encodeWithSignature("RamsesV3Factory()"));
        require(ok5, "POOL_DEPLOYER.RamsesV3Factory() reverted -- stop");
        console2.log("v3Factory (launcher will derive this on-chain):", abi.decode(r5, (address)));

        if (dryRun) {
            uint256 nonce = vm.getNonce(sender);
            address predicted = vm.computeCreateAddress(sender, nonce);
            console2.log("");
            console2.log("predicted RamsesLockLauncher:", predicted);
            return launcher;
        }

        vm.startBroadcast();
        launcher = new RamsesLockLauncher(POSITION_MANAGER, LOCKER, splitterFactory);
        vm.stopBroadcast();

        console2.log("");
        console2.log("RamsesLockLauncher deployed:", address(launcher));
        console2.log("--- verify ---");
        console2.log("forge verify-contract", address(launcher));
        console2.log("src/RamsesLockLauncher.sol:RamsesLockLauncher --verifier sourcify --chain-id 4663");
        console2.log("--constructor-args", vm.toString(abi.encode(POSITION_MANAGER, LOCKER, splitterFactory)));
    }
}
