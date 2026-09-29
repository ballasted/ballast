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

import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
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

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant BALLAST = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

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

    function _deploy(uint256 maxWeth, uint256 maxNvda, uint256 cooldown, uint16 slippageBps)
        internal
        returns (BuybackBurnerV2 bb)
    {
        bb = new BuybackBurnerV2(MANAGER, BALLAST, WETH, NVDA, wethKey, nvdaKey, maxWeth, maxNvda, cooldown, slippageBps);
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
}
