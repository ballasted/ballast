// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastRouter} from "../src/BallastRouter.sol";

/// @title DeployCombinationPackage — first-ever deploy of the multi-quote-asset
///        generation (Hook + Seeder + Factory, items 5/6 folded in) + BallastRouter.
///
/// @notice First-time deploy of Hook/Seeder, not a like-for-like redeploy: the
///         multi-quote-asset generation (commits 605eb27..252410b) was written
///         but never shipped — the currently live factory/hook
///         (0x069974136c78Cf0F2162463B95321E59F56523D8 /
///         0x9C15c992E4De3711715C8B7D717EF46e474680CC) are the OLDER,
///         single-quote-asset generation and are unaffected by this deploy;
///         their existing launches (BALLAST, CHRS, RCN, HARUNA, BCAT, ...)
///         keep resolving against their own hook unchanged.
///
/// RESOLVED 2026-09-26 (docs/TONIGHT_RUNBOOK.md): FEE_CONFIG_ADDRESS is left
/// unset — this generation deploys its OWN fresh FeeConfig rather than reusing
/// either of the two pre-existing, differently-configured live instances.
///
/// No private key is read by this script, ever — see `run()`: the deploying
/// address comes from `msg.sender`, which Foundry resolves from `--sender`
/// (simulation) or the `--account` keystore (real broadcast). Nothing here
/// can print or require a raw key.
///
/// Required env:
///   FEE_CONFIG_ADDRESS         *** UNRESOLVED — human must choose ***
///                              Candidate A: 0xf814CA06aFfaBD1aa5Cd31aDB5F25D23E9871304
///                                (used by the CURRENTLY LIVE gen-1 hook,
///                                0x9C15c992E4De3711715C8B7D717EF46e474680CC)
///                              Candidate B: 0xC0B895bc683bf4ACA30c7277D42d068E0973A594
///                                (used by the abandoned gen-2 hook,
///                                0x743102aa1De955b5F0Fada1377B6E545Fdb080cc,
///                                which is NOT the current env pointer)
///                              Or deploy a fresh FeeConfig instead — leave
///                              this unset to have the script deploy a new one
///                              via NEW_FEE_CONFIG_OWNER/NEW_FEE_CONFIG_VAULT.
///   NEW_FEE_CONFIG_OWNER       only read if FEE_CONFIG_ADDRESS is unset
///   NEW_FEE_CONFIG_VAULT       only read if FEE_CONFIG_ADDRESS is unset
///   POOL_MANAGER               0x8366a39CC670B4001A1121B8F6A443A643e40951
///   WETH                       0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
///   ASSET_REGISTRY_ADDRESS     0x427764d0d19aB765c35A41A5aa4771580307dA81 (reused, unchanged)
///   ETH_USD_FEED               existing Chainlink ETH/USD feed on 4663
///   ETH_USD_STALE_WINDOW       optional, defaults 24h
///   UNIVERSAL_ROUTER           0x8876789976dEcBfCbBbe364623C63652db8C0904 (verified fork)
///   PERMIT2                    0x000000000022D473030F116dDEE9F6B43aC78BA3 (canonical)
///
/// Run (dry run first, always — no --account, no key, just --sender so the
/// simulation uses the real deploying address for the FeeConfig-owner logic):
///   forge script script/DeployCombinationPackage.s.sol:DeployCombinationPackage \
///     --rpc-url $RH_RPC_URL_PAID --sender 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1
///   # then, only after reviewing the dry run output:
///   forge script script/DeployCombinationPackage.s.sol:DeployCombinationPackage \
///     --rpc-url $RH_RPC_URL_PAID --sender 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1 \
///     --broadcast --verify --verifier blockscout \
///     --verifier-url https://robinhoodchain.blockscout.com/api/ --chain-id 4663 \
///     --account <keystore-name>
/// Verification confirmed working on this chain: docs/gmgn-verification.md
/// records real project tokens going from unverified to verified via this
/// exact --verifier-url. Blockscout's own web UI (robinhoodchain.blockscout.com)
/// sits behind a Cloudflare challenge that blocks plain curl/fetch — that has
/// nothing to do with the separate verifier API endpoint forge hits, which
/// gmgn-verification.md confirms is reachable and has verified real contracts.
contract DeployCombinationPackage is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // The 16 allowlisted stock tokens (AssetRegistry.allowedAssets(), verified
    // on-chain 2026-09-26 by reading the live registry directly — see
    // docs/phase2-combination-design.md §2). Item 6: ALL 16 become
    // factory-selectable quote assets, regardless of GREEN/AMBER/RED — that
    // classification is a frontend-only signal now, not a contract gate.
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant GOOGL = 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
    address constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;
    address constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address constant PLTR = 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A;
    address constant COIN = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;
    address constant ORCL = 0xb0992820E760d836549ba69BC7598b4af75dEE03;
    address constant CRCL = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5;

    // BallastRouter v1 curated leg-1 routes (design report §4b: direct-pool
    // only, deferred aggregator). Deliberately SMALL and independently
    // single-hop-strong (docs/exit-liquidity-table.md) — NOT padded with
    // every asset that has SOME pool, since several (e.g. SGOV) are only
    // deep via a two-hop USDG path that v1's single-hop leg 1 can't use, and
    // AMD/ORCL's only indexed pool is a v4 pool this router version can't
    // call directly (see BallastRouter.sol's v1-scope note). Adding more
    // routes later is a router redeploy, not a rewrite.
    // Both re-verified on-chain 2026-09-26 (fee()/token0()/token1() read directly,
    // not trusted from the doc transcription alone).
    address constant NVDA_WETH_POOL = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C; // Uniswap v3, 0.05%, $1.27M
    address constant SPY_WETH_POOL = 0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e; // Uniswap v3, 0.05%, $1.73M

    function run() external {
        address pm = vm.envAddress("POOL_MANAGER");
        address weth = vm.envAddress("WETH");
        address registry = vm.envAddress("ASSET_REGISTRY_ADDRESS");
        address ethUsdFeed = vm.envAddress("ETH_USD_FEED");
        uint256 ethUsdStaleWindow = vm.envOr("ETH_USD_STALE_WINDOW", uint256(24 hours));
        address universalRouter = vm.envAddress("UNIVERSAL_ROUTER");
        address permit2 = vm.envAddress("PERMIT2");
        require(
            pm != address(0) && weth != address(0) && registry != address(0) && ethUsdFeed != address(0)
                && universalRouter != address(0) && permit2 != address(0),
            "env unset"
        );

        // No private key anywhere in this script: the caller runs with
        // `--account <keystore-name> --sender <deployer address>`. Foundry
        // signs every broadcasted call with the keystore account; `msg.sender`
        // below (both here and inside every broadcasted call/constructor)
        // resolves to `--sender` during simulation and to the keystore
        // account's real address once `--broadcast` actually sends it.
        vm.startBroadcast();

        // ── FeeConfig: reuse (human-resolved) or deploy fresh ────────────────
        // RESOLVED 2026-09-26 (see docs/TONIGHT_RUNBOOK.md): this generation gets
        // its OWN fresh FeeConfig, feeBps unchanged from the currently-live 1%,
        // split changed to 80% creator / 20% platform / 0% referrer, owned by the
        // Safe. The deployer is the constructor owner ONLY long enough to call
        // setParams with the correct split (Ownable's constructor always sets the
        // fee to the 50/35/15 default — see FeeConfig.sol — so a fresh deploy left
        // untouched would silently ship the WRONG split), then transfers ownership
        // to the Safe. Ownable2Step: the Safe must separately call acceptOwnership()
        // once, from the Safe itself, after this script finishes.
        address feeConfigAddr = vm.envOr("FEE_CONFIG_ADDRESS", address(0));
        FeeConfig cfg;
        if (feeConfigAddr != address(0)) {
            cfg = FeeConfig(feeConfigAddr);
            console2.log("FeeConfig (reused):", feeConfigAddr);
        } else {
            address newOwner = vm.envAddress("NEW_FEE_CONFIG_OWNER"); // the Safe
            address newVault = vm.envAddress("NEW_FEE_CONFIG_VAULT"); // the Safe
            require(newOwner != address(0) && newVault != address(0), "new FeeConfig env unset");
            address deployer = msg.sender; // the --sender / keystore account, not a key
            cfg = new FeeConfig(deployer, newVault);
            cfg.setParams(100, 8_000, 2_000, 0); // 1% fee; 80% creator / 20% platform / 0% referrer
            cfg.transferOwnership(newOwner);
            console2.log("FeeConfig (new):    ", address(cfg));
            console2.log("  -> ownership transfer PENDING acceptOwnership() from the Safe:", newOwner);
        }

        // ── Hook: CREATE2-mined, same pattern as DeployHook.s.sol ────────────
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(pm, cfg, weth));
        BallastHook hook = new BallastHook{salt: salt}(IPoolManager(pm), cfg, weth);
        require(address(hook) == hookAddr, "hook mine mismatch");
        console2.log("BallastHook:        ", address(hook));

        // ── Seeder: needs the hook's address, then wire the hook back to it ──
        BallastSeeder seeder = new BallastSeeder(IPoolManager(pm), address(hook));
        hook.setSeeder(address(seeder));
        console2.log("BallastSeeder:      ", address(seeder));

        // ── Factory: items 5 (fixed 1 ETH) + 6 (16 quote assets) ─────────────
        address[] memory greenQuoteAssets = new address[](16);
        greenQuoteAssets[0] = SGOV;
        greenQuoteAssets[1] = NVDA;
        greenQuoteAssets[2] = TSLA;
        greenQuoteAssets[3] = GOOGL;
        greenQuoteAssets[4] = AAPL;
        greenQuoteAssets[5] = MSFT;
        greenQuoteAssets[6] = AMZN;
        greenQuoteAssets[7] = META;
        greenQuoteAssets[8] = SPY;
        greenQuoteAssets[9] = QQQ;
        greenQuoteAssets[10] = AMD;
        greenQuoteAssets[11] = MSTR;
        greenQuoteAssets[12] = PLTR;
        greenQuoteAssets[13] = COIN;
        greenQuoteAssets[14] = ORCL;
        greenQuoteAssets[15] = CRCL;
        BallastFactory factory =
            new BallastFactory(registry, weth, seeder, ethUsdFeed, ethUsdStaleWindow, greenQuoteAssets);
        console2.log("BallastFactory:     ", address(factory));

        // ── Router: v1 direct-pool-only curated routes ───────────────────────
        BallastRouter.Route[] memory routes = new BallastRouter.Route[](2);
        routes[0] = BallastRouter.Route({pool: NVDA_WETH_POOL, tokenA: weth, tokenB: NVDA});
        routes[1] = BallastRouter.Route({pool: SPY_WETH_POOL, tokenA: weth, tokenB: SPY});
        BallastRouter router = new BallastRouter(universalRouter, permit2, weth, routes);
        console2.log("BallastRouter:      ", address(router));

        vm.stopBroadcast();

        console2.log("--- frontend env to update ---");
        console2.log("NEXT_PUBLIC_FACTORY_ADDRESS =", address(factory));
        console2.log("NEXT_PUBLIC_V4_HOOK_ADDRESS =", address(hook));
        console2.log("NEXT_PUBLIC_ROUTER_ADDRESS  =", address(router));
        console2.log("Append to PRIOR_FACTORY_ADDRESSES (env) + HISTORICAL_HOOKS (web/lib/contracts.ts):");
        console2.log("  factory 0x069974136c78Cf0F2162463B95321E59F56523D8 / hook 0x9C15c992E4De3711715C8B7D717EF46e474680CC");
    }
}
