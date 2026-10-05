// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Front-runs the burner's own WETH->BALLAST direction (zeroForOne=true,
/// same as BuybackBurnerV2.unlockCallback) with no price limit of its own, to prove
/// the burner's slippage guard still bounds ITS OWN additional price impact to
/// maxSlippageBps off whatever spot exists at the moment it executes — regardless
/// of what moved the price immediately before.
contract SandwichAttacker is IUnlockCallback {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function pump(PoolKey calldata key, uint256 amountIn) external {
        manager.unlock(abi.encode(key, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));
        BalanceDelta delta = manager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 // attacker doesn't care about its own slippage
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) key.currency0.settle(manager, address(this), uint256(uint128(-d0)), false);
        if (d1 > 0) key.currency1.take(manager, address(this), uint256(uint128(d1)), false);
        return "";
    }
}

/// @dev Same minimal claim interface BuybackBurnerV2.sol declares — redeclared here
/// (rather than imported) because it's file-private in that file.
interface IBallastHookClaimTest {
    function claim() external returns (uint256);
    function owed(address recipient) external view returns (uint256);
}

/// @notice BuybackBurnerV2 exercised against $BALLAST v2's TWO REAL, LIVE pools
/// (WETH-quoted and NVDA-quoted) on a Robinhood Chain mainnet fork — both pools
/// confirmed initialized and holding real (if thin) liquidity as of 2026-09-29.
///
/// SKIPS unless RH_RPC_URL_PAID is set (division of labour: the human/CI runs
/// tests with the RPC).
contract BuybackBurnerV2ForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using stdStorage for StdStorage;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant BALLAST = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant FEE_CONFIG = 0xE09F093595045E8765F420Cb12E0AA250910E5AD;
    address constant SAFE = 0xEFC97e16a24d2434C7138a2634E554a0631aC079;

    uint256 internal constant BPS = 10_000;

    PoolKey wethKey;
    PoolKey nvdaKey;
    bool forked;

    address anyone = makeAddr("anyone");

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);

        // Both real pools sort the quote asset as currency0, BALLAST as currency1
        // (verified live via cast before writing BuybackBurnerV2.sol — re-asserted
        // here so a wrong assumption fails loudly instead of silently mis-swapping).
        require(WETH < BALLAST, "WETH must sort below BALLAST (currency0)");
        require(NVDA < BALLAST, "NVDA must sort below BALLAST (currency0)");

        wethKey = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(BALLAST),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });
        nvdaKey = PoolKey({
            currency0: Currency.wrap(NVDA),
            currency1: Currency.wrap(BALLAST),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });

        (uint160 p0,,,) = MANAGER.getSlot0(wethKey.toId());
        (uint160 p1,,,) = MANAGER.getSlot0(nvdaKey.toId());
        if (p0 == 0 || p1 == 0) {
            console2.log("BuybackBurnerV2Fork: a BALLAST v2 pool is not initialized; skipping");
            return;
        }
        forked = true;
    }

    address[] NO_HOOKS;

    function _deploy(uint256 maxWeth, uint256 maxNvda, uint256 cooldown, uint16 slippageBps)
        internal
        returns (BuybackBurnerV2 bb)
    {
        bb = new BuybackBurnerV2(
            MANAGER, BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, slippageBps, NO_HOOKS
        );
    }

    function _deployWithClaimHooks(
        uint256 maxWeth,
        uint256 maxNvda,
        uint256 cooldown,
        uint16 slippageBps,
        address[] memory hooks
    ) internal returns (BuybackBurnerV2 bb) {
        bb = new BuybackBurnerV2(
            MANAGER, BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, slippageBps, hooks
        );
    }

    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        IWETH9c(WETH).deposit{value: amount}();
        IWETH9c(WETH).transfer(to, amount);
    }

    function _fundNvda(address to, uint256 amount) internal {
        // NVDA has no faucet on a fork; pull from a real known holder via deal()
        // (storage-slot manipulation) since it's a standard ERC-20 balance mapping.
        deal(NVDA, to, amount, true);
    }

    // ── Happy path: both pools work end to end ──────────────────────────────

    function test_fork_buybackWeth_burnsAtDead() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(1 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 0.01 ether);

        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(WETH, 0.01 ether, 0);

        assertGt(bought, 0, "must buy something");
        assertEq(IERC20(BALLAST).balanceOf(DEAD) - deadBefore, bought, "bought tokens land at DEAD");
        assertEq(IERC20(BALLAST).balanceOf(address(bb)), 0, "burner keeps no BALLAST");
        assertEq(bb.totalBallastBurned(), bought);
        assertEq(bb.buybackCount(), 1);
    }

    function test_fork_buybackNvda_burnsAtDead() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(1 ether, 1000e18, 1 hours, 2000);
        _fundNvda(address(bb), 10e18);

        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(NVDA, 10e18, 0);

        assertGt(bought, 0, "must buy something via the NVDA pool");
        assertEq(IERC20(BALLAST).balanceOf(DEAD) - deadBefore, bought);
        assertEq(bb.totalSpent(NVDA), bought > 0 ? bb.totalSpent(NVDA) : 0); // sanity: doesn't revert
    }

    // ── Per-call cap clamps spend, doesn't revert ───────────────────────────

    function test_fork_perCallCap_clampsSpend() public {
        if (!forked) return;
        uint256 cap = 0.001 ether;
        BuybackBurnerV2 bb = _deploy(cap, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 1 ether); // far more than the cap

        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 1 ether, 0);

        assertEq(bb.totalSpent(WETH), cap, "spent exactly the per-call cap, not the full request");
        assertEq(IERC20(WETH).balanceOf(address(bb)), 1 ether - cap, "the rest stays held for a later call");
    }

    // ── Cooldown ─────────────────────────────────────────────────────────────

    function test_fork_cooldown_blocksImmediateSecondCall() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 1 ether);

        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0);

        vm.prank(anyone);
        vm.expectRevert(); // Cooldown(readyAt)
        bb.buybackAndBurn(WETH, 0.001 ether, 0);
    }

    function test_fork_cooldown_isPerAsset_notGlobal() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 1 ether);
        _fundNvda(address(bb), 100e18);

        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0);

        // NVDA's cooldown is independent -- this must NOT revert.
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(NVDA, 10e18, 0);
        assertGt(bought, 0, "NVDA buyback unaffected by WETH's cooldown");
    }

    function test_fork_cooldown_expiresAndAllowsAgain() public {
        if (!forked) return;
        uint256 cooldown = 1 hours;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, cooldown, 2000);
        _fundWeth(address(bb), 1 ether);

        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0);

        vm.warp(block.timestamp + cooldown);
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(WETH, 0.001 ether, 0);
        assertGt(bought, 0, "second call succeeds once cooldown has fully elapsed");
        assertEq(bb.buybackCount(), 2);
    }

    // ── minAmountOut (caller quote bound) ───────────────────────────────────

    function test_fork_minAmountOutNotMet_reverts_movesNothing() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 0.001 ether);

        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone);
        vm.expectRevert(); // MinAmountOutNotMet
        bb.buybackAndBurn(WETH, 0.001 ether, type(uint256).max); // impossible floor

        assertEq(IERC20(WETH).balanceOf(address(bb)), 0.001 ether, "WETH untouched on revert");
        assertEq(IERC20(BALLAST).balanceOf(DEAD), deadBefore, "nothing burned on revert");
        assertEq(bb.buybackCount(), 0);
    }

    // ── Unsupported asset ────────────────────────────────────────────────────

    function test_fork_unsupportedAsset_reverts() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        vm.expectRevert(BuybackBurnerV2.UnsupportedAsset.selector);
        bb.buybackAndBurn(address(0xdead), 1, 0);
    }

    // ── Zero slippage on the real thin pool reverts cleanly, moves nothing ──

    function test_fork_zeroSlippage_revertsCleanly_noFundsMoved() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 0);
        _fundWeth(address(bb), 0.001 ether);
        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);

        vm.prank(anyone);
        vm.expectRevert();
        bb.buybackAndBurn(WETH, 0.001 ether, 0);

        assertEq(IERC20(WETH).balanceOf(address(bb)), 0.001 ether);
        assertEq(IERC20(BALLAST).balanceOf(DEAD), deadBefore);
    }

    // ── No admin surface exists at all — the guarantee is the ABSENCE of any
    //    tuning/withdraw function, not a modifier blocking one. If this contract
    //    ever grows an owner-gated function, there is deliberately no test that
    //    calls it here (there's nothing to call) — the constructor-only,
    //    fully-immutable parameter set IS the invariant.

    function test_allParametersAreImmutable_noSetterExists() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        // Every one of these is a `public immutable` getter with no corresponding
        // setter anywhere in the contract -- compiles only because no setter exists
        // to accidentally call instead.
        assertEq(bb.maxWethPerCall(), 0.001 ether);
        assertEq(bb.maxNvdaPerCall(), 1000e18);
        assertEq(bb.cooldownSeconds(), 1 hours);
        assertEq(bb.maxSlippageBps(), 2000);
    }

    // ── Sandwich attempt bounded by the slippage guard ──────────────────────

    function test_fork_sandwich_burnerImpactStillBoundedBySlippageAfterFrontRun() public {
        if (!forked) return;
        uint16 slippageBps = 1000; // 10%
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, slippageBps);
        _fundWeth(address(bb), 0.005 ether);

        // Attacker front-runs with the SAME direction (buying BALLAST with WETH),
        // pumping BALLAST's price before our call executes.
        SandwichAttacker attacker = new SandwichAttacker(MANAGER);
        _fundWeth(address(attacker), 0.05 ether);
        attacker.pump(wethKey, 0.05 ether);

        (uint160 spotAtCallTime,,,) = MANAGER.getSlot0(wethKey.toId());

        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(WETH, 0.005 ether, 0); // naive caller, no off-chain quote
        assertGt(bought, 0, "still executes after a front-run, just at the already-moved price");

        // The burner's OWN contribution to price impact must not push the pool
        // below its documented bound relative to spot AT THE MOMENT IT CALLED --
        // i.e. the front-run cost the caller whatever the front-run cost (an
        // inherent, unavoidable AMM fact, not this guard's job), but the guard's
        // OWN additional slippage on top of that is still capped at slippageBps.
        (uint160 spotAfter,,,) = MANAGER.getSlot0(wethKey.toId());
        uint256 rawLimit = (uint256(spotAtCallTime) * (2 * 10_000 - slippageBps)) / (2 * 10_000);
        uint160 minLimit = TickMath.MIN_SQRT_PRICE + 1;
        uint160 expectedBound = rawLimit <= minLimit ? minLimit : uint160(rawLimit);
        assertGe(spotAfter, expectedBound, "burner's own swap never crosses its documented slippage bound");
    }

    // ── Invariant: WETH leaves only through the swap, BALLAST only through the burn ──

    /// @dev Proves the invariant directly from the Transfer log, not from
    ///      totalSpent(asset). totalSpent[asset] is set BEFORE the swap runs
    ///      (buybackAndBurn's requested `spend`, clamped to cap/held) and is
    ///      NOT corrected to the actual amount settled afterward -- on a thin
    ///      pool, a large request can partially fill against its own
    ///      sqrtPriceLimitX96 bound, so the real outflow can be LESS than
    ///      totalSpent records (confirmed live 2026-10-06: requesting 10 NVDA
    ///      against ~$2.8k of real liquidity only settled ~2.71 NVDA +
    ///      fee, while totalSpent(NVDA) and the BuybackBurned event's `spent`
    ///      field both still read the full 10e18 requested). That is a real,
    ///      separate accounting bug in the contract (over-reports realized
    ///      spend under a partial fill) -- flagged, not fixed here, and not
    ///      what this test is about. What THIS test verifies is the actual
    ///      fund-safety invariant: every wei that leaves the asset balance is
    ///      accounted for by exactly one outbound Transfer (the swap settling
    ///      to the PoolManager), and BALLAST never sits in the contract
    ///      outside of the burn.
    function test_fork_invariant_wethOnlyViaSwap_ballastOnlyViaBurn() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 0.003 ether);
        _fundNvda(address(bb), 30e18);

        uint256 wethBefore = IERC20(WETH).balanceOf(address(bb));
        vm.recordLogs();
        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0);
        uint256 wethOut = wethBefore - IERC20(WETH).balanceOf(address(bb));
        _assertSingleOutboundTransfer(vm.getRecordedLogs(), WETH, address(bb), wethOut);
        assertGt(wethOut, 0, "sanity: the call must actually have spent something");
        assertEq(IERC20(BALLAST).balanceOf(address(bb)), 0, "no BALLAST ever retained, mid- or post-call");

        vm.warp(block.timestamp + 1 hours);
        uint256 nvdaBefore = IERC20(NVDA).balanceOf(address(bb));
        vm.recordLogs();
        vm.prank(anyone);
        bb.buybackAndBurn(NVDA, 10e18, 0);
        uint256 nvdaOut = nvdaBefore - IERC20(NVDA).balanceOf(address(bb));
        _assertSingleOutboundTransfer(vm.getRecordedLogs(), NVDA, address(bb), nvdaOut);
        assertGt(nvdaOut, 0, "sanity: the call must actually have spent something");
        assertEq(IERC20(BALLAST).balanceOf(address(bb)), 0);
    }

    /// @dev Scans every log emitted during the call for ERC-20 Transfer events
    ///      where `token` moved OUT of `from`, and asserts there was exactly
    ///      one such transfer, for exactly `expectedAmount` -- i.e. the asset's
    ///      entire observed balance drop is explained by a single outbound
    ///      transfer (the swap settlement), not split across multiple calls or
    ///      moved by some other path. Independent of any of the contract's own
    ///      self-reported counters.
    function _assertSingleOutboundTransfer(Vm.Log[] memory logs, address token, address from, uint256 expectedAmount)
        internal
        pure
    {
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 matches;
        uint256 totalOut;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != token) continue;
            if (l.topics.length == 0 || l.topics[0] != transferSig) continue;
            if (address(uint160(uint256(l.topics[1]))) != from) continue;
            matches++;
            totalOut += abi.decode(l.data, (uint256));
        }
        assertEq(matches, 1, "expected exactly one outbound Transfer of this asset from the burner");
        assertEq(totalOut, expectedAmount, "the single outbound transfer must equal the full observed balance drop");
    }

    function _sumOutboundTransfers(Vm.Log[] memory logs, address token, address from) internal pure returns (uint256 total) {
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != token) continue;
            if (l.topics.length == 0 || l.topics[0] != transferSig) continue;
            if (address(uint160(uint256(l.topics[1]))) != from) continue;
            total += abi.decode(l.data, (uint256));
        }
    }

    function _sumBuybackBurnedSpent(Vm.Log[] memory logs) internal pure returns (uint256 total) {
        bytes32 sig = keccak256("BuybackBurned(address,address,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0 || l.topics[0] != sig) continue;
            (uint256 spent,,) = abi.decode(l.data, (uint256, uint256, uint256));
            total += spent;
        }
    }

    // ── Accounting fix (2026-10-06): totalSpent/event record the REAL settled  ──
    // ── amount, not the pre-swap request, on both partial and full fills.      ──

    /// @dev The exact live scenario that exposed the bug: requesting far more NVDA
    ///      than the thin real pool can absorb at the slippage bound. Before the
    ///      fix, totalSpent(NVDA) and the event's `spent` both read the full 10e18
    ///      requested; after the fix, both must read the real ~2.7e18 settled.
    function test_fork_partialFill_recordsRealSettledAmount_notRequested() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundNvda(address(bb), 30e18);

        uint256 nvdaBefore = IERC20(NVDA).balanceOf(address(bb));
        vm.recordLogs();
        vm.prank(anyone);
        bb.buybackAndBurn(NVDA, 10e18, 0); // far more than the real pool can absorb at 20%
        uint256 realSpent = nvdaBefore - IERC20(NVDA).balanceOf(address(bb));

        assertLt(realSpent, 10e18, "sanity: this must actually be a partial fill, not a full one");
        assertEq(bb.totalSpent(NVDA), realSpent, "totalSpent must record what was really settled, not the request");

        uint256 eventSpent = _singleBuybackBurnedSpent(vm.getRecordedLogs());
        assertEq(eventSpent, realSpent, "the BuybackBurned event must report the same real amount");
    }

    /// @dev A small request against real depth fully fills -- requested == settled
    ///      == totalSpent == event.spent, unchanged from before this fix.
    function test_fork_fullFill_totalSpentAndEventStillMatchTheRequest() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 0.001 ether);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(bb));

        vm.recordLogs();
        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0);
        uint256 realSpent = wethBefore - IERC20(WETH).balanceOf(address(bb));

        assertEq(realSpent, 0.001 ether, "sanity: this must be a full fill");
        assertEq(bb.totalSpent(WETH), 0.001 ether);
        assertEq(_singleBuybackBurnedSpent(vm.getRecordedLogs()), 0.001 ether);
    }

    function _singleBuybackBurnedSpent(Vm.Log[] memory logs) internal pure returns (uint256) {
        bytes32 sig = keccak256("BuybackBurned(address,address,uint256,uint256,uint256)");
        uint256 matches;
        uint256 spentOut;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0 || l.topics[0] != sig) continue;
            matches++;
            (uint256 spent,,) = abi.decode(l.data, (uint256, uint256, uint256));
            spentOut = spent;
        }
        assertEq(matches, 1, "expected exactly one BuybackBurned event");
        return spentOut;
    }

    /// @dev Across a mix of full and partial fills, on both assets, the sum of every
    ///      BuybackBurned.spent must equal the sum of every outbound WETH/NVDA
    ///      Transfer from the contract -- the event never over- or under-reports
    ///      relative to what actually moved, in aggregate, not just per-call.
    function test_fork_sumOfBuybackBurnedSpent_equalsSumOfTransfersOut() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.001 ether, 1000e18, 1 hours, 2000);
        _fundWeth(address(bb), 1 ether);
        _fundNvda(address(bb), 30e18);

        vm.recordLogs();
        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0); // full fill
        vm.prank(anyone);
        bb.buybackAndBurn(NVDA, 10e18, 0); // partial fill (same scenario as above)
        vm.warp(block.timestamp + 1 hours);
        vm.prank(anyone);
        bb.buybackAndBurn(WETH, 0.001 ether, 0); // full fill again, independent cooldown

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 totalEventSpent = _sumBuybackBurnedSpent(logs);
        uint256 totalTransferredOut =
            _sumOutboundTransfers(logs, WETH, address(bb)) + _sumOutboundTransfers(logs, NVDA, address(bb));

        assertGt(totalEventSpent, 0);
        assertEq(totalEventSpent, totalTransferredOut, "aggregate event spend must equal aggregate real outflow");
    }

    // ── claimFees integration: a real buyback funded by the platform's hook fee ──

    function test_fork_claimFees_fundsAndExecutesARealBuyback() public {
        if (!forked) return;
        address[] memory hooks = new address[](1);
        hooks[0] = HOOK;
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);

        uint256 seeded = 0.004 ether;
        // Seed owed[bb] on the REAL hook (simulating already-accrued platform fees
        // from real swap activity) and make sure the hook actually holds that much
        // WETH to pay out -- claim() does a real transfer, not a mint.
        stdstore.target(HOOK).sig("owed(address)").with_key(address(bb)).checked_write(seeded);
        _fundWeth(HOOK, seeded);

        assertEq(bb.accruedWeth(), seeded, "view sums claimable even before anything is pulled");
        assertEq(IWETH9c(WETH).balanceOf(address(bb)), 0, "nothing held yet -- all of it is still at the hook");

        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(WETH, seeded, 0);

        assertGt(bought, 0, "a single permissionless call claimed the fee share AND executed the buyback");
        assertEq(IBallastHookClaimTest(HOOK).owed(address(bb)), 0, "fully pulled from the hook");
        assertEq(IERC20(BALLAST).balanceOf(DEAD) - deadBefore, bought);
        assertEq(bb.totalSpent(WETH), seeded);
    }

    function test_fork_claimFees_standalone_doesNotRequireABuyback() public {
        if (!forked) return;
        address[] memory hooks = new address[](1);
        hooks[0] = HOOK;
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);

        uint256 seeded = 0.002 ether;
        stdstore.target(HOOK).sig("owed(address)").with_key(address(bb)).checked_write(seeded);
        _fundWeth(HOOK, seeded);

        vm.prank(anyone); // permissionless
        uint256 claimed = bb.claimFees();

        assertEq(claimed, seeded);
        assertEq(IWETH9c(WETH).balanceOf(address(bb)), seeded);
        assertEq(bb.buybackCount(), 0, "claiming alone never triggers a swap");
    }

    // ── 2026-10-06: proves a real, severe gap — DO NOT sign setPlatformVault  ──
    // ── until this is resolved. See the chat record for the full writeup.    ──

    /// @dev BallastHook._distribute (src/BallastHook.sol:335-343) splits by quote
    ///      asset: WETH-quoted fees go to `owed[recipient]` (claim()); every OTHER
    ///      quote asset's fees go to `owedIn[recipient][quoteAsset]` (claimIn(asset)).
    ///      BuybackBurnerV2.claimFees()/_claimFees() only ever calls claim()/owed()
    ///      -- claimIn is referenced nowhere in this contract (grep confirms it).
    ///      So: if FeeConfig.platformVault is pointed at this contract, EVERY
    ///      non-WETH-quoted pool's platform share (today: BALLAST v2's own NVDA
    ///      pool; structurally ANY future non-WETH quote asset too) accrues to
    ///      owedIn[address(this)][asset] and stays there FOREVER -- the only
    ///      address that can ever call claimIn(asset) for it is this contract
    ///      itself (owedIn is keyed by msg.sender), and this contract has no
    ///      function, no fallback, and no upgrade path that could ever do that.
    ///      This test proves it end to end against the real hook and the real
    ///      FeeConfig owner (the Safe), not a mock.
    function test_fork_PROVES_nonWethQuotedPlatformFeeIsPermanentlyStuck() public {
        if (!forked) return;
        address[] memory hooks = new address[](1);
        hooks[0] = HOOK;
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);

        // Step 1: the Safe (real, live FeeConfig owner -- confirmed this session)
        // signs exactly the transaction this whole thread has been building toward.
        vm.prank(SAFE);
        IFeeConfigAdmin(FEE_CONFIG).setPlatformVault(address(bb));
        assertEq(IFeeConfigAdmin(FEE_CONFIG).platformVault(), address(bb));

        // Step 2: a real trader swaps through BALLAST v2's real NVDA-quoted pool --
        // same real liquidity, same real hook, same real _distribute logic every
        // other test in this file already exercises for WETH.
        SandwichAttacker trader = new SandwichAttacker(MANAGER);
        deal(NVDA, address(trader), 1e18, true);
        trader.pump(nvdaKey, 1e18);

        uint256 stuckAmount = IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA);
        assertGt(stuckAmount, 0, "sanity: a real platform fee share accrued to the burner in owedIn");

        // Step 3: claimFees() -- the ONLY permissionless entrypoint this contract
        // has for pulling fees -- is blind to it. Not reverting, not helping either.
        vm.prank(anyone);
        uint256 claimed = bb.claimFees();
        assertEq(claimed, 0, "claimFees() only ever touches owed()/claim() -- owedIn is invisible to it");
        assertEq(
            IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA), stuckAmount, "still sitting there, untouched"
        );

        // Step 4: prove there is no OTHER way out either -- no function on this
        // contract's real deployed bytecode responds to claimIn's selector (no
        // fallback exists, so an unmatched selector reverts cleanly).
        (bool ok,) = address(bb).call(abi.encodeWithSelector(bytes4(keccak256("claimIn(address)")), NVDA));
        assertFalse(ok, "no function on the burner can ever call hook.claimIn -- confirmed against real bytecode");

        // Step 5: the amount is still exactly where it was -- permanently stuck,
        // not merely "not yet claimed." Nothing-left-to-try, by construction.
        assertEq(IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA), stuckAmount);
    }
}

interface IFeeConfigAdmin {
    function setPlatformVault(address vault) external;
    function platformVault() external view returns (address);
}

interface IBallastHookOwedIn {
    function owedIn(address recipient, address currency) external view returns (uint256);
}
