// SPDX-License-Identifier: MIT
// 0.8.26, not this repo's usual 0.8.28 — same reason as BallastRouterV2.sol
// itself: this script constructs one via `new`, so it shares its import
// graph and must compile under the same version.
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BallastRouterV2} from "../src/BallastRouterV2.sol";

/// @title DeployBallastRouterV2 — ETH -> stock -> Ballast pool, Fables OR Ramses v3
///
/// @notice No private key read by this script — sign with `--account
///         fablesrouter-deployer --password-file
///         ~/.foundry/keystores/fablesrouter-deployer.pass`. Brand new keystore,
///         never the compromised 0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1.
///
/// @dev Every address below was read directly from chain during the Fables-vs-Ramses
///      research pass (2026-10-02/03) — Fables' own `activePools()` registry for the
///      FablesHop entries, the Ramses v3 CL factory's `getPool()` for the RamsesRoute
///      entries (picking the deepest tickSpacing variant per pair by on-chain
///      `liquidity()`/quoted depth, not assumed). Indices are listed next to each
///      entry because callers address hops by index, never by address.
///
/// Run:
///   forge script script/DeployBallastRouterV2.s.sol:DeployBallastRouterV2 \
///     --rpc-url robinhood_mainnet --account fablesrouter-deployer \
///     --password-file ~/.foundry/keystores/fablesrouter-deployer.pass --broadcast
contract DeployBallastRouterV2 is Script {
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // Robinhood stock / RWA token addresses (AssetRegistry-allowlisted, verified
    // against Fables' own addresses in phase-1 research — zero mismatches).
    address public constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address public constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address public constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address public constant GOOGL = 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3;
    address public constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address public constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address public constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
    address public constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address public constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address public constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address public constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;
    address public constant COIN = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;
    address public constant PLTR = 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A;
    address public constant ORCL = 0xb0992820E760d836549ba69BC7598b4af75dEE03;
    address public constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address public constant CRCL = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5;

    // --- Fables hooks (verified via Sourcify against activePools(), phase-1 pass) ---
    address public constant HOOK_ETH_USDG = 0x06a889870C8f83640D6816319f72e2aA579b6080;
    address public constant HOOK_NVDA_USDG = 0x66622f77B797D506e5376F7798b67ab288966080;
    address public constant HOOK_AAPL_USDG = 0x70a9A88402989226847Ec122043CE5e7FF462080;
    address public constant HOOK_META_USDG = 0x8AF95932eC4484fb10C641a4cBcf19a798cB2080;
    address public constant HOOK_TSLA_USDG = 0x67D86050d22D574Df046F3D90F722045F714e080;
    address constant HOOK_5POOL = 0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080; // AMZN/CRCL/MSTR/COIN/PLTR vs USDG
    address public constant HOOK_SPY_USDG = 0xA0E8fBFf13E24Af2b5e61A72800E08a161bDe080;
    address public constant HOOK_SPY_QQQ = 0x08E52564Bad99E05a694b4809F397edcA417A080;

    uint24 constant DYNAMIC_FEE = 0x800000;

    /// @dev FablesHop index map (for off-chain callers building `fablesHopIdx`):
    ///   0: ETH/USDG        5: AMZN/USDG (hook5pool)   9: USDG/PLTR (hook5pool)
    ///   1: USDG/NVDA       6: USDG/CRCL (hook5pool)  10: SPY/USDG
    ///   2: USDG/AAPL       7: USDG/MSTR (hook5pool)  11: SPY/QQQ
    ///   3: USDG/META       8: USDG/COIN (hook5pool)
    ///   4: TSLA/USDG
    ///
    /// Per-ticker path: NVDA=[0,1] AAPL=[0,2] META=[0,3] TSLA=[0,4] AMZN=[0,5]
    /// CRCL=[0,6] MSTR=[0,7] COIN=[0,8] PLTR=[0,9] SPY=[0,10] QQQ=[0,10,11].
    /// SGOV/GOOGL/MSFT/AMD/ORCL: no Fables route, pass an empty array.
    ///
    /// Fables-team guidance (2026-10-03): META, MSTR and the SPY/QQQ hop (hop 11) are
    /// deep only for SMALL tickets — the off-chain quoting layer must re-quote both
    /// venues by trade size for these every call, never cache a fixed preference.
    /// Confirmed on-chain this session: QQQ's path (hop 11) reverts above ~1 ETH-
    /// equivalent; META and MSTR revert somewhere between 1 and 5 ETH-equivalent.
    /// PLTR and COIN: Fables hop wired (9, 8) but currently reverts outright at real
    /// size (COIN fails above ~0.1 ETH, PLTR reverts at every size tested) — the
    /// off-chain layer should default these two to Ramses-first until Fables
    /// liquidity deepens, per the same guidance. The contract does not special-case
    /// any of this; it is purely an off-chain routing default.
    function buildFablesHops() public pure returns (BallastRouterV2.FablesHop[] memory hops) {
        hops = new BallastRouterV2.FablesHop[](12);
        hops[0] = BallastRouterV2.FablesHop(address(0), USDG, DYNAMIC_FEE, 10, HOOK_ETH_USDG);
        hops[1] = BallastRouterV2.FablesHop(USDG, NVDA, DYNAMIC_FEE, 10, HOOK_NVDA_USDG);
        hops[2] = BallastRouterV2.FablesHop(USDG, AAPL, DYNAMIC_FEE, 10, HOOK_AAPL_USDG);
        hops[3] = BallastRouterV2.FablesHop(USDG, META, DYNAMIC_FEE, 10, HOOK_META_USDG);
        hops[4] = BallastRouterV2.FablesHop(TSLA, USDG, DYNAMIC_FEE, 10, HOOK_TSLA_USDG);
        hops[5] = BallastRouterV2.FablesHop(AMZN, USDG, DYNAMIC_FEE, 60, HOOK_5POOL);
        hops[6] = BallastRouterV2.FablesHop(USDG, CRCL, DYNAMIC_FEE, 60, HOOK_5POOL);
        hops[7] = BallastRouterV2.FablesHop(USDG, MSTR, DYNAMIC_FEE, 60, HOOK_5POOL);
        hops[8] = BallastRouterV2.FablesHop(USDG, COIN, DYNAMIC_FEE, 60, HOOK_5POOL);
        hops[9] = BallastRouterV2.FablesHop(USDG, PLTR, DYNAMIC_FEE, 60, HOOK_5POOL);
        hops[10] = BallastRouterV2.FablesHop(SPY, USDG, DYNAMIC_FEE, 10, HOOK_SPY_USDG);
        hops[11] = BallastRouterV2.FablesHop(SPY, QQQ, DYNAMIC_FEE, 1, HOOK_SPY_QQQ);
    }

    /// @dev RamsesRoute index map:
    ///    0: NVDA/WETH (ts50)        9: PLTR/USDG (ts50)
    ///    1: SPY/WETH (ts1)         10: MSTR/USDG (ts10)
    ///    2: META/WETH (ts50)       11: CRCL/USDG (ts50)
    ///    3: QQQ/WETH (ts10)        12: SGOV/USDG (ts1)
    ///    4: WETH/USDG (ts1, bridge) 13: GOOGL/USDG (ts1)
    ///    5: AAPL/USDG (ts1)        14: MSFT/USDG (ts50)
    ///    6: TSLA/USDG (ts1)        15: AMD/USDG (ts50)
    ///    7: AMZN/USDG (ts1)        16: ORCL/USDG (ts5)
    ///    8: COIN/USDG (ts50)
    ///
    /// Per-ticker path: NVDA=[0] SPY=[1] META=[2] QQQ=[3]; everyone else bridges via
    /// WETH/USDG: AAPL=[4,5] TSLA=[4,6] AMZN=[4,7] COIN=[4,8] PLTR=[4,9] MSTR=[4,10]
    /// CRCL=[4,11] SGOV=[4,12] GOOGL=[4,13] MSFT=[4,14] AMD=[4,15] ORCL=[4,16].
    /// Every ticker keeps a Ramses route, including the five with no Fables pool.
    function buildRamsesRoutes() public pure returns (BallastRouterV2.RamsesRoute[] memory routes) {
        routes = new BallastRouterV2.RamsesRoute[](17);
        routes[0] = BallastRouterV2.RamsesRoute(0xF8996E22ac7A67fAe741830Ad83B3b4D5e5de203, WETH, NVDA);
        routes[1] = BallastRouterV2.RamsesRoute(0x3e1afDe90341F843c941fF4077d915bDE3008c7E, WETH, SPY);
        routes[2] = BallastRouterV2.RamsesRoute(0xb8b1b1B0F08092faB7290476ed8BAdeD0Ca81081, WETH, META);
        routes[3] = BallastRouterV2.RamsesRoute(0x741Ad272cA4fc8D3cB3B08202be4C00D0286D91E, WETH, QQQ);
        routes[4] = BallastRouterV2.RamsesRoute(0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0, WETH, USDG);
        routes[5] = BallastRouterV2.RamsesRoute(0x6f7368F0dd18a4E1db631095363d109E6aDe9293, USDG, AAPL);
        routes[6] = BallastRouterV2.RamsesRoute(0x131CC5ca8bAf2fc7e3A4EDC0B82e62d3E74E24dd, USDG, TSLA);
        routes[7] = BallastRouterV2.RamsesRoute(0x5Ca0291DDB0Ca66a65f4269102fe4A5c9Fa8E0De, USDG, AMZN);
        routes[8] = BallastRouterV2.RamsesRoute(0xe9B6F324A7019B1f073AfF1870d664Bf9673f782, USDG, COIN);
        routes[9] = BallastRouterV2.RamsesRoute(0x53D3F8B79Eea3C4dD7dF5c1d3A7215BaaAd772Ee, USDG, PLTR);
        routes[10] = BallastRouterV2.RamsesRoute(0x8Bab57c03aB91Bd4BDF954Feeb80078a2A439eb6, USDG, MSTR);
        routes[11] = BallastRouterV2.RamsesRoute(0x9176c773fc386c94AeD7B50EDE68CF992eE143d9, USDG, CRCL);
        routes[12] = BallastRouterV2.RamsesRoute(0x8695820E01903c83CCfc27a0933c9Fd69f13caC1, USDG, SGOV);
        routes[13] = BallastRouterV2.RamsesRoute(0x5c0EAa89799F7B76606f4Ff66C92a2654d178927, USDG, GOOGL);
        routes[14] = BallastRouterV2.RamsesRoute(0x8595C466E148ECC019183fA771c9670792143DE7, USDG, MSFT);
        routes[15] = BallastRouterV2.RamsesRoute(0x16dd3a82ea5B132Be4fcF4dAD4Cc7eCD4eb25C3F, USDG, AMD);
        routes[16] = BallastRouterV2.RamsesRoute(0x06DB17c4Ec4Ab4Ecc856110BBa1cF02AF7FE6Bf8, USDG, ORCL);
    }

    function run() external returns (BallastRouterV2 router) {
        BallastRouterV2.RamsesRoute[] memory routes = buildRamsesRoutes();
        BallastRouterV2.FablesHop[] memory hops = buildFablesHops();

        vm.startBroadcast();
        router = new BallastRouterV2(IPoolManager(POOL_MANAGER), WETH, routes, hops);
        vm.stopBroadcast();

        console2.log("BallastRouterV2 deployed:", address(router));
        console2.log("NEXT: forge verify-contract", address(router));
        console2.log("src/BallastRouterV2.sol:BallastRouterV2 --verifier blockscout");
        console2.log("--verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
    }
}
