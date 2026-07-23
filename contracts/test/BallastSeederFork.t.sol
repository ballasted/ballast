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

import {BallastHook} from "../src/BallastHook.sol";
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
        uint160 flags = uint160((1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == hookAddr, "hook");
        seeder = new BallastSeeder(MANAGER, WETH, address(hook));
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
}
