// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from
    "../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";
import {IRamsesV3Pool} from "../lib/ramses-v3-contracts/contracts/CL/core/interfaces/IRamsesV3Pool.sol";
import {PoolAddress} from "../lib/ramses-v3-contracts/contracts/CL/periphery/libraries/PoolAddress.sol";
import {RamsesLocker} from "../lib/ramses-v3-contracts/contracts/RamsesLocker.sol";
import {RamsesLockLauncher} from "../src/RamsesLockLauncher.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";
import {BallastFeeSplitter} from "../src/BallastFeeSplitter.sol";

interface IWETH9c {
    function deposit() external payable;
}

/// @dev Minimal Ramses-v3-style swap callback, generalized for either pool/
///      direction (unlike contracts/script/mainnet/RamsesSwapHelper.sol,
///      which is hardcoded to one WETH/NVDA script run). Holds no funds
///      between calls; pulls payment from the original caller via
///      transferFrom, same pattern as that script.
contract ForkSwapper {
    error NotPool();

    function swap(address pool, bool zeroForOne, int256 amountIn, uint160 sqrtPriceLimitX96)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) =
            IRamsesV3PoolSwap(pool).swap(address(this), zeroForOne, amountIn, sqrtPriceLimitX96, abi.encode(msg.sender, pool));
        // Forward whatever we received back to the original caller.
        address token0 = IRamsesV3Pool(pool).token0();
        address token1 = IRamsesV3Pool(pool).token1();
        if (amount0 < 0) IERC20(token0).transfer(msg.sender, uint256(-amount0));
        if (amount1 < 0) IERC20(token1).transfer(msg.sender, uint256(-amount1));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        (address payer, address pool) = abi.decode(data, (address, address));
        if (msg.sender != pool) revert NotPool();
        address token0 = IRamsesV3Pool(pool).token0();
        address token1 = IRamsesV3Pool(pool).token1();
        if (amount0Delta > 0) IERC20(token0).transferFrom(payer, pool, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).transferFrom(payer, pool, uint256(amount1Delta));
    }
}

interface IRamsesV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice Fork proof against Ramses' REAL deployed CL infrastructure on
///         Robinhood Chain — the authoritative test the mock-based unit suite
///         (test/RamsesLockLauncher.t.sol) cannot substitute for. Deploys a
///         FRESH RamsesLocker + RamsesLockLauncher (the real locker is not
///         deployed on-chain yet — see RAMSES_V3_POSITION_MANAGER/RAMSES_VOTER
///         below) against the real, already-deployed NonfungiblePositionManager
///         and Voter, and the real WETH/NVDA pool already used by
///         BallastRouterV2 (contracts/script/DeployBallastRouterV2.s.sol).
///
/// SKIPS unless ALL THREE of RH_RPC_URL_PAID, RAMSES_V3_POSITION_MANAGER, and
/// RAMSES_VOTER are set. The latter two are UNVERIFIED as of this writing —
/// not discoverable from this repo or from the public RPC/Blockscout in this
/// sandbox (Cloudflare-blocked) — see .env.example and the Phase-1 report.
contract BallastFeeSplitterForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    // WETH/NVDA Ramses v3 CL pool — from contracts/script/DeployBallastRouterV2.s.sol
    // buildRamsesRoutes()[0], read directly from chain during that script's own
    // Fables-vs-Ramses venue comparison.
    address constant WETH_NVDA_POOL = 0xF8996E22ac7A67fAe741830Ad83B3b4D5e5de203;

    INonfungiblePositionManager positionManager;
    RamsesLocker locker;
    RamsesLockLauncher launcher;
    BallastFeeSplitterFactory factory;
    ForkSwapper swapper;
    address safe = makeAddr("safe");
    address creator = makeAddr("creator");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        address pmAddr = vm.envOr("RAMSES_V3_POSITION_MANAGER", address(0));
        address voterAddr = vm.envOr("RAMSES_VOTER", address(0));
        if (bytes(url).length == 0 || pmAddr == address(0) || voterAddr == address(0)) {
            console2.log("BallastFeeSplitterFork: skipped (RH_RPC_URL_PAID / RAMSES_V3_POSITION_MANAGER / RAMSES_VOTER unset)");
            return;
        }
        vm.createSelectFork(url);
        forked = true;

        positionManager = INonfungiblePositionManager(pmAddr);
        // RamsesLocker is NOT deployed anywhere yet (the source only went public
        // recently) — this deploys a FRESH instance against the real, already-
        // live PositionManager/Voter, exactly as the eventual real deploy will.
        locker = new RamsesLocker(pmAddr, voterAddr);
        factory = new BallastFeeSplitterFactory(safe);
        launcher = new RamsesLockLauncher(pmAddr, address(locker), address(factory));
        swapper = new ForkSwapper();

        vm.deal(address(this), 100 ether);
        IWETH9c(WETH).deposit{value: 50 ether}();
    }

    /// @dev WETH must be acquired by wrapping real ETH (it's a live proxy, not
    ///      a plain balance-mapping ERC20 `deal()` can safely overwrite);
    ///      every other token uses the standard `deal()` cheatcode. Assumes
    ///      `address(this)` holds ~0 of `token` beforehand in every call site
    ///      here (true in this test's sequence).
    function _fund(address token, uint256 amount) internal {
        if (token == WETH) {
            vm.deal(address(this), address(this).balance + amount);
            IWETH9c(WETH).deposit{value: amount}();
        } else {
            deal(token, address(this), amount);
        }
    }

    /// @notice The single highest-value fork assertion: the vendored
    ///         PoolAddress library's POOL_INIT_CODE_HASH must match Robinhood
    ///         Chain's REAL deployed Ramses CL pool bytecode, or
    ///         `RamsesLocker.poolOf[tokenId]` (and everything keyed off it —
    ///         collectRewards, pendingFees) silently points at the wrong
    ///         address. See lib/ramses-v3-contracts/VENDORED.md.
    function test_fork_poolAddressComputationMatchesRealPool() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address token0 = IRamsesV3Pool(WETH_NVDA_POOL).token0();
        address token1 = IRamsesV3Pool(WETH_NVDA_POOL).token1();
        int24 tickSpacing = IRamsesV3Pool(WETH_NVDA_POOL).tickSpacing();
        address poolDeployer = IRamsesV3Pool(WETH_NVDA_POOL).factory();

        address computed =
            PoolAddress.computeAddress(poolDeployer, PoolAddress.PoolKey({token0: token0, token1: token1, tickSpacing: tickSpacing}));
        assertEq(computed, WETH_NVDA_POOL, "vendored PoolAddress init code hash does not match the real deployed pool");
    }

    /// @notice Full flow: mint a single-sided WETH/NVDA position via the
    ///         launcher, lock it, swap BOTH directions through the real pool
    ///         to generate real fees on both legs, permissionlessly collect,
    ///         and confirm BOTH roles (creator 80%, protocol 20%) can claim.
    function test_fork_mintLockSwapBothDirectionsCollectDistribute() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        address token0 = IRamsesV3Pool(WETH_NVDA_POOL).token0();
        address token1 = IRamsesV3Pool(WETH_NVDA_POOL).token1();
        int24 tickSpacing = IRamsesV3Pool(WETH_NVDA_POOL).tickSpacing();
        (, int24 currentTick,,,,,) = IRamsesV3Pool(WETH_NVDA_POOL).slot0();

        // Range entirely ABOVE the current tick -> single-sided in token0 only
        // (same "fully above current price needs only the lower-address token"
        // shape BallastSeeder uses for its own one-sided seed).
        int24 tickLower = ((currentTick / tickSpacing) + 10) * tickSpacing;
        int24 tickUpper = tickLower + 20 * tickSpacing;

        uint256 seedAmount = 1 ether; // of token0, whichever token that is
        _fund(token0, seedAmount);
        IERC20(token0).approve(address(launcher), seedAmount);

        RamsesLockLauncher.MintLegs memory legs = RamsesLockLauncher.MintLegs({
            token0: token0,
            token1: token1,
            tickSpacing: tickSpacing,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: seedAmount,
            amount1Desired: 0,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 hours
        });
        (uint256 tokenId, address splitter) = launcher.createAndLock(legs, NVDA, creator, 8000, 2000);
        assertEq(positionManager.ownerOf(tokenId), address(locker));
        assertEq(IERC20(token0).balanceOf(address(launcher)), 0);
        assertEq(IERC20(token1).balanceOf(address(launcher)), 0);

        // Swap token0 -> token1 (pushes price up, into/through the position's range).
        _fund(token0, 5 ether);
        IERC20(token0).approve(address(swapper), 5 ether);
        swapper.swap(WETH_NVDA_POOL, true, 5 ether, 4295128740 + 1); // MIN_SQRT_RATIO+1 bound, exact-input

        // Swap token1 -> token0 (price back down), realizing fees on the other leg too.
        uint256 token1Bal = IERC20(token1).balanceOf(address(this));
        require(token1Bal > 0, "swap produced no token1 to swap back");
        IERC20(token1).approve(address(swapper), token1Bal);
        swapper.swap(WETH_NVDA_POOL, false, int256(token1Bal / 2), 1461446703485210103287273052203988822378723970341); // MAX_SQRT_RATIO-1

        // Permissionless collect, pays BOTH legs directly to the splitter.
        vm.prank(makeAddr("stranger"));
        (uint256 c0, uint256 c1) = locker.collect(tokenId);
        console2.log("collected amount0:", c0);
        console2.log("collected amount1:", c1);
        assertTrue(c0 > 0 || c1 > 0, "no fees accrued from either swap");

        if (c0 > 0) BallastFeeSplitter(splitter).distribute(token0);
        if (c1 > 0) BallastFeeSplitter(splitter).distribute(token1);

        // Both roles actually received their share.
        assertTrue(IERC20(token0).balanceOf(creator) + IERC20(token1).balanceOf(creator) > 0, "creator got nothing");
        assertTrue(IERC20(token0).balanceOf(safe) + IERC20(token1).balanceOf(safe) > 0, "protocol got nothing");
    }
}
