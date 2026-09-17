// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {MockBallastToken} from "./mocks/MockBallastToken.sol";

interface IWETH9b {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Slice 3 fork test: one-sided seed needs NO creator WETH, creates real
///      liquidity, price rises on buys, and there is NO liquidity below P0 (the
///      structural "not a floor" fact). Skips offline.
contract BallastSeederForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    FeeConfig cfg;
    BallastHook hook;
    BallastSeeder seeder;
    PoolSwapTest swap;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        cfg = new FeeConfig(address(this), makeAddr("platform"));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == hookAddr, "hook");
        seeder = new BallastSeeder(MANAGER, WETH, address(hook));
        hook.setSeeder(address(seeder));
        swap = new PoolSwapTest(MANAGER);
        vm.deal(address(this), 1000 ether);
        IWETH9b(WETH).deposit{value: 500 ether}();
    }

    function _tokenBelowWeth() internal returns (MockBallastToken t) {
        bytes memory code = abi.encodePacked(type(MockBallastToken).creationCode, abi.encode(makeAddr("creator")));
        bytes32 h = keccak256(code);
        for (uint256 s = 1; s < 200000; s++) {
            if (vm.computeCreate2Address(bytes32(s), h, address(this)) < WETH) {
                return new MockBallastToken{salt: bytes32(s)}(makeAddr("creator"));
            }
        }
        revert("no side");
    }

    /// @dev The mirror of _tokenBelowWeth — a token address landing ABOVE weth,
    ///      exactly the ordering CREATE2 mining no longer prevents in production
    ///      (see BallastFactory's dropped `_mineCurrency0Salt`). Proves Seeder's
    ///      currency1 branch on a real fork, not just in isolation.
    function _tokenAboveWeth() internal returns (MockBallastToken t) {
        bytes memory code = abi.encodePacked(type(MockBallastToken).creationCode, abi.encode(makeAddr("creator")));
        bytes32 h = keccak256(code);
        for (uint256 s = 1; s < 200000; s++) {
            if (vm.computeCreate2Address(bytes32(s), h, address(this)) > WETH) {
                return new MockBallastToken{salt: bytes32(s)}(makeAddr("creator"));
            }
        }
        revert("no side");
    }

    function test_oneSidedSeed_noWethNeeded_andHasLiquidity() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken t = _tokenBelowWeth();
        t.transfer(address(seeder), t.balanceOf(address(this))); // seeder holds all token

        uint256 seederWethBefore = IERC20(WETH).balanceOf(address(seeder));
        PoolKey memory key = seeder.seed(address(t), 0); // P0 at tick 0 (1:1)
        uint256 seederWethAfter = IERC20(WETH).balanceOf(address(seeder));

        // No WETH was ever required from the seeder/creator (strictly one-sided).
        assertEq(seederWethBefore, 0);
        assertEq(seederWethAfter, 0, "seed must not consume WETH");
        assertEq(t.balanceOf(address(seeder)), 0, "all token seeded");

        uint128 liq = MANAGER.getLiquidity(key.toId());
        assertGt(liq, 0, "pool has liquidity");
        console2.log("seeded liquidity:", liq);

        // A buy (WETH in) succeeds and pushes the price up.
        IERC20(WETH).approve(address(swap), type(uint256).max);
        uint256 tokBefore = t.balanceOf(address(this));
        (uint160 spBefore,,,) = MANAGER.getSlot0(key.toId());
        // Buy = WETH(c1) -> token(c0) = zeroForOne FALSE, price rises.
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(t.balanceOf(address(this)) - tokBefore, 0, "buy returns token");
        (uint160 spAfter,,,) = MANAGER.getSlot0(key.toId());
        assertGt(spAfter, spBefore, "price moved up (WETH/token rose)");
    }

    function test_noLiquidityBelowP0() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken t = _tokenBelowWeth();
        t.transfer(address(seeder), t.balanceOf(address(this)));
        PoolKey memory key = seeder.seed(address(t), 0); // P0 at tick 0

        // Try to SELL token for WETH (pushes price below P0/tick 0). There is no
        // liquidity below P0, so the swap can move essentially nothing.
        t.approve(address(swap), type(uint256).max);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        // Sell = token(c0) -> WETH(c1) = zeroForOne TRUE, price falls below P0.
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 got = IERC20(WETH).balanceOf(address(this)) - wethBefore;
        console2.log("WETH out selling below P0:", got);
        assertEq(got, 0, "there must be no protocol liquidity below backing");
    }

    /// @dev Mirror of test_oneSidedSeed_noWethNeeded_andHasLiquidity for a token
    ///      that sorts as currency1 (token > weth). Real price = weth/token is
    ///      the INVERSE of the raw currency1/currency0 ratio here, so a buy
    ///      moves the raw sqrtPrice DOWN even though the real price rises —
    ///      see BallastSeeder's currency1 branch and BackingMath's inversion.
    function test_oneSidedSeed_currency1_noWethNeeded_andHasLiquidity() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken t = _tokenAboveWeth();
        assertGt(uint160(address(t)), uint160(WETH), "token must sort as currency1 for this test");
        t.transfer(address(seeder), t.balanceOf(address(this)));

        uint256 seederWethBefore = IERC20(WETH).balanceOf(address(seeder));
        PoolKey memory key = seeder.seed(address(t), 0); // P0 at tick 0 (1:1)
        uint256 seederWethAfter = IERC20(WETH).balanceOf(address(seeder));

        assertEq(seederWethBefore, 0);
        assertEq(seederWethAfter, 0, "seed must not consume WETH");
        // The full token balance being consumed as settlement IS the proof the
        // position was created with real, nonzero liquidity — modifyLiquidity
        // with a zero delta would settle 0 and leave this balance untouched.
        assertEq(t.balanceOf(address(seeder)), 0, "all token seeded");

        // NOT checked here: MANAGER.getLiquidity(key.toId()) (liquidity ACTIVE
        // at the exact current tick). Uniswap's tick-range convention is
        // half-open [tickLower, tickUpper) — inclusive lower, exclusive upper.
        // The currency0 seeding puts the coincident boundary at tickLower
        // (inclusive, so it reads active immediately); this currency1 mirror's
        // one-sided-below-backing range necessarily puts the coincident
        // boundary at tickUpper (exclusive), so it reads 0 at rest even though
        // the position genuinely holds the full token balance as committed
        // liquidity — an accounting artifact of which side of the boundary the
        // ordering lands on, not a functional gap. The very next tick crossing
        // (any buy) activates it, proven directly below by the swap actually
        // returning token.
        // Buy = WETH(c0) -> token(c1) = zeroForOne TRUE here (currencies flipped
        // vs the currency0 case), real price still rises, but the raw sqrtPrice
        // FALLS (currency1/currency0 = token/weth, inverse of real price).
        IERC20(WETH).approve(address(swap), type(uint256).max);
        uint256 tokBefore = t.balanceOf(address(this));
        (uint160 spBefore,,,) = MANAGER.getSlot0(key.toId());
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(t.balanceOf(address(this)) - tokBefore, 0, "buy returns token");
        (uint160 spAfter,,,) = MANAGER.getSlot0(key.toId());
        assertLt(spAfter, spBefore, "raw sqrtPrice fell (real price WETH/token rose)");
        // Now that the tick has crossed into the position's range, it reads
        // active — confirming the "0 at rest" reading above really was just
        // the boundary artifact, not a sign the position never existed.
        assertGt(MANAGER.getLiquidity(key.toId()), 0, "position active after crossing into range");
    }

    /// @dev Mirror of test_noLiquidityBelowP0 for a currency1 token: selling
    ///      pushes the RAW tick up past `openTick`, which is empty territory
    ///      here (the seeded range sits BELOW openTick for a currency1 token),
    ///      so it must return ~0 — same "not a floor" fact, mirrored ordering.
    function test_noLiquidityBelowP0_currency1() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken t = _tokenAboveWeth();
        t.transfer(address(seeder), t.balanceOf(address(this)));
        PoolKey memory key = seeder.seed(address(t), 0);

        // Sell = token(c1) -> WETH(c0) = zeroForOne FALSE here, pushes the raw
        // tick above `openTick` (0), past the seeded range's upper bound.
        t.approve(address(swap), type(uint256).max);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -1e18, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 got = IERC20(WETH).balanceOf(address(this)) - wethBefore;
        console2.log("WETH out selling below P0 (currency1 token):", got);
        assertEq(got, 0, "there must be no protocol liquidity below backing");
    }
}
