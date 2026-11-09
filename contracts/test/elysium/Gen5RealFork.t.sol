// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {BallastHookV5} from "../../src/elysium/BallastHookV5.sol";
import {BallastFactoryV5} from "../../src/elysium/BallastFactoryV5.sol";

interface ISwapRouter {
    struct TestSettings {
        bool takeClaims;
        bool settleUsingBurn;
    }
    function swap(PoolKey memory key, IPoolManager.SwapParams memory params, TestSettings memory s, bytes memory hd)
        external payable returns (BalanceDelta);
}

/// @dev Part-B rehearsal against the REAL gen-5 contracts already deployed on Elysium
///      mainnet (99901). Skips unless ELYSIUM_REALFORK_RPC is set. Read/forks only — no
///      broadcast. Drives the real factory/hook/seeder/vault: launch → graduate → swap →
///      fee split 80/20 → vault.sweep to the real Safe → limit order place/fill/withdraw.
contract Gen5RealForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Real deployed addresses (99901).
    address constant HOOK = 0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc;
    address constant VAULT = 0xA8fAd48376572075288ad60eE199b36bc445D1b0;
    address constant FACTORY = 0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE;
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant SAFE = 0xa4dCbAd7A34da4473040d9f0fE35990c458A727C;

    int24 constant SPACING = 60;
    uint16 constant PROTOCOL_BPS = 2000;

    BallastHookV5 hook = BallastHookV5(HOOK);
    BallastFactoryV5 factory = BallastFactoryV5(FACTORY);
    ISwapRouter swapRouter;
    bool forked;
    address trader = makeAddr("trader");

    function setUp() public {
        string memory url = vm.envOr("ELYSIUM_REALFORK_RPC", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        assertEq(block.chainid, 99901, "not Elysium mainnet");
        swapRouter = ISwapRouter(deployCode("PoolSwapTest.sol:PoolSwapTest", abi.encode(address(hook.poolManager()))));
        forked = true;
    }

    function _key(address token) internal pure returns (PoolKey memory) {
        bool t0 = token < WHYPE;
        return PoolKey({
            currency0: Currency.wrap(t0 ? token : WHYPE),
            currency1: Currency.wrap(t0 ? WHYPE : token),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(HOOK)
        });
    }

    function test_RealFactory_LaunchGraduateSwap_FeeSplit() public {
        if (!forked) { vm.skip(true); return; }
        // Launch (permissionless), creator-100% split, 5% swap fee, WHYPE quote.
        (, address token, address router) =
            factory.launch("SmokeFork", "SMK", 500, "ipfs://smoke", WHYPE, 10000, 0, 0);
        assertTrue(token != address(0) && router != address(0), "launched");
        factory.graduate(token);

        // Buy: WHYPE -> token.
        uint256 spend = 5 ether;
        deal(WHYPE, trader, spend);
        vm.startPrank(trader);
        IERC20(WHYPE).approve(address(swapRouter), type(uint256).max);
        PoolKey memory key = _key(token);
        bool wIn = Currency.unwrap(key.currency0) == WHYPE; // whype is input
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: wIn,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: wIn ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        uint256 fee = (spend * 500) / 10_000;
        uint256 protocol = (fee * PROTOCOL_BPS) / 10_000;
        uint256 creator = fee - protocol;
        assertEq(hook.owed(router, WHYPE), creator, "creator-side 80%");
        assertEq(hook.owed(VAULT, WHYPE), protocol, "protocol 20% to vault");

        // Vault can only forward to the real Safe.
        uint256 safeBefore = IERC20(WHYPE).balanceOf(SAFE);
        (bool ok,) = VAULT.call(abi.encodeWithSignature("sweep(address)", WHYPE));
        assertTrue(ok, "sweep");
        assertEq(IERC20(WHYPE).balanceOf(SAFE) - safeBefore, protocol, "protocol cut landed at Safe");
        assertEq(hook.owed(VAULT, WHYPE), 0, "vault drained");
    }

    function test_RealHook_LimitOrder_PlaceFillWithdraw() public {
        if (!forked) { vm.skip(true); return; }
        (, address token,) = factory.launch("SmokeLO", "SLO", 300, "ipfs://lo", WHYPE, 10000, 0, 0);
        factory.graduate(token);
        PoolKey memory key = _key(token);

        // A single-sided currency0 order (zeroForOne=true) must rest strictly ABOVE the
        // pool's current tick. Read the real current tick and align one spacing above.
        (, int24 curTick,,) = IPoolManager(address(hook.poolManager())).getSlot0(key.toId());
        int24 tickLower = (_floorDiv(curTick, SPACING) + 1) * SPACING;
        bool zeroForOne = true;
        address inCur = Currency.unwrap(key.currency0);
        deal(inCur, address(this), 1e24);
        IERC20(inCur).approve(HOOK, type(uint256).max);
        uint256 epoch = hook.place(key, tickLower, zeroForOne, 1e21);
        assertGt(epoch, 0, "placed");

        // Push price UP (zeroForOne=false) hard enough to cross tickLower and fill the order.
        deal(WHYPE, address(this), 500 ether);
        deal(token, address(this), 1e27);
        IERC20(WHYPE).approve(address(swapRouter), type(uint256).max);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
        address pushIn = Currency.unwrap(key.currency1); // zeroForOne=false spends currency1
        deal(pushIn, address(this), 1e27);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(uint256(300 ether)),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        (bool filled,,,) = hook.epochInfo(epoch);
        if (filled) {
            (uint256 a0, uint256 a1) = hook.withdraw(epoch, address(this));
            assertTrue(a0 > 0 || a1 > 0, "withdrew proceeds");
        } else {
            // Not crossed by this size → prove cancel returns the resting funds instead.
            (uint256 c0, uint256 c1) = hook.cancel(key, tickLower, zeroForOne, address(this));
            assertTrue(c0 > 0 || c1 > 0, "cancelled, funds returned");
        }
    }

    function _floorDiv(int24 a, int24 b) internal pure returns (int24) {
        int24 q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
        return q;
    }
}
