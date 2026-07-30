// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {BackingLens} from "../src/BackingLens.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {BallastHook} from "../src/BallastHook.sol";
import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";

/// @title DeployMainnet — deploy the full BALLAST core to Robinhood Chain.
///
/// @notice WRITE-ONLY reference: reviewed, compiled, NOT run. Deploys the six core
///         contracts and prints their addresses for the frontend .env.
///
/// Env vars the human must supply (see checklist in the session report):
///   DEPLOYER_PRIVATE_KEY           funded deployer (fresh wallet, gas only)
///   PROTOCOL_OWNER_ADDRESS         owner of AssetRegistry + FeeConfig (multisig)
///   PROTOCOL_VAULT_ADDRESS         platform fee vault
///   POOL_MANAGER                   v4 PoolManager  0x8366a39CC670B4001A1121B8F6A443A643e40951
///   WETH                           0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
///   SEQUENCER_UPTIME_FEED_ADDRESS  optional; leave 0x0 (none on chain 4663) — BackingLens reports Unknown
///
/// Run (when ready, on TESTNET first):
///   forge script script/DeployMainnet.s.sol:DeployMainnet \
///     --rpc-url robinhood_mainnet --broadcast --verify --verifier blockscout --chain-id 4663
contract DeployMainnet is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Env {
        address owner;
        address vault;
        address pm;
        address weth;
        address sequencer;
        address ethUsdFeed;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Env memory e = Env({
            owner: vm.envAddress("PROTOCOL_OWNER_ADDRESS"),
            vault: vm.envAddress("PROTOCOL_VAULT_ADDRESS"),
            pm: vm.envAddress("POOL_MANAGER"),
            weth: vm.envAddress("WETH"),
            sequencer: vm.envOr("SEQUENCER_UPTIME_FEED_ADDRESS", address(0)),
            ethUsdFeed: vm.envAddress("ETH_USD_FEED")
        });
        require(
            e.owner != address(0) && e.vault != address(0) && e.pm != address(0) && e.weth != address(0)
                && e.ethUsdFeed != address(0),
            "env unset"
        );

        vm.startBroadcast(pk);
        address registry = address(new AssetRegistry(e.owner));
        console2.log("AssetRegistry:  ", registry);
        console2.log("BackingLens:    ", address(new BackingLens(e.sequencer)));
        FeeConfig cfg = new FeeConfig(e.owner, e.vault);
        console2.log("FeeConfig:      ", address(cfg));
        BallastHook hook = _deployHook(e.pm, cfg, e.weth);
        console2.log("BallastHook:    ", address(hook));
        BallastSeeder seeder = new BallastSeeder(IPoolManager(e.pm), e.weth, address(hook));
        console2.log("BallastSeeder:  ", address(seeder));
        // ETH/USD leg outer staleness bound (coarse backstop). 24h given observed
        // gaps up to ~2.8h; owner can't retune an immutable, so it's set once here.
        uint256 ethUsdStaleWindow = vm.envOr("ETH_USD_STALE_WINDOW", uint256(24 hours));
        // Unbacked opening FDV (WETH). 5 ETH: ~2 ETH of net buying to double an
        // unbacked token, so the Discover board's published prices aren't movable for
        // a few hundred dollars. WETH-pegged (no oracle); USD figure floats with ETH.
        uint256 unbackedFdv = vm.envOr("UNBACKED_OPEN_FDV_WETH", uint256(5 ether));
        BallastFactory factory =
            new BallastFactory(registry, e.weth, seeder, e.ethUsdFeed, ethUsdStaleWindow, unbackedFdv);
        console2.log("BallastFactory: ", address(factory));
        console2.log("  unbackedOpenFdvWeth (wei):", factory.unbackedOpenFdvWeth());
        console2.log("  UNBACKED_TICK (derived):  ", factory.UNBACKED_TICK());
        vm.stopBroadcast();
        console2.log("sequencer feed (0x0 = Unknown, none on 4663):", e.sequencer);
    }

    function _deployHook(address pm, FeeConfig cfg, address weth) internal returns (BallastHook hook) {
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(BallastHook).creationCode, abi.encode(pm, cfg, weth));
        hook = new BallastHook{salt: salt}(IPoolManager(pm), cfg, weth);
        require(address(hook) == hookAddr, "hook mine mismatch");
    }
}
