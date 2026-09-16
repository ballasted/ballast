// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastHook} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {MockBallastToken} from "./mocks/MockBallastToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface IWETH9 {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Slice 1b: fork-verify the hook's WETH-leg fee across all four cases and
///      both currency orderings. Asserts BOTH the hook's take AND the swapper's
///      side (so a fee sourced from the locked LP instead of the trader is caught),
///      plus WETH conservation. Skips offline.
contract BallastHookForkTest is Test {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint24 constant FEE = 0; // LP fee 0 — isolate the hook's 1%
    int24 constant TS = 60;

    FeeConfig cfg;
    BallastHook hook;
    PoolModifyLiquidityTest lp;
    PoolSwapTest swap;
    address platform = makeAddr("platform");
    address creator = makeAddr("creator");

    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        cfg = new FeeConfig(address(this), platform);
        lp = new PoolModifyLiquidityTest(MANAGER);
        swap = new PoolSwapTest(MANAGER);

        // Mine + deploy the hook at an address carrying exactly FLAGS.
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), hook_flags(), type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == hookAddr, "hook addr mismatch");

        // Fund WETH.
        vm.deal(address(this), 1000 ether);
        IWETH9(WETH).deposit{value: 500 ether}();
    }

    function hook_flags() internal pure returns (uint160) {
        // BEFORE_SWAP(1<<7) | BEFORE_SWAP_RETURNS_DELTA(1<<3) | AFTER_SWAP(1<<6) | AFTER_SWAP_RETURNS_DELTA(1<<2)
        return uint160((1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
    }

    function _deployTokenOnSide(bool belowWeth) internal returns (MockBallastToken t) {
        bytes memory code = abi.encodePacked(type(MockBallastToken).creationCode, abi.encode(creator));
        bytes32 initHash = keccak256(code);
        for (uint256 s = 1; s < 200000; s++) {
            address a = vm.computeCreate2Address(bytes32(s), initHash, address(this));
            if ((a < WETH) == belowWeth) {
                t = new MockBallastToken{salt: bytes32(s)}(creator);
                require(address(t) == a, "t addr");
                return t;
            }
        }
        revert("no token side found");
    }

    // Build + deep-seed a token/WETH pool. Returns key + wethIsC0.
    function _pool(MockBallastToken t) internal returns (PoolKey memory key, bool wethIsC0) {
        wethIsC0 = WETH < address(t);
        Currency c0 = Currency.wrap(wethIsC0 ? WETH : address(t));
        Currency c1 = Currency.wrap(wethIsC0 ? address(t) : WETH);
        key = PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: TS, hooks: IHooks(address(hook))});
        MANAGER.initialize(key, uint160(79228162514264337593543950336)); // 1:1

        t.mint(address(this), 1e27);
        IERC20(WETH).approve(address(lp), type(uint256).max);
        t.approve(address(lp), type(uint256).max);
        IERC20(WETH).approve(address(swap), type(uint256).max);
        t.approve(address(swap), type(uint256).max);

        // Bounded range around 1:1 (ticks multiple of 60). Deep enough for tiny
        // swaps; amounts stay within funded balances (~80 WETH / ~45e18 token).
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}),
            ""
        );
    }

    struct Bal {
        uint256 sw;
        uint256 sh;
        uint256 mgr;
    }

    function _weth() internal view returns (Bal memory b) {
        b.sw = IERC20(WETH).balanceOf(address(this));
        b.sh = IERC20(WETH).balanceOf(address(hook));
        b.mgr = IERC20(WETH).balanceOf(address(MANAGER));
    }

    // Run one case and assert. Split across helpers to keep the stack shallow.
    function _case(string memory label, PoolKey memory key, bool wethIsC0, bool wethIn, bool exactIn, uint256 amt)
        internal
    {
        bool zeroForOne = wethIn ? wethIsC0 : !wethIsC0;
        Bal memory a = _weth();
        uint256 tokBefore = MockBallastToken(_token(key)).balanceOf(address(this));
        _doSwap(key, zeroForOne, exactIn ? -int256(amt) : int256(amt));
        int256 tokDelta = int256(MockBallastToken(_token(key)).balanceOf(address(this))) - int256(tokBefore);
        _report(label, a, _weth(), tokDelta, wethIn, exactIn, amt);
    }

    function _doSwap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) internal {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _report(
        string memory label,
        Bal memory a,
        Bal memory b,
        int256 tokDelta,
        bool wethIn,
        bool exactIn,
        uint256 amt
    ) internal {
        int256 dSw = int256(b.sw) - int256(a.sw);
        int256 dMgr = int256(b.mgr) - int256(a.mgr);
        uint256 fee = b.sh - a.sh;

        console2.log(label);
        console2.log("  fee(WETH):", fee);
        console2.log("  swapper dWETH:", vm.toString(dSw));
        console2.log("  swapper dToken:", vm.toString(tokDelta));

        // 1) WETH conserved across swapper / hook / manager.
        assertEq(dSw + int256(fee) + dMgr, 0, string.concat(label, ": WETH not conserved"));
        assertGt(fee, 0, string.concat(label, ": zero fee"));

        // 2) Swapper's SPECIFIED side is exactly what they asked — proves the fee
        //    lands on the WETH leg and comes from the trader, not the LP.
        if (exactIn) {
            if (wethIn) assertEq(dSw, -int256(amt), string.concat(label, ": WETH debit != specified"));
            else assertEq(tokDelta, -int256(amt), string.concat(label, ": token sold != specified"));
        } else {
            if (wethIn) assertEq(tokDelta, int256(amt), string.concat(label, ": token recv != specified"));
            else assertEq(dSw, int256(amt), string.concat(label, ": WETH recv != specified"));
        }

        // 3) fee == 1% of the WETH leg.
        bool wethSpecified = (wethIn == exactIn);
        if (wethSpecified) {
            assertEq(fee, amt / 100, string.concat(label, ": fee != 1% of specified WETH leg"));
        } else {
            // gross pool-side WETH: buy(input)=|dSw|-fee, sell(output)=dSw+fee
            uint256 gross = wethIn ? uint256(-dSw) - fee : uint256(dSw) + fee;
            assertApproxEqRel(fee, gross / 100, 0.005e18, string.concat(label, ": fee != ~1% of actual WETH leg"));
        }
    }

    function _token(PoolKey memory key) internal view returns (address) {
        return Currency.unwrap(key.currency0) == WETH ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
    }

    /// @dev Partial fill at the top of the range (the ceiling — exactly what slice 3
    ///      will hit). Buy exact-out requesting MORE token than the range holds fills
    ///      partially; WETH is the UNSPECIFIED currency, so afterSwap charges the fee
    ///      on the ACTUAL filled WETH, not the requested amount.
    function test_partialFill_buyExactOut_chargesOnActual() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken t = _deployTokenOnSide(false); // token > WETH (currency1)
        (PoolKey memory key, bool wethIsC0) = _pool(t);

        uint256 requested = 1e30; // far more token than the range holds -> partial at ceiling
        bool zeroForOne = wethIsC0; // buy: WETH in
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;

        Bal memory a = _weth();
        uint256 tokBefore = t.balanceOf(address(this));
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: int256(requested), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        Bal memory b = _weth();
        uint256 fee = b.sh - a.sh;
        uint256 paid = uint256(int256(a.sw) - int256(b.sw)); // WETH paid by swapper
        uint256 gotTok = t.balanceOf(address(this)) - tokBefore;

        console2.log("partial buy exact-out (ceiling):");
        console2.log("  requested token:", requested);
        console2.log("  got token:      ", gotTok);
        console2.log("  WETH paid:      ", paid);
        console2.log("  fee:            ", fee);

        assertLt(gotTok, requested, "expected partial fill at ceiling");
        // fee == 1% of the ACTUAL WETH leg (gross into pool = paid - fee), NOT of the
        // requested token. This is the correct partial-fill behaviour.
        assertApproxEqRel(fee, (paid - fee) / 100, 0.01e18, "fee must be 1% of actual filled WETH");
    }

    function test_fourCases_bothOrderings() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        for (uint256 side = 0; side < 2; side++) {
            MockBallastToken t = _deployTokenOnSide(side == 0); // 0: token<WETH (c0), 1: token>WETH (c1)
            (PoolKey memory key, bool wethIsC0) = _pool(t);
            string memory ord = wethIsC0 ? "[WETH=c0] " : "[WETH=c1] ";
            // 3 supported cases assert the fee; the 4th (sell exact-out) asserts it
            // reverts. 4 cases x 2 orderings = 8 combos.
            _case(string.concat(ord, "buy exact-in"), key, wethIsC0, true, true, 0.01 ether);
            _case(string.concat(ord, "buy exact-out"), key, wethIsC0, true, false, 1e18);
            _case(string.concat(ord, "sell exact-in"), key, wethIsC0, false, true, 1e18);
            _expectSellExactOutReverts(string.concat(ord, "sell exact-out"), key, wethIsC0);
        }
    }

    /// Sell exact-out (WETH specified as output) must revert with the named error.
    /// v4 WRAPS hook reverts (CustomRevert.WrappedError), so we assert the wrapped
    /// revert data embeds the SellExactOutNotSupported selector rather than matching
    /// a bare selector.
    function _expectSellExactOutReverts(string memory label, PoolKey memory key, bool wethIsC0) internal {
        bool zeroForOne = !wethIsC0; // sell: WETH out
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        bytes memory cd = abi.encodeCall(
            PoolSwapTest.swap,
            (
                key,
                IPoolManager.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: int256(0.01 ether),
                    sqrtPriceLimitX96: limit
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                bytes("")
            )
        );
        (bool ok, bytes memory ret) = address(swap).call(cd);
        assertFalse(ok, string.concat(label, ": expected revert"));
        assertTrue(
            _hasSelector(ret, BallastHook.SellExactOutNotSupported.selector),
            string.concat(label, ": wrong revert error")
        );
        console2.log(label, "reverted SellExactOutNotSupported (as designed)");
    }

    function _hasSelector(bytes memory data, bytes4 sel) internal pure returns (bool) {
        if (data.length < 4) return false;
        for (uint256 i = 0; i + 4 <= data.length; i++) {
            bytes4 chunk;
            assembly {
                chunk := mload(add(add(data, 0x20), i))
            }
            if (chunk == sel) return true;
        }
        return false;
    }

    // --------------------------------------------------------------------- //
    //  Step (e): per-pool quote-asset concept + per-currency fee ledger     //
    // --------------------------------------------------------------------- //

    function _mineTokenAgainst(address other, bool below) internal returns (MockBallastToken t) {
        bytes memory code = abi.encodePacked(type(MockBallastToken).creationCode, abi.encode(creator));
        bytes32 initHash = keccak256(code);
        for (uint256 s = 1; s < 200000; s++) {
            address a = vm.computeCreate2Address(bytes32(s), initHash, address(this));
            if ((a < other) == below) {
                t = new MockBallastToken{salt: bytes32(s)}(creator);
                require(address(t) == a, "t addr");
                return t;
            }
        }
        revert("no side");
    }

    /// @dev Same shape as _pool(), but against an arbitrary (non-WETH) quote asset —
    ///      proves the hook's fee-leg detection is genuinely per-pool, not WETH-only.
    function _genericPool(MockERC20 quote, MockBallastToken t) internal returns (PoolKey memory key, bool quoteIsC0) {
        quoteIsC0 = address(quote) < address(t);
        Currency c0 = Currency.wrap(quoteIsC0 ? address(quote) : address(t));
        Currency c1 = Currency.wrap(quoteIsC0 ? address(t) : address(quote));
        key = PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: TS, hooks: IHooks(address(hook))});
        MANAGER.initialize(key, uint160(79228162514264337593543950336)); // 1:1

        t.mint(address(this), 1e27);
        quote.mint(address(this), 1_000_000e18);
        quote.approve(address(lp), type(uint256).max);
        t.approve(address(lp), type(uint256).max);
        quote.approve(address(swap), type(uint256).max);
        t.approve(address(swap), type(uint256).max);

        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}),
            ""
        );
    }

    /// @dev A pool quoted in something other than WETH must fee-skim in THAT
    ///      currency, credit the NEW per-currency ledger (never `owed`, the
    ///      WETH-only legacy one FeeSplitter/BuybackBurner sweep), and be claimable
    ///      only via claimIn — proving the two ledgers are genuinely isolated.
    function test_nonWethQuoteAsset_perCurrencyLedger() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockERC20 quote = new MockERC20("Mock USDC", "MUSDC", 18);
        MockBallastToken t = _mineTokenAgainst(address(quote), true);
        (PoolKey memory key, bool quoteIsC0) = _genericPool(quote, t);

        // Buy: quote in, exact-in — quote is specified, beforeSwap charges it.
        bool zeroForOne = quoteIsC0;
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(10e18), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 creatorCutIn = hook.owedIn(creator, address(quote));
        uint256 platformCutIn = hook.owedIn(platform, address(quote));
        assertGt(creatorCutIn + platformCutIn, 0, "non-WETH fee must accrue in owedIn");

        // The legacy WETH ledger must stay untouched by a non-WETH pool's fee.
        assertEq(hook.owed(creator), 0, "WETH ledger must not receive non-WETH fees");
        assertEq(hook.owed(platform), 0, "WETH ledger must not receive non-WETH fees");
        vm.prank(creator);
        assertEq(hook.claim(), 0, "claim() (legacy, WETH-only) must not touch the non-WETH ledger");

        // claimIn pays out exactly the accrued amount and zeroes the ledger.
        uint256 before = quote.balanceOf(creator);
        vm.prank(creator);
        uint256 claimedIn = hook.claimIn(address(quote));
        assertEq(claimedIn, creatorCutIn, "claimIn must pay exactly the accrued amount");
        assertEq(quote.balanceOf(creator) - before, claimedIn, "claimIn must transfer the quote asset");
        assertEq(hook.owedIn(creator, address(quote)), 0, "claimIn must zero the ledger");
    }

    function test_claimIn_revertsForWeth() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.expectRevert(BallastHook.UseClaimForWeth.selector);
        hook.claimIn(WETH);
    }

    /// @dev Neither side of this pool answers creator() — not a Ballast pool at all,
    ///      just two unrelated ERC-20s someone initialized against this shared hook.
    ///      Must revert rather than silently misattribute a fee to whichever side
    ///      elimination happens to pick.
    function test_ambiguousPool_neitherSideIsToken_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (address lo, address hi) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        PoolKey memory key =
            PoolKey({currency0: Currency.wrap(lo), currency1: Currency.wrap(hi), fee: FEE, tickSpacing: TS, hooks: IHooks(address(hook))});
        MANAGER.initialize(key, uint160(79228162514264337593543950336));
        MockERC20(lo).mint(address(this), 1e24);
        MockERC20(hi).mint(address(this), 1e24);
        IERC20(lo).approve(address(lp), type(uint256).max);
        IERC20(hi).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}), ""
        );

        IERC20(lo).approve(address(swap), type(uint256).max);
        vm.expectRevert(); // v4 wraps hook reverts; bare expectRevert matches any reason
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev BOTH sides answer creator() — a forged decoy token paired against a
    ///      real one. Same refusal-to-guess outcome as the neither-side case.
    function test_ambiguousPool_bothSidesAreTokens_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        MockBallastToken a = new MockBallastToken(creator);
        MockBallastToken b = new MockBallastToken(creator);
        (address lo, address hi) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        PoolKey memory key =
            PoolKey({currency0: Currency.wrap(lo), currency1: Currency.wrap(hi), fee: FEE, tickSpacing: TS, hooks: IHooks(address(hook))});
        MANAGER.initialize(key, uint160(79228162514264337593543950336));
        MockBallastToken(lo).mint(address(this), 1e24);
        MockBallastToken(hi).mint(address(this), 1e24);
        IERC20(lo).approve(address(lp), type(uint256).max);
        IERC20(hi).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}), ""
        );

        IERC20(lo).approve(address(swap), type(uint256).max);
        vm.expectRevert();
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
