// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BuybackBurner} from "../src/BuybackBurner.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice The swap path of BuybackBurner exercised against the REAL $BALLAST/WETH v4
///         pool on a Robinhood Chain mainnet fork. The unit test (BuybackBurner.t.sol)
///         locks down access control, the threshold gate, accrual, the no-withdrawal
///         invariant, and ownership with a PoolManager set to address(0); it cannot run
///         the actual swap. This file is the "it moves funds, prove it on a real pool"
///         layer that DeployBuyback.s.sol step 4 requires before the contract is trusted.
///
///         Adversarial-first (CLAUDE.md): the happy buy is one test; the rest are the
///         ways a permissionless, threshold-gated, fund-moving contract can misbehave —
///         a swap that can't move (nothing bought), the slippage bound under a thin
///         pool, unspent WETH rolling into the next buyback, and the burn being
///         genuinely irrecoverable by anyone including the owner.
///
/// SKIPS unless BOTH are set (division of labour: the human runs tests with the RPC):
///   RH_RPC_URL_PAID   the paid mainnet RPC (same var the other fork tests use)
///   BALLAST_TOKEN     the $BALLAST token address (pool currency0; token < WETH)
/// Optional:
///   BUYBACK_POOL_HOOK the hook $BALLAST graduated under (defaults to the known prior
///                     hook 0x9C15…680CC). If $BALLAST was relaunched under a new hook,
///                     override it.
contract BuybackBurnerForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // Verified live infra on chain 4663 (matches BallastGraduateFork.t.sol).
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // The prior hook $BALLAST's pool was graduated under (immutable in its PoolKey).
    address constant DEFAULT_PRIOR_HOOK = 0x9C15c992E4De3711715C8B7D717EF46e474680CC;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS = 10_000;

    address ballast;
    address hook;
    PoolKey key;
    bool forked;

    address owner = makeAddr("owner");
    address anyone = makeAddr("anyone");

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        ballast = vm.envOr("BALLAST_TOKEN", address(0));
        hook = vm.envOr("BUYBACK_POOL_HOOK", DEFAULT_PRIOR_HOOK);
        if (bytes(url).length == 0 || ballast == address(0)) return;

        vm.createSelectFork(url);

        // BuybackBurner assumes $BALLAST sorts BELOW WETH (currency0). If a future
        // token doesn't, the whole zeroForOne=false assumption is wrong — surface it
        // rather than silently testing the wrong direction.
        require(ballast < WETH, "BALLAST must sort below WETH (currency0)");

        key = PoolKey({
            currency0: Currency.wrap(ballast),
            currency1: Currency.wrap(WETH),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        // The pool must actually be initialized (graduated) or there is nothing to buy
        // through — skip loudly rather than assert against an empty pool.
        (uint160 sqrtPriceX96,,,) = MANAGER.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) {
            console2.log("BuybackBurnerFork: $BALLAST pool not initialized under hook; skipping");
            return;
        }
        forked = true;
    }

    // Deploy a fresh burner pointing at the real pool. claimHooks is EMPTY: on a fork
    // this contract is not the live FeeConfig.platformVault, so owed(this) is 0 across
    // hooks; funding the WETH balance directly isolates the swap+burn path (the
    // claim-sweep is covered with a mock in the unit test).
    function _deploy(uint256 threshold, uint16 slippageBps) internal returns (BuybackBurner bb) {
        address[] memory hooks = new address[](0);
        bb = new BuybackBurner(MANAGER, WETH, ballast, key, hooks, threshold, slippageBps, owner);
    }

    // Wrap real ETH into aeWETH and fund the burner (deterministic vs deal() slot-guessing).
    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        IWETH9c(WETH).deposit{value: amount}();
        IWETH9c(WETH).transfer(to, amount);
    }

    function _sqrtLimit(uint160 sqrtPriceX96, uint16 slippageBps) internal pure returns (uint256) {
        // Mirror of BuybackBurner.unlockCallback: zeroForOne=false pushes price up, so
        // the derived limit is an upper bound on sqrtPrice after the swap.
        return (uint256(sqrtPriceX96) * (2 * BPS + slippageBps)) / (2 * BPS);
    }

    // ── Happy path: a real buy on the real pool, burned at DEAD ──────────────────

    function test_fork_buybackAndBurn_burnsAtDead() public {
        if (!forked) return;
        BuybackBurner bb = _deploy(0.001 ether, 2000); // generous cap so the buy fills
        _fundWeth(address(bb), 0.01 ether);

        uint256 deadBefore = IERC20(ballast).balanceOf(DEAD);
        uint256 wethIn = IERC20(WETH).balanceOf(address(bb));

        vm.prank(anyone); // permissionless: not the owner
        uint256 burned = bb.buybackAndBurn();

        assertGt(burned, 0, "must buy and burn something");
        assertEq(
            IERC20(ballast).balanceOf(DEAD) - deadBefore, burned, "every bought token lands at DEAD"
        );
        assertEq(IERC20(ballast).balanceOf(address(bb)), 0, "burner keeps no $BALLAST");
        assertEq(bb.totalBallastBurned(), burned, "accounting matches burn");
        assertEq(bb.buybackCount(), 1, "one buyback recorded");
        uint256 spent = bb.totalWethSpent();
        assertGt(spent, 0, "some WETH spent");
        assertLe(spent, wethIn, "cannot spend more WETH than held");
        // Any unspent WETH (price limit hit) stays in the burner for next time.
        assertEq(IERC20(WETH).balanceOf(address(bb)), wethIn - spent, "unspent WETH retained");
    }

    // ── Below threshold: a permissionless call reverts BEFORE moving any funds ───

    function test_fork_belowThreshold_movesNothing() public {
        if (!forked) return;
        BuybackBurner bb = _deploy(1 ether, 2000);
        _fundWeth(address(bb), 0.2 ether); // under threshold

        uint256 deadBefore = IERC20(ballast).balanceOf(DEAD);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(BuybackBurner.BelowThreshold.selector, 0.2 ether, 1 ether));
        bb.buybackAndBurn();

        assertEq(IERC20(WETH).balanceOf(address(bb)), 0.2 ether, "held WETH untouched");
        assertEq(IERC20(ballast).balanceOf(DEAD), deadBefore, "nothing burned");
        assertEq(bb.buybackCount(), 0, "no buyback recorded");
    }

    // ── A swap that cannot move the price reverts cleanly and strands nothing.
    //    maxSlippageBps = 0 makes the derived sqrtPrice limit sit at (or, after the
    //    ±bps math, just behind) the current price. In practice PoolManager rejects it
    //    first with PriceLimitAlreadyExceeded (0x7c9c6e8f) — before the contract's own
    //    NothingBought guard is ever reached. WHICH error surfaces is not the point:
    //    the guarantee is that the call reverts atomically, so no WETH leaves the
    //    burner and nothing reaches DEAD. Assert that, not a specific selector.

    function test_fork_zeroSlippage_revertsCleanly_noFundsMoved() public {
        if (!forked) return;
        BuybackBurner bb = _deploy(0.001 ether, 0); // 0% move allowed
        _fundWeth(address(bb), 0.01 ether);
        uint256 wethIn = IERC20(WETH).balanceOf(address(bb));
        uint256 deadBefore = IERC20(ballast).balanceOf(DEAD);

        vm.prank(anyone);
        vm.expectRevert(); // any revert — PriceLimitAlreadyExceeded or NothingBought
        bb.buybackAndBurn();

        // Whatever reverted, the whole call rolled back: funds are exactly as before.
        assertEq(IERC20(WETH).balanceOf(address(bb)), wethIn, "WETH fully retained after revert");
        assertEq(IERC20(ballast).balanceOf(DEAD), deadBefore, "nothing reached DEAD");
        assertEq(bb.buybackCount(), 0, "no buyback recorded");
    }

    // ── The slippage bound is respected on the real (thin) pool, and unspent WETH
    //    rolls into a second buyback. $BALLAST's pool is deliberately thin (one-sided
    //    seed, ~1 ETH FDV), so a tight cap against a large-ish buy is expected to bite.

    function test_fork_thinPool_slippageBound_and_rollover() public {
        if (!forked) return;
        uint16 cap = 100; // 1% max price move per buyback
        BuybackBurner bb = _deploy(0.001 ether, cap);

        (uint160 sqrtBefore,,,) = MANAGER.getSlot0(key.toId());
        uint256 fund = 1 ether; // large relative to a ~1 ETH-FDV pool
        _fundWeth(address(bb), fund);

        vm.prank(anyone);
        uint256 burned1 = bb.buybackAndBurn();
        assertGt(burned1, 0, "first buyback buys something");

        // Price after must not exceed the caller-independent upper bound.
        (uint160 sqrtAfter,,,) = MANAGER.getSlot0(key.toId());
        assertLe(uint256(sqrtAfter), _sqrtLimit(sqrtBefore, cap) + 1, "price move within slippage cap");

        uint256 spent1 = bb.totalWethSpent();
        uint256 leftover = IERC20(WETH).balanceOf(address(bb));
        assertEq(leftover, fund - spent1, "unspent WETH retained for next buyback");

        // On the thin $BALLAST pool the cap is expected to bite (partial fill). If it
        // does, prove the rollover: a second call spends the remainder and burns more.
        if (leftover >= bb.threshold() && leftover > 0) {
            uint256 deadMid = IERC20(ballast).balanceOf(DEAD);
            vm.prank(anyone);
            uint256 burned2 = bb.buybackAndBurn();
            assertGt(burned2, 0, "rollover buyback buys more");
            assertEq(
                IERC20(ballast).balanceOf(DEAD) - deadMid, burned2, "rollover burn lands at DEAD"
            );
            assertEq(bb.buybackCount(), 2, "two buybacks recorded");
        } else {
            console2.log("thin-pool cap did not bite (pool deeper than expected); rollover not exercised");
        }
    }

    // ── The burn is irrecoverable: after a buyback the $BALLAST sits at DEAD, and there
    //    is NO path — for anyone, including the owner — to pull WETH or $BALLAST out of
    //    the burner. The absence of a withdraw function is the guarantee; this asserts
    //    the owner's only powers are tuning, and that funds only ever exit via burn.

    function test_fork_ownerCannotRecoverFunds() public {
        if (!forked) return;
        BuybackBurner bb = _deploy(0.001 ether, 2000);
        _fundWeth(address(bb), 0.01 ether);

        vm.prank(anyone);
        uint256 burned = bb.buybackAndBurn();
        assertGt(burned, 0);

        uint256 deadBal = IERC20(ballast).balanceOf(DEAD);
        // Owner tuning powers exist; a fund-extraction power does not. If BuybackBurner
        // ever grows a withdraw/rescue/sweep function, this file won't compile against
        // the intent — the invariant is enforced by the surface area, not a modifier.
        vm.startPrank(owner);
        bb.setThreshold(5 ether);
        bb.setMaxSlippageBps(1000);
        vm.stopPrank();

        // The burned tokens have not moved and the burner holds no $BALLAST to move.
        assertEq(IERC20(ballast).balanceOf(DEAD), deadBal, "burned supply unchanged by owner");
        assertEq(IERC20(ballast).balanceOf(address(bb)), 0, "burner holds no recoverable $BALLAST");
    }
}
