// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";

/// @title DeployTimelock — the ONLY remaining admin surface behind a public delay
///
/// @notice Deploys a standard OpenZeppelin TimelockController with a 7-day
///         minDelay, the given Safe multisig as BOTH proposer and executor, and
///         admin renounced at deploy (admin param = address(0), the OZ-recommended
///         pattern — the timelock self-administers via address(this) only, so no
///         separate key can ever grant/revoke roles outside the delayed process
///         itself).
///
/// @dev This does NOT transfer ownership of anything. It only deploys the
///      timelock contract. Transferring FeeConfig/AssetRegistry ownership to it
///      is a SEPARATE, deliberate action — see docs/PROTOCOL_CONTROLS.md for the
///      exact steps and the read calls that prove it afterward. Never renounce
///      ownership entirely (no owner at all) — that would make a stuck
///      MAX_FEE_BPS-adjacent parameter or a needed asset addition permanently
///      unfixable; a 7-day-delayed, publicly-visible Safe-gated change is the
///      middle ground between "one hot EOA can act instantly" and "nothing can
///      ever change."
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   funded deployer (gas only — this contract holds no
///                          funds and needs no allowlist deposit)
///   SAFE_ADDRESS           the Safe multisig that will hold proposer + executor
///                          roles — get this right the first time; the roles are
///                          only changeable later BY the timelock itself, through
///                          its own 7-day delay, once deployed
///   MIN_DELAY_SECONDS      optional, default 604800 (7 days) — matches the
///                          notice-period convention already used for creator
///                          withdrawals elsewhere in this codebase
contract DeployTimelock is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address safe = vm.envAddress("SAFE_ADDRESS");
        uint256 minDelay = vm.envOr("MIN_DELAY_SECONDS", uint256(7 days));

        require(safe != address(0), "SAFE_ADDRESS unset");
        console2.log("=== DeployTimelock ===");
        console2.log("safe (proposer+executor):", safe);
        console2.log("minDelay (seconds):", minDelay, minDelay == 7 days ? "(7 days)" : "");

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;

        vm.startBroadcast(pk);
        TimelockController timelock = new TimelockController(minDelay, proposers, executors, address(0));
        vm.stopBroadcast();

        console2.log("TimelockController deployed:", address(timelock));
        console2.log("");
        console2.log("Admin renounced at deploy (admin param = address(0)) - the timelock");
        console2.log("self-administers; only a proposal through the timelock itself can");
        console2.log("change proposer/executor roles from here on.");
        console2.log("");
        console2.log("NEXT: transfer FeeConfig + AssetRegistry ownership to this address.");
        console2.log("This script does NOT do that - see docs/PROTOCOL_CONTROLS.md.");
    }
}
