// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {BallastHook} from "../src/BallastHook.sol";

/// @title DeployHook — deploy FeeConfig + the singleton BallastHook (CREATE2-mined)
///
/// @notice Mines a salt so the hook address carries EXACTLY the four permission
///         flag bits it implements (beforeSwap, afterSwap, and both return-delta
///         flags) and no others — required for the PoolManager to accept it. The
///         hook is a singleton, deployed once and shared by every BALLAST pool.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY    — funded deployer
///   PROTOCOL_OWNER_ADDRESS  — FeeConfig owner (multisig on mainnet)
///   PROTOCOL_VAULT_ADDRESS  — platform fee vault
///   POOL_MANAGER            — v4 PoolManager (0x8366a39CC670B4001A1121B8F6A443A643e40951)
///   WETH                    — 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
///
/// Run:
///   forge script script/DeployHook.s.sol:DeployHook --rpc-url robinhood_mainnet --broadcast
contract DeployHook is Script {
    // Deterministic CREATE2 factory forge routes `new{salt}` through in scripts.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (FeeConfig cfg, BallastHook hook) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("PROTOCOL_OWNER_ADDRESS");
        address vault = vm.envAddress("PROTOCOL_VAULT_ADDRESS");
        address pm = vm.envAddress("POOL_MANAGER");
        address weth = vm.envAddress("WETH");
        require(owner != address(0) && vault != address(0) && pm != address(0) && weth != address(0), "env unset");

        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );

        vm.startBroadcast(pk);
        cfg = new FeeConfig(owner, vault);
        // Mine AFTER cfg exists — the hook's constructor args include cfg's address.
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(BallastHook).creationCode, abi.encode(pm, cfg, weth));
        hook = new BallastHook{salt: salt}(IPoolManager(pm), cfg, weth);
        require(address(hook) == hookAddr, "mined address mismatch");
        vm.stopBroadcast();

        console2.log("FeeConfig:  ", address(cfg));
        console2.log("BallastHook:", address(hook));
        console2.log("hook flags OK (addr & 0x3fff):", uint160(address(hook)) & 0x3fff);
    }
}
