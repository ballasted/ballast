// SPDX-License-Identifier: MIT
// 0.8.26 — imports DeployBasketZap (which shares BasketZap's v4-periphery graph).
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {DeployBasketZap} from "../DeployBasketZap.s.sol";
import {BasketZap} from "../../src/BasketZap.sol";

/// @dev The fork's V4Quoter multi-hop param shape (this chain's UniversalRouter
///      fork adds a per-params `minHopPriceX36 uint256[]`, one entry per hop —
///      confirmed against web/lib/abis.ts quoterMultiHopAbi). `address` is used
///      where the real ABI uses Currency/IHooks — identical 20-byte encoding.
struct QPathKey {
    address intermediateCurrency;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
    bytes hookData;
}

struct QExactInputParams {
    address currencyIn;
    QPathKey[] path;
    uint256[] minHopPriceX36;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

interface IV4QuoterFork {
    function quoteExactInput(QExactInputParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

struct QRamsesParams {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    int24 tickSpacing;
    uint160 sqrtPriceLimitX96;
}

interface IRamsesQuoter {
    function quoteExactInputSingle(QRamsesParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtAfter, uint32 ticks, uint256 gas);
}

interface IRegistry {
    function feedOf(address asset) external view returns (address);
}

interface IFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title QuoteBasketRoutes — READ-ONLY route-impact probe. NEVER broadcast.
///
/// @notice For every one of the 16 AssetRegistry-listed stock assets, quotes
///         0.01 / 0.1 / 1 ETH on every real path (Fables v4 multi-hop through
///         the live V4Quoter; Ramses v3 chained through the live QuoterV2) and
///         compares the output to the Chainlink-implied fair value, printing
///         the impact in basis points. Feeds the docs/BASKET_DISCOVERY.md
///         route table. Run WITHOUT --broadcast:
///           forge script script/probe/QuoteBasketRoutes.s.sol:QuoteBasketRoutes --rpc-url "$RH_RPC_URL_PAID"
contract QuoteBasketRoutes is Script {
    address constant V4QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant RAMSES_QUOTER = 0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6;
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    DeployBasketZap dh;
    BasketZap.FablesHop[] fables;
    BasketZap.RamsesRoute[] ramses;
    uint256 ethUsd1e18; // ETH price scaled to 1e18

    uint128[3] SIZES = [uint128(0.01 ether), uint128(0.1 ether), uint128(1 ether)];

    function run() external {
        dh = new DeployBasketZap();
        BasketZap.FablesHop[] memory f = dh.buildFablesHops();
        BasketZap.RamsesRoute[] memory r = dh.buildRamsesRoutes();
        for (uint256 i = 0; i < f.length; i++) fables.push(f[i]);
        for (uint256 i = 0; i < r.length; i++) ramses.push(r[i]);

        ethUsd1e18 = _feedPrice1e18(ETH_USD_FEED);
        console2.log("ETH/USD (1e18):", ethUsd1e18);
        console2.log("================================================");

        _asset("NVDA", dh.NVDA(), _i2(0, 1), _i1(0));
        _asset("AAPL", dh.AAPL(), _i2(0, 2), _i2(4, 5));
        _asset("META", dh.META(), _i2(0, 3), _i1(2));
        _asset("TSLA", dh.TSLA(), _i2(0, 4), _i2(4, 6));
        _asset("AMZN", dh.AMZN(), _i2(0, 5), _i2(4, 7));
        _asset("CRCL", dh.CRCL(), _i2(0, 6), _i2(4, 11));
        _asset("MSTR", dh.MSTR(), _i2(0, 7), _i2(4, 10));
        _asset("COIN", dh.COIN(), _i2(0, 8), _i2(4, 8));
        _asset("PLTR", dh.PLTR(), _i2(0, 9), _i2(4, 9));
        _asset("SPY", dh.SPY(), _i2(0, 10), _i1(1));
        _asset("QQQ", dh.QQQ(), _i3(0, 10, 11), _i1(3));
        _asset("SGOV", dh.SGOV(), _empty(), _i2(4, 12));
        _asset("GOOGL", dh.GOOGL(), _empty(), _i2(4, 13));
        _asset("MSFT", dh.MSFT(), _empty(), _i2(4, 14));
        _asset("AMD", dh.AMD(), _empty(), _i2(4, 15));
        _asset("ORCL", dh.ORCL(), _empty(), _i2(4, 16));
    }

    function _asset(string memory sym, address asset, uint256[] memory fIdx, uint256[] memory rIdx) internal {
        uint256 px = _feedPrice1e18(_feed(asset));
        console2.log("----", sym, "-- Chainlink(1e18):", px);
        for (uint256 s = 0; s < 3; s++) {
            uint128 amtIn = SIZES[s];
            // Chainlink-fair output in the asset's 18dp units:
            // ethIn * ethUsd / assetUsd (decimals cancel).
            uint256 fair = px == 0 ? 0 : (uint256(amtIn) * ethUsd1e18) / px;

            uint256 fOut = fIdx.length == 0 ? 0 : _quoteFables(asset, fIdx, amtIn);
            uint256 rOut = _quoteRamses(asset, rIdx, amtIn);

            console2.log("  size(wei):", uint256(amtIn));
            _line("    fables", fOut, fair);
            _line("    ramses", rOut, fair);
        }
    }

    function _line(string memory label, uint256 out, uint256 fair) internal pure {
        if (out == 0) {
            console2.log(label, "out=0 (no quote / dead)");
            return;
        }
        // impactBps = (fair - out) / fair * 10000, signed (negative = better than fair)
        if (fair == 0) {
            console2.log(label, "out:", out);
            return;
        }
        if (out >= fair) {
            uint256 betterBps = ((out - fair) * 10_000) / fair;
            console2.log(label, "out:", out);
            console2.log("       impactBps(better):", betterBps);
        } else {
            uint256 worseBps = ((fair - out) * 10_000) / fair;
            console2.log(label, "out:", out);
            console2.log("       impactBps(worse):", worseBps);
        }
    }

    function _quoteFables(address asset, uint256[] memory idx, uint128 amtIn) internal returns (uint256 out) {
        QPathKey[] memory path = new QPathKey[](idx.length);
        address cur = address(0); // native ETH entry
        for (uint256 i = 0; i < idx.length; i++) {
            BasketZap.FablesHop memory h = fables[idx[i]];
            address next = cur == h.currency0 ? h.currency1 : h.currency0;
            path[i] = QPathKey(next, h.fee, h.tickSpacing, h.hooks, "");
            cur = next;
        }
        if (cur != asset) {
            console2.log("    fables: BAD CHAIN (ends wrong)");
            return 0;
        }
        QExactInputParams memory p =
            QExactInputParams(address(0), path, new uint256[](0), amtIn, 0);
        try IV4QuoterFork(V4QUOTER).quoteExactInput(p) returns (uint256 o, uint256) {
            return o;
        } catch {
            return 0;
        }
    }

    function _quoteRamses(address asset, uint256[] memory idx, uint128 amtIn) internal returns (uint256 out) {
        address cur = WETH;
        uint256 amt = amtIn;
        for (uint256 i = 0; i < idx.length; i++) {
            BasketZap.RamsesRoute memory rt = ramses[idx[i]];
            address next = rt.tokenA == cur ? rt.tokenB : rt.tokenA;
            int24 ts = _ramsesTickSpacing(idx[i]);
            try IRamsesQuoter(RAMSES_QUOTER).quoteExactInputSingle(QRamsesParams(cur, next, amt, ts, 0)) returns (
                uint256 o, uint160, uint32, uint256
            ) {
                amt = o;
            } catch {
                return 0;
            }
            if (amt == 0) return 0;
            cur = next;
        }
        if (cur != asset) return 0;
        return amt;
    }

    // Ramses tickSpacings, index-aligned to buildRamsesRoutes() (see
    // web/lib/routerV2.ts RAMSES_ROUTES — execution doesn't need it, quoting does).
    function _ramsesTickSpacing(uint256 idx) internal pure returns (int24) {
        if (idx == 0) return 50; // NVDA/WETH
        if (idx == 1) return 1; // SPY/WETH
        if (idx == 2) return 50; // META/WETH
        if (idx == 3) return 10; // QQQ/WETH
        if (idx == 4) return 1; // WETH/USDG
        if (idx == 5) return 1; // USDG/AAPL
        if (idx == 6) return 1; // USDG/TSLA
        if (idx == 7) return 1; // USDG/AMZN
        if (idx == 8) return 50; // USDG/COIN
        if (idx == 9) return 50; // USDG/PLTR
        if (idx == 10) return 10; // USDG/MSTR
        if (idx == 11) return 50; // USDG/CRCL
        if (idx == 12) return 1; // USDG/SGOV
        if (idx == 13) return 1; // USDG/GOOGL
        if (idx == 14) return 50; // USDG/MSFT
        if (idx == 15) return 50; // USDG/AMD
        return 5; // USDG/ORCL (idx 16)
    }

    function _feed(address asset) internal view returns (address) {
        return IRegistry(REGISTRY).feedOf(asset);
    }

    function _feedPrice1e18(address feed) internal view returns (uint256) {
        if (feed == address(0)) return 0;
        (, int256 answer,,,) = IFeed(feed).latestRoundData();
        if (answer <= 0) return 0;
        uint8 dec = IFeed(feed).decimals();
        return (uint256(answer) * 1e18) / (10 ** dec);
    }

    function _empty() internal pure returns (uint256[] memory a) {
        a = new uint256[](0);
    }

    function _i1(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _i2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _i3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }
}
