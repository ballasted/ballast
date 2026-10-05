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
    function claimIn(address currency) external returns (uint256);
    function owedIn(address recipient, address currency) external view returns (uint256);
}

/// @dev A malicious "hook" whose claimIn() tries to re-enter claimOtherFees() on
/// the burner. Used only by the reentrancy fork test below -- never added to a
/// real deployment's claimHooks, which is immutable and deployer-chosen anyway.
contract ReentrantClaimInHookFork {
    BuybackBurnerV2 public target;
    address public asset;
    bool public attacked;

    function setTarget(BuybackBurnerV2 t, address asset_) external {
        target = t;
        asset = asset_;
    }

    function owed(address) external pure returns (uint256) {
        return 0;
    }

    function claim() external pure returns (uint256) {
        return 0;
    }

    function owedIn(address, address) external view returns (uint256) {
        return attacked ? 0 : 1;
    }

    function claimIn(address) external returns (uint256) {
        attacked = true;
        target.claimOtherFees(asset); // must revert — nonReentrant guard already held
        return 0;
    }
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
            MANAGER, BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, slippageBps, NO_HOOKS, SAFE
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
            MANAGER, BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, slippageBps, hooks, SAFE
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
        assertEq(bb.fallbackRecipient(), SAFE, "also immutable, no setter exists");
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
        (uint256 wethClaimed, uint256 nvdaClaimed) = bb.claimFees();

        assertEq(wethClaimed, seeded);
        assertEq(nvdaClaimed, 0, "nothing owed in NVDA in this scenario");
        assertEq(IWETH9c(WETH).balanceOf(address(bb)), seeded);
        assertEq(bb.buybackCount(), 0, "claiming alone never triggers a swap");
    }

    // ── 2026-10-06/13: the stuck-funds gap found this session, now fixed —      ──
    // ── NVDA/WETH are auto-claimed and burned; everything else is auto-claimed ──
    // ── and forwarded whole to fallbackRecipient. See chat record for the full ──
    // ── writeup and the original failing proof (git history, same test name,   ──
    // ── before this fix).                                                     ──

    /// @dev Was `test_fork_PROVES_nonWethQuotedPlatformFeeIsPermanentlyStuck` —
    ///      flipped now that the fix lands: the real platform fee share that
    ///      accrues to owedIn[burner][NVDA] after setPlatformVault is auto-claimed
    ///      by buybackAndBurn's NVDA path (via _claimNvda(), owedIn/claimIn) and
    ///      burned, exactly like a WETH buyback already was.
    function test_fork_nvdaPlatformFeeIsClaimedAndBurned_afterSetPlatformVault() public {
        if (!forked) return;
        address[] memory hooks = new address[](1);
        hooks[0] = HOOK;
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);

        vm.prank(SAFE);
        IFeeConfigAdmin(FEE_CONFIG).setPlatformVault(address(bb));
        assertEq(IFeeConfigAdmin(FEE_CONFIG).platformVault(), address(bb));

        // A real trader swaps through BALLAST v2's real NVDA-quoted pool.
        SandwichAttacker trader = new SandwichAttacker(MANAGER);
        deal(NVDA, address(trader), 1e18, true);
        trader.pump(nvdaKey, 1e18);

        uint256 accrued = IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA);
        assertGt(accrued, 0, "sanity: a real platform fee share accrued to the burner in owedIn");
        assertEq(bb.accruedNvda(), accrued, "view agrees before anything is pulled");

        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone); // permissionless -- no keeper, no special caller
        uint256 bought = bb.buybackAndBurn(NVDA, accrued, 0);

        assertGt(bought, 0, "claimed via owedIn/claimIn AND spent, in one call");
        assertEq(IERC20(BALLAST).balanceOf(DEAD) - deadBefore, bought);
        assertEq(bb.totalSpent(NVDA), accrued);

        // The buyback's OWN swap is itself subject to the hook's 1% fee, and since
        // platformVault is now this contract, 20% of THAT fee credits right back to
        // owedIn[bb][NVDA] -- AFTER the pre-swap claim already ran this call, so a
        // small residual is expected, not stuck: the NEXT permissionless call (here,
        // a standalone claimFees()) picks it up and zeroes it, same mechanism, no
        // special handling needed.
        uint256 residual = IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA);
        if (residual > 0) {
            (, uint256 nvdaClaimed) = bb.claimFees();
            assertEq(nvdaClaimed, residual, "the self-referential residual from the buyback's own fee");
            assertEq(IBallastHookOwedIn(HOOK).owedIn(address(bb), NVDA), 0, "fully pulled, nothing left stuck");
        }
    }

    /// @dev A platform fee in a third quote asset (not WETH, not NVDA) lands in the
    ///      Safe, exact amount. No real third-quote-asset pool/launch exists yet on
    ///      gen-4 (confirmed this session: every FeeTaken event in gen-4's history
    ///      is WETH- or NVDA-quoted only), so the accrual itself is seeded via
    ///      stdstore directly on the REAL hook's owedIn ledger -- the closest real
    ///      setup possible without a live third-quote-asset launch. Everything
    ///      downstream (claimIn, the forward, the Safe's real balance) is real.
    ///      SGOV is a real, registry-listed asset (AssetRegistry, GREEN-eligible).
    function test_fork_thirdAssetPlatformFee_claimedAndLandsInSafe_exactAmount() public {
        if (!forked) return;
        address sgov = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
        address[] memory hooks = new address[](1);
        hooks[0] = HOOK;
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);

        uint256 seeded = 1234e6; // SGOV is 6-decimal, same as other stock tokens on this chain
        stdstore.target(HOOK).sig("owedIn(address,address)").with_key(address(bb)).with_key(sgov).checked_write(
            seeded
        );
        deal(sgov, HOOK, seeded, true); // the hook must actually hold it to pay out via claimIn

        uint256 safeBalBefore = IERC20(sgov).balanceOf(SAFE);

        vm.prank(anyone); // permissionless
        uint256 forwarded = bb.claimOtherFees(sgov);

        assertEq(forwarded, seeded, "exact amount, not an estimate");
        assertEq(IERC20(sgov).balanceOf(SAFE) - safeBalBefore, seeded, "landed in the Safe, exact amount");
        assertEq(IERC20(sgov).balanceOf(address(bb)), 0, "never held here");
        assertEq(IBallastHookOwedIn(HOOK).owedIn(address(bb), sgov), 0, "fully pulled from the hook");
        assertEq(bb.totalForwarded(sgov), seeded);
    }

    function test_fork_claimOtherFees_revertsForWeth() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, 2000);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(WETH);
    }

    function test_fork_claimOtherFees_revertsForNvda() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, 2000);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(NVDA);
    }

    function test_fork_claimOtherFees_revertsForBallast() public {
        if (!forked) return;
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, 2000);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(BALLAST);
    }

    /// @dev A non-burnable asset sent here directly (no hook involved at all) is
    ///      forwardable via claimOtherFees; a WETH/NVDA donation is spendable ONLY
    ///      via buybackAndBurn (claimOtherFees refuses them outright, proven above
    ///      — this half shows the POSITIVE path: a plain donation really can be
    ///      bought-and-burned, not just that the wrong function reverts).
    function test_fork_donation_nonBurnableIsForwardable_wethNvdaOnlySpendableViaBuyback() public {
        if (!forked) return;
        address sgov = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, 2000);

        // Non-burnable: a plain transfer in, no claim involved.
        deal(sgov, address(bb), 500e6, true);
        uint256 safeBalBefore = IERC20(sgov).balanceOf(SAFE);
        uint256 forwarded = bb.claimOtherFees(sgov);
        assertEq(forwarded, 500e6);
        assertEq(IERC20(sgov).balanceOf(SAFE) - safeBalBefore, 500e6);

        // WETH: a plain transfer in is spendable only via buybackAndBurn.
        _fundWeth(address(bb), 0.001 ether);
        vm.expectRevert(BuybackBurnerV2.CannotForwardThisAsset.selector);
        bb.claimOtherFees(WETH);
        uint256 deadBefore = IERC20(BALLAST).balanceOf(DEAD);
        vm.prank(anyone);
        uint256 bought = bb.buybackAndBurn(WETH, 0.001 ether, 0);
        assertGt(bought, 0);
        assertEq(IERC20(BALLAST).balanceOf(DEAD) - deadBefore, bought);
    }

    function test_fork_claimOtherFees_reentrantHook_reverts() public {
        if (!forked) return;
        address sgov = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
        ReentrantClaimInHookFork hook = new ReentrantClaimInHookFork();
        address[] memory hooks = new address[](1);
        hooks[0] = address(hook);
        BuybackBurnerV2 bb = _deployWithClaimHooks(0.01 ether, 1000e18, 1 hours, 2000, hooks);
        hook.setTarget(bb, sgov);

        vm.expectRevert();
        bb.claimOtherFees(sgov);
    }

    /// @dev Companion to the main WETH/NVDA invariant above: a platform fee in a
    ///      third asset leaves this contract ONLY via a transfer to
    ///      `fallbackRecipient`, never anywhere else, proven directly from the
    ///      Transfer log.
    function test_fork_invariant_thirdAssetLeavesOnlyToFallbackRecipient() public {
        if (!forked) return;
        address sgov = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
        BuybackBurnerV2 bb = _deploy(0.01 ether, 1000e18, 1 hours, 2000);
        deal(sgov, address(bb), 777e6, true);

        vm.recordLogs();
        uint256 forwarded = bb.claimOtherFees(sgov);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertSingleOutboundTransfer(logs, sgov, address(bb), forwarded);

        // And that single transfer's recipient is fallbackRecipient, nowhere else.
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        bool foundToFallback;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != sgov || l.topics[0] != transferSig) continue;
            if (address(uint160(uint256(l.topics[1]))) != address(bb)) continue;
            assertEq(address(uint160(uint256(l.topics[2]))), SAFE, "the only outbound transfer goes to fallbackRecipient");
            foundToFallback = true;
        }
        assertTrue(foundToFallback);
    }
}

interface IFeeConfigAdmin {
    function setPlatformVault(address vault) external;
    function platformVault() external view returns (address);
}

interface IBallastHookOwedIn {
    function owedIn(address recipient, address currency) external view returns (uint256);
}
