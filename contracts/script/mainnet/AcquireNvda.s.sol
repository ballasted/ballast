// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RamsesSwapHelper} from "./RamsesSwapHelper.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

/// @title AcquireNvda — wrap ETH, swap for NVDA on the real Ramses v3 WETH/NVDA
///        pool via RamsesSwapHelper. One-off, NOT part of the Ballast protocol —
///        exists only to prove HARUNA's NVDA-quoted pool trades end to end
///        (docs/exit-liquidity-table.md's Ramses pool is the only place real
///        WETH/NVDA liquidity exists on this chain).
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   the buyer's key
///   SWAP_AMOUNT_IN         wei of WETH to spend (default 0.0002 ETH)
///   MIN_NVDA_OUT           minimum NVDA out, raw 18dp (default 0 — real run should
///                          set this from a fresh quote right before broadcasting)
contract AcquireNvda is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    // Ramses v3 WETH/NVDA pool — verified on-chain 2026-09-25: token0=WETH,
    // token1=NVDA, fee=500, liquidity > 0 (see docs/exit-liquidity-table.md).
    address constant POOL = 0xF8996E22ac7A67fAe741830Ad83B3b4D5e5de203;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 amountIn = vm.envOr("SWAP_AMOUNT_IN", uint256(200_000_000_000_000)); // 0.0002 ETH
        uint256 minOut = vm.envOr("MIN_NVDA_OUT", uint256(0));
        address eoa = vm.addr(pk);

        console2.log("=== AcquireNvda ===");
        console2.log("EOA:", eoa);
        console2.log("amountIn (wei WETH):", amountIn);
        require(eoa.balance > amountIn + 1e14, "need ETH for amountIn + gas");

        uint256 nvdaBefore = IERC20(NVDA).balanceOf(eoa);

        vm.startBroadcast(pk);
        IWETH(WETH).deposit{value: amountIn}();
        RamsesSwapHelper helper = new RamsesSwapHelper(POOL, WETH, NVDA);
        IWETH(WETH).approve(address(helper), amountIn);
        uint256 nvdaOut = helper.swapWethForNvda(amountIn, minOut, eoa);
        vm.stopBroadcast();

        uint256 received = IERC20(NVDA).balanceOf(eoa) - nvdaBefore;
        console2.log("helper:", address(helper));
        console2.log("nvdaOut (returned):", nvdaOut);
        console2.log("NVDA received (measured):", received);
        require(received > 0 && received == nvdaOut, "swap accounting mismatch");
        console2.log("ACQUIRE OK");
    }
}
