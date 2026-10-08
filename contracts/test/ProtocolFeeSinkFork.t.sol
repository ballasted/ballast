// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from
    "../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";
import {IRamsesV3Pool} from "../lib/ramses-v3-contracts/contracts/CL/core/interfaces/IRamsesV3Pool.sol";
import {RamsesLocker} from "../lib/ramses-v3-contracts/contracts/RamsesLocker.sol";
import {RamsesLockLauncher} from "../src/RamsesLockLauncher.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";
import {BallastFeeSplitter} from "../src/BallastFeeSplitter.sol";
import {ProtocolFeeSink} from "../src/ProtocolFeeSink.sol";
import {MockRamsesVoter} from "./mocks/MockRamsesVoter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ForkSwapper} from "./BallastFeeSplitterFork.t.sol";

interface IWETH9d {
    function deposit() external payable;
}

interface IRamsesV3FactoryCreate {
    function createPool(address tokenA, address tokenB, int24 tickSpacing, uint160 sqrtPriceX96)
        external
        returns (address pool);
}

/// @notice Full path, real infrastructure: PositionManager -> locker -> splitter
///         -> ProtocolFeeSink. Creates a BRAND NEW pool (WETH / a freshly
///         deployed, deliberately unlisted "launched token") via the real
///         RamsesV3Factory, rather than reusing a real routing pool like
///         WETH/NVDA — both sides of that pool ARE AssetRegistry-listed quote
///         assets, which would route to the Safe either way and never
///         exercise the sink's burn path. A genuinely unlisted token is the
///         only honest way to prove "the launched token ends at the dead
///         address."
///
/// SKIPS unless RH_RPC_URL_PAID is set.
contract ProtocolFeeSinkForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant POSITION_MANAGER = 0x2eBd7B85a4E08D5B508b04BA147976C94afE6590;
    address constant RAMSES_V3_FACTORY = 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8;
    // Real mainnet AssetRegistry -- the freshly-minted "launched token" below is
    // guaranteed NOT listed here (it doesn't exist until this test deploys it).
    address constant ASSET_REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant SAFE = 0xEFC97e16a24d2434C7138a2634E554a0631aC079;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // tickSpacing 100 == the real 1% fee tier (RamsesV3Factory.tickSpacingInitialFee(100)
    // == 10000, confirmed on-chain 2026-10-09) -- the tier we'd actually launch
    // with, not just a convenient already-enabled one. createPool() requires an
    // already-enabled tickSpacing (enableTickSpacing is AccessHub-gated), and
    // this one already is.
    int24 constant TICK_SPACING = 100;
    // sqrtPriceX96 for tick 0 (1:1 starting price) -- 2^96.
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    RamsesLocker locker;
    RamsesLockLauncher launcher;
    BallastFeeSplitterFactory factory;
    ProtocolFeeSink sink;
    ForkSwapper swapper;
    MockERC20 launchedToken;
    address pool;
    address creator = makeAddr("creator");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) {
            console2.log("ProtocolFeeSinkFork: skipped (RH_RPC_URL_PAID unset)");
            return;
        }
        vm.createSelectFork(url);
        forked = true;

        sink = new ProtocolFeeSink(WETH, SAFE, ASSET_REGISTRY);
        MockRamsesVoter voter = new MockRamsesVoter(); // stub -- no real Voter published for Robinhood yet
        locker = new RamsesLocker(POSITION_MANAGER, address(voter));
        factory = new BallastFeeSplitterFactory(address(sink));
        launcher = new RamsesLockLauncher(POSITION_MANAGER, address(locker), address(factory));
        swapper = new ForkSwapper();

        launchedToken = new MockERC20("ForkLaunch", "FORK", 18);
        assertFalse(_isAllowed(address(launchedToken)), "test token must not be AssetRegistry-listed");

        (address tokenA, address tokenB) =
            WETH < address(launchedToken) ? (WETH, address(launchedToken)) : (address(launchedToken), WETH);
        pool = IRamsesV3FactoryCreate(RAMSES_V3_FACTORY).createPool(tokenA, tokenB, TICK_SPACING, SQRT_PRICE_1_1);

        vm.deal(address(this), 100 ether);
        IWETH9d(WETH).deposit{value: 10 ether}();
        launchedToken.mint(address(this), 10 ether);
    }

    function _isAllowed(address asset) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            ASSET_REGISTRY.staticcall(abi.encodeWithSignature("isAllowed(address)", asset));
        return ok && abi.decode(ret, (bool));
    }

    /// @notice mint (two-sided, simplest to get fees flowing both ways) -> lock
    ///         -> swap both directions -> collect -> distribute -> flush both
    ///         tokens at the sink. WETH must land at the Safe; the launched
    ///         token must land at the dead address. Nothing in between.
    function test_fork_fullPath_quoteAssetToSafe_launchedTokenToDead() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        address token0 = IRamsesV3Pool(pool).token0();
        address token1 = IRamsesV3Pool(pool).token1();
        // This is a fork of real mainnet state -- 0x...dEaD may already hold
        // WETH from unrelated activity, so assert on the DELTA, not on zero.
        uint256 deadWethBefore = IERC20(WETH).balanceOf(DEAD);

        IERC20(token0).approve(address(launcher), 1 ether);
        IERC20(token1).approve(address(launcher), 1 ether);
        RamsesLockLauncher.MintLegs memory legs = RamsesLockLauncher.MintLegs({
            token0: token0,
            token1: token1,
            tickSpacing: TICK_SPACING,
            tickLower: -600,
            tickUpper: 600,
            amount0Desired: 1 ether,
            amount1Desired: 1 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 hours
        });
        (uint256 tokenId, address splitter) =
            launcher.createAndLock(legs, address(launchedToken), creator, 8000, 2000);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(tokenId), address(locker));

        // Swap WETH -> launched token.
        IERC20(WETH).approve(address(swapper), 2 ether);
        bool wethIsToken0 = token0 == WETH;
        swapper.swap(pool, wethIsToken0, 2 ether, wethIsToken0 ? 4295128740 : 1461446703485210103287273052203988822378723970341);

        // Swap launched token -> WETH, realizing fees on the other leg too.
        uint256 launchedBal = launchedToken.balanceOf(address(this));
        require(launchedBal > 0, "first swap produced no launched token to swap back");
        launchedToken.approve(address(swapper), launchedBal);
        swapper.swap(pool, !wethIsToken0, int256(launchedBal / 2), !wethIsToken0 ? 4295128740 : 1461446703485210103287273052203988822378723970341);

        vm.prank(makeAddr("stranger"));
        (uint256 c0, uint256 c1) = locker.collect(tokenId);
        assertTrue(c0 > 0 && c1 > 0, "expected fees accrued on BOTH legs");

        BallastFeeSplitter(splitter).distribute(token0);
        BallastFeeSplitter(splitter).distribute(token1);

        uint256 sinkWeth = IERC20(WETH).balanceOf(address(sink));
        uint256 sinkLaunched = launchedToken.balanceOf(address(sink));
        assertTrue(sinkWeth > 0, "sink should hold the protocol's WETH share");
        assertTrue(sinkLaunched > 0, "sink should hold the protocol's launched-token share");
        // Real mainnet Safe -- snapshot before flushing, assert the DELTA.
        uint256 safeWethBefore = IERC20(WETH).balanceOf(SAFE);

        sink.flush(WETH);
        sink.flush(address(launchedToken));

        assertEq(IERC20(WETH).balanceOf(SAFE), safeWethBefore + sinkWeth, "WETH must land at the Safe, exactly");
        assertEq(launchedToken.balanceOf(DEAD), sinkLaunched, "launched token must be burned");
        assertEq(IERC20(WETH).balanceOf(address(sink)), 0);
        assertEq(launchedToken.balanceOf(address(sink)), 0);
        assertEq(launchedToken.balanceOf(SAFE), 0, "launched token must NEVER reach the Safe");
        assertEq(IERC20(WETH).balanceOf(DEAD), deadWethBefore, "WETH must NEVER be burned");
    }
}
