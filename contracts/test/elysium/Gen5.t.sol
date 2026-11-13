// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {BallastHookV5, BALLAST_HOOK_V5_FLAGS} from "../../src/elysium/BallastHookV5.sol";
import {BallastSeederV5} from "../../src/elysium/BallastSeederV5.sol";
import {BallastFactoryV5} from "../../src/elysium/BallastFactoryV5.sol";
import {FeeRouterV5} from "../../src/elysium/FeeRouterV5.sol";
import {ProtocolFeeVault} from "../../src/elysium/ProtocolFeeVault.sol";

// --- local views of the 0.8.26 v4 test helpers (deployed via deployCode) ---------
interface ISwapRouter {
    struct TestSettings {
        bool takeClaims;
        bool settleUsingBurn;
    }

    function swap(
        PoolKey memory key,
        IPoolManager.SwapParams memory params,
        TestSettings memory testSettings,
        bytes memory hookData
    ) external payable returns (BalanceDelta);
}

interface ILPRouter {
    function modifyLiquidity(PoolKey memory key, IPoolManager.ModifyLiquidityParams memory params, bytes memory hookData)
        external
        payable
        returns (BalanceDelta);
}

/// A mintable ERC20 that answers `creator()` — so the hook treats it as the Ballast
/// token side of a controlled test pool, without a full launch.
contract MockCreatorToken is ERC20 {
    address public creator;

    constructor() ERC20("Mock Creator Token", "mCRT") {
        creator = address(0xC0FFEE);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract Gen5Test is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int24 constant SPACING = 60;
    uint16 constant PROTOCOL_FEE_BPS = 2000;
    uint16 constant MIN_FEE = 100;
    uint16 constant MAX_FEE = 1000;
    int24 constant OPENING_TICK = -174300;
    address constant BURN_DEST = address(0xBEEF);

    IPoolManager manager;
    ISwapRouter swapRouter;
    ILPRouter lpRouter;
    BallastHookV5 hook;
    ProtocolFeeVault vault;
    BallastSeederV5 seeder;
    BallastFactoryV5 factory;
    TestERC20 whype;

    address creatorEOA = makeAddr("creatorEOA");
    address trader = makeAddr("trader");

    function setUp() public {
        // Fork rehearsal hook: when ELYSIUM_FORK_RPC is set, run the WHOLE suite against a
        // live-forked PoolManager (e.g. Elysium mainnet 99901's real v4) instead of a fresh
        // self-deploy. ELYSIUM_FORK_POOLMANAGER names the live manager address. Offline/CI
        // (env unset) keeps the original self-deploy so `forge test` stays green with no network.
        string memory forkRpc = vm.envOr("ELYSIUM_FORK_RPC", string(""));
        if (bytes(forkRpc).length > 0) {
            vm.createSelectFork(forkRpc);
            manager = IPoolManager(vm.envAddress("ELYSIUM_FORK_POOLMANAGER"));
            require(address(manager).code.length > 0, "forked poolManager has no code");
        } else {
            manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        }
        swapRouter = ISwapRouter(deployCode("PoolSwapTest.sol:PoolSwapTest", abi.encode(address(manager))));
        lpRouter = ILPRouter(deployCode("PoolModifyLiquidityTest.sol:PoolModifyLiquidityTest", abi.encode(address(manager))));

        whype = new TestERC20("Wrapped HYPE", "WHYPE");

        // Mine + deploy the hook at a flag-valid address (CREATE2 via address(this)).
        bytes memory args = abi.encode(manager, PROTOCOL_FEE_BPS, MIN_FEE, MAX_FEE);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), uint160(BALLAST_HOOK_V5_FLAGS), type(BallastHookV5).creationCode, args);
        hook = new BallastHookV5{salt: salt}(manager, PROTOCOL_FEE_BPS, MIN_FEE, MAX_FEE);
        require(address(hook) == hookAddr, "hook addr mismatch");

        vault = new ProtocolFeeVault(address(hook), BURN_DEST);
        hook.setProtocolVault(address(vault));

        seeder = new BallastSeederV5(manager, address(hook));
        hook.setSeeder(address(seeder));

        factory = new BallastFactoryV5(
            address(hook),
            seeder,
            address(whype),
            address(manager),
            OPENING_TICK,
            MIN_FEE,
            MAX_FEE,
            false,
            2000,
            type(uint256).max,
            1 hours,
            address(this)
        );
    }

    // ===================================================================== //
    //  Fee range + immutability                                             //
    // ===================================================================== //
    function test_Launch_RevertsFeeTooLow() public {
        vm.expectRevert(BallastFactoryV5.FeeOutOfRange.selector);
        factory.launch("T", "T", 99, "ipfs://x", address(whype), 10000, 0, 0);
    }

    function test_Launch_RevertsFeeTooHigh() public {
        vm.expectRevert(BallastFactoryV5.FeeOutOfRange.selector);
        factory.launch("T", "T", 1001, "ipfs://x", address(whype), 10000, 0, 0);
    }

    function test_Launch_AcceptsBoundaryFees() public {
        (,, address r1) = factory.launch("A", "A", 100, "ipfs://x", address(whype), 10000, 0, 0);
        (,, address r2) = factory.launch("B", "B", 1000, "ipfs://x", address(whype), 10000, 0, 0);
        assertTrue(r1 != address(0) && r2 != address(0));
    }

    function test_InitPool_OnlySeeder() public {
        PoolKey memory key = _controlledPoolKey();
        vm.expectRevert(BallastHookV5.NotSeeder.selector);
        hook.initPool(key, 300);
    }

    function test_InitPool_RejectsOutOfRange() public {
        PoolKey memory key = _controlledPoolKey();
        vm.startPrank(address(seeder));
        vm.expectRevert(BallastHookV5.FeeOutOfRange.selector);
        hook.initPool(key, 99);
        vm.expectRevert(BallastHookV5.FeeOutOfRange.selector);
        hook.initPool(key, 1001);
        vm.stopPrank();
    }

    function test_InitPool_WriteOnce() public {
        PoolKey memory key = _controlledPoolKey();
        vm.startPrank(address(seeder));
        hook.initPool(key, 300);
        vm.expectRevert(BallastHookV5.AlreadySet.selector);
        hook.initPool(key, 400);
        vm.stopPrank();
        assertEq(hook.poolFeeBps(PoolId.unwrap(key.toId())), 300);
    }

    // ===================================================================== //
    //  Launch + graduate: fee split 80/20, LP lock                          //
    // ===================================================================== //
    function test_LaunchGraduate_FeeSplit_8020() public {
        vm.prank(creatorEOA);
        (, address token, address router) = factory.launch("Proj", "PRJ", 500, "ipfs://x", address(whype), 10000, 0, 0);
        factory.graduate(token);

        // A buyer swaps WHYPE -> token. Fee is 5% of the WHYPE leg, split 80/20.
        uint256 spendWhype = 10 ether;
        _fundAndApproveSwap(trader, token, spendWhype);

        PoolKey memory key = _launchedKey(token);
        bool buyTokenZeroForOne = Currency.unwrap(key.currency0) == address(whype); // input = whype
        vm.prank(trader);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: buyTokenZeroForOne,
                amountSpecified: -int256(spendWhype),
                sqrtPriceLimitX96: buyTokenZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 expectedFee = (spendWhype * 500) / 10_000; // 5%
        uint256 expectedProtocol = (expectedFee * PROTOCOL_FEE_BPS) / 10_000; // 20%
        uint256 expectedCreator = expectedFee - expectedProtocol; // 80%

        assertEq(hook.owed(router, address(whype)), expectedCreator, "creator-side 80%");
        assertEq(hook.owed(address(vault), address(whype)), expectedProtocol, "protocol 20%");

        // Protocol vault can only move funds to the fixed destination.
        vault.sweep(address(whype));
        assertEq(IERC20(whype).balanceOf(BURN_DEST), expectedProtocol, "forwarded to burn dest");
        assertEq(hook.owed(address(vault), address(whype)), 0);
    }

    function test_LPLock_SeederBlocked() public {
        PoolKey memory key = _controlledPoolKey();
        IPoolManager.ModifyLiquidityParams memory p =
            IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -1, salt: 0});
        vm.prank(address(manager));
        vm.expectRevert(BallastHookV5.SeederLiquidityLocked.selector);
        hook.beforeRemoveLiquidity(address(seeder), key, p, "");

        // A non-seeder remover is allowed.
        vm.prank(address(manager));
        bytes4 sel = hook.beforeRemoveLiquidity(address(0xABCD), key, p, "");
        assertEq(sel, IHooks.beforeRemoveLiquidity.selector);
    }

    // ===================================================================== //
    //  Limit orders (controlled pool)                                       //
    // ===================================================================== //
    function test_LimitOrder_PlaceFillWithdraw() public {
        (PoolKey memory key, MockCreatorToken token) = _setupControlledPool(300);
        // current tick = 0. Place a currency0 order above price at tick +600.
        bool c0IsToken = Currency.unwrap(key.currency0) == address(token);
        int24 tickLower = 600;
        uint128 liq = 1e21;
        _fundForPlace(address(this), key, true, tickLower, liq);

        uint256 epoch = hook.place(key, tickLower, true, liq);
        assertGt(epoch, 0);

        // Push price UP past the order (zeroForOne=false swap).
        _swapPushUp(key, 100 ether);

        (bool filled,,,) = hook.epochInfo(epoch);
        assertTrue(filled, "order filled after price crossed");

        // Withdraw: a filled currency0 (zeroForOne=true) order pays out currency1.
        (uint256 a0, uint256 a1) = hook.withdraw(epoch, address(this));
        // output is the currency1 side
        if (c0IsToken) {
            assertGt(a1, 0, "received quote (currency1)");
        } else {
            assertGt(a1, 0, "received token (currency1)");
        }
        assertEq(a0, 0, "fully converted, no currency0 left");
    }

    function test_LimitOrder_CancelUnfilled() public {
        (PoolKey memory key, MockCreatorToken token) = _setupControlledPool(300);
        int24 tickLower = 600;
        uint128 liq = 1e21;
        bool c0IsToken = Currency.unwrap(key.currency0) == address(token);
        address inCur = c0IsToken ? address(token) : address(whype);
        _fundForPlace(address(this), key, true, tickLower, liq);
        uint256 balBefore = IERC20(inCur).balanceOf(address(this));

        hook.place(key, tickLower, true, liq);
        (uint256 a0, uint256 a1) = hook.cancel(key, tickLower, true, address(this));
        // got back ~all of the input currency (currency0)
        assertGt(a0, 0, "returned currency0");
        assertEq(a1, 0, "nothing in currency1");
        // balance roughly restored (minus rounding dust from liquidity math)
        assertApproxEqRel(IERC20(inCur).balanceOf(address(this)), balBefore, 1e15); // within 0.1%
    }

    function test_LimitOrder_MultipleSameTick_ProRata() public {
        (PoolKey memory key,) = _setupControlledPool(300);
        int24 tickLower = 600;
        uint128 liqA = 1e21;
        uint128 liqB = 3e21;
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");

        _fundForPlace(alice, key, true, tickLower, liqA);
        _fundForPlace(bob, key, true, tickLower, liqB);

        vm.prank(alice);
        uint256 e1 = hook.place(key, tickLower, true, liqA);
        vm.prank(bob);
        uint256 e2 = hook.place(key, tickLower, true, liqB);
        assertEq(e1, e2, "same tick/direction share one epoch");

        _swapPushUp(key, 100 ether);
        (bool filled,, uint256 t1Total,) = hook.epochInfo(e1);
        assertTrue(filled);

        vm.prank(alice);
        (, uint256 aliceOut) = hook.withdraw(e1, alice);
        vm.prank(bob);
        (, uint256 bobOut) = hook.withdraw(e1, bob);

        // Bob placed 3x Alice's liquidity -> ~3x the output.
        assertApproxEqRel(bobOut, aliceOut * 3, 1e15);
        assertApproxEqAbs(aliceOut + bobOut, t1Total, 2);
    }

    function test_LimitOrder_CrossManyOrders() public {
        (PoolKey memory key,) = _setupControlledPool(300);
        int24[] memory ticks = new int24[](4);
        ticks[0] = 120;
        ticks[1] = 300;
        ticks[2] = 600;
        ticks[3] = 1200;
        uint256[] memory epochs = new uint256[](4);
        for (uint256 i = 0; i < ticks.length; i++) {
            _fundForPlace(address(this), key, true, ticks[i], 1e21);
            epochs[i] = hook.place(key, ticks[i], true, 1e21);
        }

        // One big swap crosses all four ticks.
        _swapPushUp(key, 200 ether);

        for (uint256 i = 0; i < epochs.length; i++) {
            (bool filled,,,) = hook.epochInfo(epochs[i]);
            assertTrue(filled, "each crossed order filled");
        }
    }

    // ===================================================================== //
    //  FeeRouterV5 split timing (timestamp-only)                            //
    // ===================================================================== //
    function test_SplitChange_InstantWhenLoweringCreator() public {
        vm.prank(creatorEOA);
        (,, address router) = factory.launch("P", "P", 300, "ipfs://x", address(whype), 10000, 0, 0);
        FeeRouterV5 fr = FeeRouterV5(payable(router));
        // creator 100% -> 80% (lower own share, buyback up) applies instantly.
        vm.prank(creatorEOA);
        fr.scheduleSplit(8000, 2000, 0);
        assertEq(fr.creatorBps(), 8000);
        assertEq(fr.buybackBps(), 2000);
        assertFalse(fr.hasPendingSplit());
    }

    function test_SplitChange_DelayedWhenRaisingCreator() public {
        vm.prank(creatorEOA);
        (,, address router) = factory.launch("P", "P", 300, "ipfs://x", address(whype), 8000, 2000, 0);
        FeeRouterV5 fr = FeeRouterV5(payable(router));
        // raise creator share -> 7-day delay
        vm.prank(creatorEOA);
        fr.scheduleSplit(9000, 1000, 0);
        assertTrue(fr.hasPendingSplit());
        assertEq(fr.creatorBps(), 8000, "unchanged before delay");

        vm.warp(block.timestamp + 7 days - 1);
        fr.applySplit();
        assertEq(fr.creatorBps(), 8000, "still unchanged just before 7d");

        vm.warp(block.timestamp + 2);
        fr.applySplit();
        assertEq(fr.creatorBps(), 9000, "applied after 7d");
        assertFalse(fr.hasPendingSplit());
    }

    // ===================================================================== //
    //  Ownership transfer (mainnet -> Safe path)                            //
    // ===================================================================== //
    function test_Ownership_TwoStepTransfer() public {
        address safe = makeAddr("safe");
        factory.transferOwnership(safe);
        assertEq(factory.owner(), address(this), "not yet transferred");
        assertEq(factory.pendingOwner(), safe);

        vm.prank(safe);
        factory.acceptOwnership();
        assertEq(factory.owner(), safe);

        // old owner can no longer set green assets
        vm.expectRevert();
        factory.setGreenQuoteAsset(address(0x1234), true);

        vm.prank(safe);
        factory.setGreenQuoteAsset(address(0x1234), true);
        assertTrue(factory.isGreenQuoteAsset(address(0x1234)));
    }

    // ===================================================================== //
    //  More adversarial + integration                                       //
    // ===================================================================== //
    function test_SellExactOut_Reverts() public {
        (PoolKey memory key,) = _setupControlledPool(300);
        // Craft a swap whose OUTPUT is the quote (WHYPE) and is exact-out.
        bool whypeIsC1 = Currency.unwrap(key.currency1) == address(whype);
        bool zeroForOne = whypeIsC1; // output = currency1 = whype when zeroForOne
        _mintAny(Currency.unwrap(zeroForOne ? key.currency0 : key.currency1), address(this), 1e24);
        IERC20(Currency.unwrap(zeroForOne ? key.currency0 : key.currency1)).approve(address(swapRouter), type(uint256).max);
        vm.expectRevert(); // SellExactOutNotSupported (wrapped as HookCallFailed)
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(1e18), // exact-out
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_DoubleGraduate_Reverts() public {
        (, address token,) = factory.launch("P", "P", 300, "ipfs://x", address(whype), 10000, 0, 0);
        factory.graduate(token);
        vm.expectRevert(BallastFactoryV5.AlreadyGraduated.selector);
        factory.graduate(token);
    }

    function test_Graduate_SetsOpeningTick() public {
        (, address token,) = factory.launch("P", "P", 300, "ipfs://x", address(whype), 10000, 0, 0);
        factory.graduate(token);
        PoolKey memory key = _launchedKey(token);
        (, int24 tick,,) = manager.getSlot0(key.toId());
        int24 expected = token < address(whype) ? OPENING_TICK : -OPENING_TICK;
        assertEq(tick, expected, "pool opened at per-chain opening tick");
    }

    function test_Claim_NoDoublePay() public {
        (PoolKey memory key, MockCreatorToken token) = _setupControlledPool(300);
        // Accrue fees to token.creator() via a buy.
        _swapPushUp(key, 50 ether); // moves price, fee taken on quote leg
        address creatorOfRecord = token.creator();
        uint256 owedAmt = hook.owed(creatorOfRecord, address(whype));
        // creator() is 0xC0FFEE; impersonate it to claim.
        vm.prank(creatorOfRecord);
        uint256 got = hook.claim(address(whype));
        assertEq(got, owedAmt);
        assertGt(got, 0);
        // second claim pays nothing (CEI: owed already zeroed)
        vm.prank(creatorOfRecord);
        uint256 again = hook.claim(address(whype));
        assertEq(again, 0, "no double-pay");
    }

    function test_FeeRouter_RouteCreatorAndBuyback() public {
        vm.prank(creatorEOA);
        (, address token, address router) = factory.launch("P", "P", 500, "ipfs://x", address(whype), 8000, 2000, 0);
        factory.graduate(token);
        FeeRouterV5 fr = FeeRouterV5(payable(router));
        fr.wireBuybackPool();

        // Buyer accrues fees (80% to the router).
        uint256 spend = 20 ether;
        _fundAndApproveSwap(trader, token, spend);
        PoolKey memory key = _launchedKey(token);
        bool buyZ4O = Currency.unwrap(key.currency0) == address(whype);
        vm.prank(trader);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: buyZ4O,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: buyZ4O ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 owedToRouter = hook.owed(router, address(whype));
        assertGt(owedToRouter, 0, "router owed creator-side fees");

        fr.route(0, 0); // permissionless
        // creator got 80% of claimed in WHYPE
        assertApproxEqAbs(IERC20(whype).balanceOf(creatorEOA), (owedToRouter * 8000) / 10000, 2);
        // buyback burned token to DEAD
        assertGt(fr.totalTokenBurned(), 0, "buyback burned token");
        assertGt(IERC20(token).balanceOf(0x000000000000000000000000000000000000dEaD), 0);
    }

    // ===================================================================== //
    //  Helpers                                                              //
    // ===================================================================== //
    function _launchedKey(address token) internal view returns (PoolKey memory) {
        bool tokenIsC0 = token < address(whype);
        return PoolKey({
            currency0: Currency.wrap(tokenIsC0 ? token : address(whype)),
            currency1: Currency.wrap(tokenIsC0 ? address(whype) : token),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _controlledPoolKey() internal returns (PoolKey memory key) {
        MockCreatorToken token = new MockCreatorToken();
        bool c0IsToken = address(token) < address(whype);
        key = PoolKey({
            currency0: Currency.wrap(c0IsToken ? address(token) : address(whype)),
            currency1: Currency.wrap(c0IsToken ? address(whype) : address(token)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _setupControlledPool(uint16 feeBps) internal returns (PoolKey memory key, MockCreatorToken token) {
        token = new MockCreatorToken();
        bool c0IsToken = address(token) < address(whype);
        key = PoolKey({
            currency0: Currency.wrap(c0IsToken ? address(token) : address(whype)),
            currency1: Currency.wrap(c0IsToken ? address(whype) : address(token)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.prank(address(seeder));
        hook.initPool(key, feeBps);

        // two-sided liquidity around tick 0
        token.mint(address(this), 1e27);
        whype.mint(address(this), 1e27);
        token.approve(address(lpRouter), type(uint256).max);
        whype.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e21, salt: 0}),
            ""
        );
        // approvals for swapping + placing
        token.approve(address(swapRouter), type(uint256).max);
        whype.approve(address(swapRouter), type(uint256).max);
        token.approve(address(hook), type(uint256).max);
        whype.approve(address(hook), type(uint256).max);
    }

    function _fundForPlace(address who, PoolKey memory key, bool zeroForOne, int24, uint128) internal {
        // Fund `who` with enough of the input currency and approve the hook. Exact
        // amount is computed by the pool at place(); mint generously.
        address inCur = zeroForOne ? Currency.unwrap(key.currency0) : Currency.unwrap(key.currency1);
        _mintAny(inCur, who, 1e24);
        vm.prank(who);
        IERC20(inCur).approve(address(hook), type(uint256).max);
    }

    function _mintAny(address tokenAddr, address to, uint256 amount) internal {
        // Both MockCreatorToken and TestERC20 expose mint(address,uint256).
        (bool ok,) = tokenAddr.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        require(ok, "mint failed");
    }

    function _swapPushUp(PoolKey memory key, uint256 amountIn) internal {
        // zeroForOne=false pushes price up (buys currency0). Fund currency1 to the test.
        address inCur = Currency.unwrap(key.currency1);
        _mintAny(inCur, address(this), amountIn);
        IERC20(inCur).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ISwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _fundAndApproveSwap(address who, address token, uint256 whypeAmount) internal {
        whype.mint(who, whypeAmount);
        vm.startPrank(who);
        whype.approve(address(swapRouter), type(uint256).max);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }
}
