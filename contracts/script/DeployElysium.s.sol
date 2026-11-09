// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {BallastHookV5, BALLAST_HOOK_V5_FLAGS} from "../src/elysium/BallastHookV5.sol";
import {BallastSeederV5} from "../src/elysium/BallastSeederV5.sol";
import {BallastFactoryV5} from "../src/elysium/BallastFactoryV5.sol";
import {ProtocolFeeVault} from "../src/elysium/ProtocolFeeVault.sol";

/// @title DeployElysium — deploy the gen-5 BALLAST core from a chain config JSON
///
/// @notice One script for BOTH Elysium testnet and mainnet — mainnet is a pure config
///         swap (same code, different `deployments/elysium-*.json`). Reads every
///         parameter from the config file named in `ELYSIUM_CONFIG`; deploys and wires,
///         in the exact order the Gen5 test suite proves:
///
///           1. BallastHookV5           (CREATE2-mined to a flag-valid address)
///           2. ProtocolFeeVault        (hook, protocolBurnDestination)
///           3. hook.setProtocolVault(vault)
///           4. BallastSeederV5         (poolManager, hook)
///           5. hook.setSeeder(seeder)
///           6. BallastFactoryV5        (hook, seeder, whype, poolManager, openingTick,
///                                       minFee, maxFee, treasuryEnabled=false, router params, owner)
///           7. if owner != deployer:   factory.transferOwnership(owner)  [Ownable2Step —
///                                       the Safe must acceptOwnership() separately]
///
/// @dev The hook gates setSeeder/setProtocolVault on `tx.origin == _deployer` (captured
///      at construction). ALWAYS pass `--sender $DEPLOYER` so tx.origin is the broadcasting
///      EOA in both simulation and broadcast — otherwise the setters revert with NotDeployer.
///
///      This script does NOT write addresses back into the config. It LOGS a paste-ready
///      `ballast` block; you fill the config by hand after bytecode-verifying each address
///      (see docs/elysium-mainnet-runbook.md). That keeps a simulation run from ever
///      clobbering real addresses.
///
/// Required env:
///   ELYSIUM_CONFIG         — path to the chain config, e.g. deployments/elysium-testnet.json
///   DEPLOYER_PRIVATE_KEY   — funded deployer EOA (its address MUST be passed as --sender)
///
/// Run (testnet):
///   ELYSIUM_CONFIG=deployments/elysium-testnet.json \
///   forge script script/DeployElysium.s.sol:DeployElysium \
///     --rpc-url $ELYSIUM_TESTNET_RPC_URL --sender $DEPLOYER --broadcast
contract DeployElysium is Script {
    // Deterministic CREATE2 factory that forge routes `new{salt}` through in scripts.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Cfg {
        uint256 chainId;
        bool isProduction;
        address poolManager;
        address whype;
        int24 openingTickWhype;
        int24 tickSpacing;
        uint16 protocolFeeBps;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        bool treasuryEnabled;
        address burnDestination;
        address owner;
        uint16 routerMaxSlippageBps;
        uint256 routerMaxRoutePerCall;
        uint256 routerRouteCooldown;
    }

    function run()
        external
        returns (BallastHookV5 hook, ProtocolFeeVault vault, BallastSeederV5 seeder, BallastFactoryV5 factory)
    {
        Cfg memory c = _loadConfig();
        validate(c);

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("=== DeployElysium ===");
        console2.log("config          :", vm.envString("ELYSIUM_CONFIG"));
        console2.log("chainId (cfg)   :", c.chainId);
        console2.log("chainId (live)  :", block.chainid);
        console2.log("isProduction    :", c.isProduction);
        console2.log("deployer        :", deployer);
        console2.log("poolManager     :", c.poolManager);
        console2.log("whype           :", c.whype);
        console2.log("burnDestination :", c.burnDestination);
        console2.log("protocolOwner   :", c.owner);

        vm.startBroadcast(pk);

        // 1. Mine + deploy the hook at a flag-valid address.
        bytes memory hookArgs = abi.encode(IPoolManager(c.poolManager), c.protocolFeeBps, c.minFeeBps, c.maxFeeBps);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, uint160(BALLAST_HOOK_V5_FLAGS), type(BallastHookV5).creationCode, hookArgs);
        hook = new BallastHookV5{salt: salt}(IPoolManager(c.poolManager), c.protocolFeeBps, c.minFeeBps, c.maxFeeBps);
        require(address(hook) == predicted, "hook address mismatch");
        require(uint160(address(hook)) & 0x3fff == uint160(BALLAST_HOOK_V5_FLAGS), "hook flags wrong");

        // 2. ProtocolFeeVault — needs the hook address, so it deploys after the hook.
        vault = new ProtocolFeeVault(address(hook), c.burnDestination);

        // 3. Wire the vault (one-time; gated on tx.origin == deployer).
        hook.setProtocolVault(address(vault));
        require(hook.protocolVault() == address(vault), "vault not wired");

        // 4. Seeder — needs the hook address.
        seeder = new BallastSeederV5(IPoolManager(c.poolManager), address(hook));

        // 5. Wire the seeder (one-time).
        hook.setSeeder(address(seeder));
        require(hook.seeder() == address(seeder), "seeder not wired");

        // 6. Factory.
        factory = new BallastFactoryV5(
            address(hook),
            seeder,
            c.whype,
            c.poolManager,
            c.openingTickWhype,
            c.minFeeBps,
            c.maxFeeBps,
            c.treasuryEnabled,
            c.routerMaxSlippageBps,
            c.routerMaxRoutePerCall,
            c.routerRouteCooldown,
            deployer // owner starts as the deployer; transferred below if a different owner is set
        );

        // 7. Hand ownership to the configured owner (Safe on mainnet). Ownable2Step: the
        //    owner must call acceptOwnership() to complete the handover.
        if (c.owner != address(0) && c.owner != deployer) {
            factory.transferOwnership(c.owner);
        }

        vm.stopBroadcast();

        _report(c, hook, vault, seeder, factory, deployer);
    }

    // --------------------------------------------------------------------- //
    //  Config loading                                                       //
    // --------------------------------------------------------------------- //
    function _loadConfig() internal view returns (Cfg memory c) {
        return loadConfig(vm.envString("ELYSIUM_CONFIG"));
    }

    /// @notice Parse a chain config JSON into a Cfg. Public so tests can exercise the
    ///         exact paths/types the deploy reads, without a broadcast.
    function loadConfig(string memory path) public view returns (Cfg memory c) {
        string memory json = vm.readFile(path);

        c.chainId = vm.parseJsonUint(json, ".chainId");
        c.isProduction = vm.parseJsonBool(json, ".isProduction");
        c.poolManager = vm.parseJsonAddress(json, ".v4.poolManager");
        c.whype = vm.parseJsonAddress(json, ".tokens.whype");

        c.openingTickWhype = int24(vm.parseJsonInt(json, ".params.openingTickWhype"));
        c.tickSpacing = int24(vm.parseJsonInt(json, ".params.tickSpacing"));
        c.protocolFeeBps = uint16(vm.parseJsonUint(json, ".params.protocolFeeBps"));
        c.minFeeBps = uint16(vm.parseJsonUint(json, ".params.minSwapFeeBps"));
        c.maxFeeBps = uint16(vm.parseJsonUint(json, ".params.maxSwapFeeBps"));
        c.treasuryEnabled = vm.parseJsonBool(json, ".params.treasuryEnabled");
        c.burnDestination = vm.parseJsonAddress(json, ".params.protocolBurnDestination");
        c.owner = vm.parseJsonAddress(json, ".owner.protocolOwner");

        c.routerMaxSlippageBps = uint16(vm.parseJsonUint(json, ".router.maxSlippageBps"));
        uint256 maxRoute = _parseUintStr(vm.parseJsonString(json, ".router.maxRoutePerCall"));
        c.routerMaxRoutePerCall = maxRoute == 0 ? type(uint256).max : maxRoute; // "0" => unlimited
        c.routerRouteCooldown = vm.parseJsonUint(json, ".router.routeCooldownSecs");
    }

    function _parseUintStr(string memory s) internal pure returns (uint256) {
        bytes memory b = bytes(s);
        if (b.length == 0) return 0;
        uint256 n;
        for (uint256 i; i < b.length; i++) {
            uint8 d = uint8(b[i]);
            require(d >= 48 && d <= 57, "maxRoutePerCall not numeric");
            n = n * 10 + (d - 48);
        }
        return n;
    }

    // --------------------------------------------------------------------- //
    //  Validation — fail LOUD before any broadcast                          //
    // --------------------------------------------------------------------- //
    function validate(Cfg memory c) public view {
        require(c.chainId == block.chainid, "config chainId != live chainId");
        require(c.poolManager != address(0), "poolManager unset (fill .v4.poolManager)");
        require(c.whype != address(0), "whype unset");
        require(c.burnDestination != address(0), "protocolBurnDestination unset/placeholder");
        require(c.poolManager.code.length > 0, "poolManager has no code on this chain");
        require(c.whype.code.length > 0, "whype has no code on this chain");

        require(!c.treasuryEnabled, "treasuryEnabled must be false on Elysium (no feeds)");
        require(c.tickSpacing == 60, "tickSpacing must be 60");
        require(c.openingTickWhype % 60 == 0, "openingTick not spacing-aligned");

        require(c.protocolFeeBps > 0 && c.protocolFeeBps < 10_000, "protocolFeeBps out of range");
        require(c.minFeeBps > 0 && c.minFeeBps <= c.maxFeeBps && c.maxFeeBps < 10_000, "fee bounds invalid");
    }

    // --------------------------------------------------------------------- //
    //  Paste-ready report                                                   //
    // --------------------------------------------------------------------- //
    function _report(
        Cfg memory c,
        BallastHookV5 hook,
        ProtocolFeeVault vault,
        BallastSeederV5 seeder,
        BallastFactoryV5 factory,
        address deployer
    ) internal view {
        console2.log("");
        console2.log("=== DEPLOYED (paste into the config's `ballast` block) ===");
        console2.log("protocolFeeVault :", address(vault));
        console2.log("hook             :", address(hook));
        console2.log("seeder           :", address(seeder));
        console2.log("factory          :", address(factory));
        console2.log("assetRegistry    : (none - green-asset list lives in the factory)");
        console2.log("");
        console2.log("factory.owner()        :", factory.owner());
        console2.log("factory.pendingOwner() :", factory.pendingOwner());
        if (c.owner != address(0) && c.owner != deployer) {
            console2.log(">>> ACTION: have the Safe (protocolOwner) call factory.acceptOwnership()");
        }
    }
}
