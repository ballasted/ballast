// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ProtocolFeeSink} from "../src/ProtocolFeeSink.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";

/// @title DeployProtocolFeeSink — deploys ProtocolFeeSink, then
///        BallastFeeSplitterFactory pointed at it
///
/// @notice Order matters: BallastFeeSplitterFactory takes `protocolRecipient`
///         as an immutable constructor argument (baked into every splitter it
///         creates thereafter), so the sink MUST exist first. Neither contract
///         has an owner/admin/setter for this — if the sink's address is ever
///         wrong, the fix is a new factory deployment, not a patch.
///
/// @dev No private key read here — sign with `--account <keystore> --sender
///      <address>`, same pattern as DeployBuybackV2.s.sol / DeployV1Claim.s.sol.
///      DRY_RUN=true logs predicted addresses (via the sender's current nonce)
///      and does not broadcast.
///
/// Usage:
///   DRY_RUN=true forge script script/DeployProtocolFeeSink.s.sol:DeployProtocolFeeSink \
///     --rpc-url robinhood_mainnet --sender <your-address>
///
///   forge script script/DeployProtocolFeeSink.s.sol:DeployProtocolFeeSink \
///     --rpc-url robinhood_mainnet --account <your-keystore> --sender <your-address> --broadcast
contract DeployProtocolFeeSink is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant SAFE = 0xEFC97e16a24d2434C7138a2634E554a0631aC079;
    address constant ASSET_REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;

    function run() external {
        bool dryRun = vm.envOr("DRY_RUN", false);
        address sender = msg.sender;

        console2.log("=== DeployProtocolFeeSink ===");
        console2.log("mode:", dryRun ? "DRY-RUN (no broadcast)" : "BROADCAST");
        console2.log("sender:", sender);
        console2.log("weth:", WETH);
        console2.log("safe:", SAFE);
        console2.log("assetRegistry:", ASSET_REGISTRY);

        if (dryRun) {
            uint256 nonce = vm.getNonce(sender);
            address predictedSink = vm.computeCreateAddress(sender, nonce);
            address predictedFactory = vm.computeCreateAddress(sender, nonce + 1);
            console2.log("");
            console2.log("predicted ProtocolFeeSink:", predictedSink);
            console2.log("predicted BallastFeeSplitterFactory:", predictedFactory);
            console2.log("(predictions assume these are the sender's next two txs on this chain,");
            console2.log(" in this exact order, with nothing else broadcast from this account first)");
            return;
        }

        vm.startBroadcast();
        ProtocolFeeSink sink = new ProtocolFeeSink(WETH, SAFE, ASSET_REGISTRY);
        BallastFeeSplitterFactory factory = new BallastFeeSplitterFactory(address(sink));
        vm.stopBroadcast();

        console2.log("");
        console2.log("ProtocolFeeSink deployed:", address(sink));
        console2.log("BallastFeeSplitterFactory deployed:", address(factory));
        console2.log("");
        console2.log("Verify:");
        console2.log("forge verify-contract", address(sink));
        console2.log("src/ProtocolFeeSink.sol:ProtocolFeeSink --verifier sourcify --chain-id 4663");
        console2.log("--constructor-args", vm.toString(abi.encode(WETH, SAFE, ASSET_REGISTRY)));
        console2.log("");
        console2.log("forge verify-contract", address(factory));
        console2.log("src/BallastFeeSplitterFactory.sol:BallastFeeSplitterFactory --verifier sourcify --chain-id 4663");
        console2.log("--constructor-args", vm.toString(abi.encode(address(sink))));
    }
}
