// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// READ-ONLY FORK SMOKE TEST — never broadcasts. Exercises the REAL deployed
// BasketZap (0x87c0…1aBA) against a mainnet fork, impersonating launch id 2's
// creator. Run with `forge script … --fork-url <rpc>` and NO --broadcast.
// Everything runs in the local EVM fork; nothing reaches mainnet.
//
// Pinned 0.8.28 (repo default) and reaches BasketZap through a minimal inline
// interface rather than importing src/BasketZap.sol — that contract pins 0.8.26
// for its v4-periphery graph and can't share a compile unit with the 0.8.28
// BackingLens/ProjectTreasury we need here. The Leg tuple below is a byte-exact
// mirror of BasketZap.Leg (asset, weightBps, preferFables, fablesHopIdx,
// ramsesHopIdx, minOut).
import {Script, console2} from "forge-std/Script.sol";
import {BackingLens} from "../../src/BackingLens.sol";
import {ProjectTreasury} from "../../src/ProjectTreasury.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IBasketZap {
    struct Leg {
        address asset;
        uint16 weightBps;
        bool preferFables;
        uint256[] fablesHopIdx;
        uint256[] ramsesHopIdx;
        uint256 minOut;
    }

    function swapBasket(address launchToken, Leg[] calldata legs, uint256 swapDeadline)
        external
        payable
        returns (uint256[] memory amountsOut, bool[] memory usedFables);
}

contract SmokeBasketLive is Script {
    IBasketZap constant ZAP = IBasketZap(0x87c046aB0fB8B7B86BA1a62A956242d499051aBA);
    BackingLens constant LENS = BackingLens(0x21fdE9AcFb45DA09262672b9f35FB3b4Fe91d770);

    address constant CREATOR = 0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85;
    address constant TOKEN = 0x10842066A3334d76CBBc206D26C670db9768A4BF;
    address constant TREASURY = 0xbdf12714eC40ec3d1D29684AE14100ab3f355B4a;

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;

    function run() external {
        vm.deal(CREATOR, 1 ether);
        _single();
        _three();
    }

    function _one(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    function _none() internal pure returns (uint256[] memory x) {
        x = new uint256[](0);
    }

    // Deposit EXACTLY `amount` (the swap's own output) so the BackingLens delta
    // reflects this basket only, not any pre-existing wallet balance.
    function _depositExact(address asset, uint256 amount) internal {
        vm.startPrank(CREATOR);
        IERC20(asset).approve(TREASURY, amount);
        ProjectTreasury(TREASURY).deposit(asset, amount);
        vm.stopPrank();
    }

    function _single() internal {
        console2.log("================ 1-ASSET: NVDA 100%, 0.01 ETH ================");
        BackingLens.Backing memory b0 = LENS.backingOf(TREASURY);

        IBasketZap.Leg[] memory legs = new IBasketZap.Leg[](1);
        legs[0] = IBasketZap.Leg({
            asset: NVDA,
            weightBps: 10000,
            preferFables: false,
            fablesHopIdx: _two(0, 1),
            ramsesHopIdx: _one(0),
            minOut: 1
        });

        uint256 g0 = gasleft();
        vm.prank(CREATOR);
        (uint256[] memory out, bool[] memory usedFables) =
            ZAP.swapBasket{value: 0.01 ether}(TOKEN, legs, block.timestamp + 600);
        uint256 gasUsed = g0 - gasleft();

        console2.log("NVDA amountOut (18dp):", out[0]);
        console2.log("usedFables:", usedFables[0]);
        console2.log("swapBasket gas used:", gasUsed);

        _depositExact(NVDA, out[0]);
        console2.log("deposited into treasury (18dp):", out[0]);

        BackingLens.Backing memory b1 = LENS.backingOf(TREASURY);
        console2.log("totalValueUsd before (1e18):", b0.totalValueUsd);
        console2.log("totalValueUsd after  (1e18):", b1.totalValueUsd);
        console2.log("backing DELTA (1e18 USD):", b1.totalValueUsd - b0.totalValueUsd);
    }

    function _three() internal {
        // 0.15 ETH (not 0.01): the brief gave no size for the 3-asset basket, and
        // 30-40% of 0.01 ETH lands each leg below the treasury's 0.1-token
        // minDeposit. 0.15 ETH clears it for all three while staying a small,
        // low-impact ticket (each leg <=0.06 ETH; discovery measured <=3% at 0.1).
        console2.log("========= 3-ASSET: NVDA 40 / SPY 30 / SGOV 30, 0.15 ETH =========");
        BackingLens.Backing memory b0 = LENS.backingOf(TREASURY);

        IBasketZap.Leg[] memory legs = new IBasketZap.Leg[](3);
        legs[0] = IBasketZap.Leg({asset: NVDA, weightBps: 4000, preferFables: false, fablesHopIdx: _two(0, 1), ramsesHopIdx: _one(0), minOut: 1});
        legs[1] = IBasketZap.Leg({asset: SPY, weightBps: 3000, preferFables: false, fablesHopIdx: _two(0, 10), ramsesHopIdx: _one(1), minOut: 1});
        // SGOV has no Fables route — Ramses-only WETH->USDG->SGOV (idx 4,12).
        legs[2] = IBasketZap.Leg({asset: SGOV, weightBps: 3000, preferFables: false, fablesHopIdx: _none(), ramsesHopIdx: _two(4, 12), minOut: 1});

        uint256 g0 = gasleft();
        vm.prank(CREATOR);
        (uint256[] memory out, bool[] memory usedFables) =
            ZAP.swapBasket{value: 0.15 ether}(TOKEN, legs, block.timestamp + 600);
        uint256 gasUsed = g0 - gasleft();

        console2.log("NVDA amountOut (18dp):", out[0]);
        console2.log("SPY  amountOut (18dp):", out[1]);
        console2.log("SGOV amountOut (18dp):", out[2]);
        console2.log("usedFables NVDA/SPY/SGOV:", usedFables[0], usedFables[1], usedFables[2]);
        console2.log("swapBasket gas used:", gasUsed);

        _depositExact(NVDA, out[0]);
        _depositExact(SPY, out[1]);
        _depositExact(SGOV, out[2]);

        BackingLens.Backing memory b1 = LENS.backingOf(TREASURY);
        console2.log("totalValueUsd before (1e18):", b0.totalValueUsd);
        console2.log("totalValueUsd after  (1e18):", b1.totalValueUsd);
        console2.log("backing DELTA (1e18 USD):", b1.totalValueUsd - b0.totalValueUsd);
    }
}
