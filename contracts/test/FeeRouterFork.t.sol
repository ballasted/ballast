// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {BallastFactory} from "../src/BallastFactory.sol";
import {BallastSeeder} from "../src/BallastSeeder.sol";
import {BallastHook, BALLAST_HOOK_FLAGS} from "../src/BallastHook.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {FeeRouterFactory} from "../src/FeeRouterFactory.sol";
import {HolderStakingVault} from "../src/HolderStakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev Same fresh-but-real-PoolManager pattern as BallastGraduateFork.t.sol: a
///      real BallastFactory/Hook/Seeder deployed fresh on a Robinhood Chain mainnet
///      fork against the REAL, live PoolManager singleton — not the already-live
///      production factory (that one's config is fixed and not ours to add test
///      launches through). The treasury-bucket pool is a plain vanilla v4 pool this
///      file initializes and seeds itself, so the swap it exercises is fully
///      self-derived rather than guessing a real external pool's fee tier/liquidity
///      (see docs/FEE_ROUTER_DESIGN.md §2.4 — that's exactly the kind of unverified
///      address this file avoids hardcoding).
///
///      SKIPS unless RH_RPC_URL_PAID is set.
contract FeeRouterForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant DISCLOSURE = keccak256("fee-router v1: auto-routed trading fee, permanently locked, no claim");

    AssetRegistry registry;
    FeeConfig cfg;
    BallastHook hook;
    BallastSeeder seeder;
    BallastFactory factory;
    FeeRouterFactory routerFactory;
    PoolModifyLiquidityTest lp;
    PoolSwapTest swap;
    MockERC20 treasuryAsset;
    PoolKey treasuryKey;

    address platform = makeAddr("platform");
    address realCreator = makeAddr("realCreator");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        registry = new AssetRegistry(address(this));
        cfg = new FeeConfig(address(this), platform);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), BALLAST_HOOK_FLAGS, type(BallastHook).creationCode, abi.encode(MANAGER, cfg, WETH));
        hook = new BallastHook{salt: salt}(MANAGER, cfg, WETH);
        require(address(hook) == hookAddr, "hook addr mismatch");
        seeder = new BallastSeeder(MANAGER, address(hook));
        hook.setSeeder(address(seeder));

        factory = new BallastFactory(
            address(registry), WETH, seeder, address(_ethFeed()), 24 hours, new address[](0)
        );
        routerFactory = new FeeRouterFactory();

        lp = new PoolModifyLiquidityTest(MANAGER);
        swap = new PoolSwapTest(MANAGER);

        vm.deal(address(this), 2000 ether);
        IWETH9c(WETH).deposit{value: 1000 ether}();
        IERC20(WETH).approve(address(lp), type(uint256).max);
        IERC20(WETH).approve(address(swap), type(uint256).max);

        // A self-created, self-seeded WETH/treasuryAsset pool for the treasury
        // bucket's swap — no guessing a real external pool's address/fee tier.
        treasuryAsset = new MockERC20("Mock SGOV", "SGOV", 18);
        registry.setAsset(address(treasuryAsset), address(0xFEED), 1 days, 1); // tiny min: test swaps are small
        treasuryAsset.mint(address(this), 1_000_000e18);
        treasuryAsset.approve(address(lp), type(uint256).max);
        treasuryAsset.approve(address(swap), type(uint256).max);

        bool wethIsC0 = WETH < address(treasuryAsset);
        treasuryKey = PoolKey({
            currency0: Currency.wrap(wethIsC0 ? WETH : address(treasuryAsset)),
            currency1: Currency.wrap(wethIsC0 ? address(treasuryAsset) : WETH),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        MANAGER.initialize(treasuryKey, uint160(79228162514264337593543950336)); // 1:1
        lp.modifyLiquidity(
            treasuryKey,
            IPoolManager.ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e20, salt: 0}),
            ""
        );
    }

    function _ethFeed() internal returns (address) {
        // Inline mock so this file doesn't need MockAggregator's constructor
        // signature imported just for a constant $3000 price.
        return address(new FixedFeed(3000e8, block.timestamp));
    }

    function _forceNextLaunchCurrency0() internal {
        uint64 nonce = uint64(vm.getNonce(address(factory)));
        while (vm.computeCreateAddress(address(factory), nonce) >= WETH) {
            nonce++;
        }
        vm.setNonce(address(factory), nonce);
    }

    function _launchViaRouter(uint16 maxSlippageBps)
        internal
        returns (FeeRouter router, address token, address treasury)
    {
        _forceNextLaunchCurrency0();
        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = WETH;
        vm.prank(realCreator);
        (router, token, treasury) = routerFactory.createAndLaunch(
            address(hook),
            WETH,
            address(MANAGER),
            address(treasuryAsset),
            treasuryKey,
            address(registry),
            maxSlippageBps,
            100 ether,
            1 hours,
            DISCLOSURE,
            address(factory),
            "Test",
            "TST",
            30 days,
            "ipfs://test",
            quoteAssets
        );
    }

    /// @dev Spends WETH for token. `_forceNextLaunchCurrency0` guarantees
    ///      token == currency0 / WETH == currency1 for every launch in this file,
    ///      so buying is always zeroForOne=false (matches the verified working
    ///      example in BallastGraduateFork.t.sol).
    function _buyTokenWithWeth(PoolKey memory key, uint256 wethIn) internal {
        swap.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -int256(wethIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // --------------------------------------------------------------------- //
    //  Full happy path: all four buckets, one real gen-4 pool                //
    // --------------------------------------------------------------------- //

    function test_fork_allFourBuckets_endToEnd() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouter router, address token, address treasury) = _launchViaRouter(1000);
        assertEq(MockRouterCheck(token).creator(), address(router), "router must be on-chain creator");

        factory.graduate(token);
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        // Equal split across all four buckets.
        vm.prank(realCreator);
        router.scheduleSplit(2500, 2500, 2500, 2500);
        vm.warp(block.timestamp + 7 days);
        router.wireBuybackPool();

        // A staker, so the rewards bucket has somewhere to land. The entire token
        // supply sits with the Seeder as one-sided liquidity post-graduation — the
        // only way anyone (including this test) holds any is to buy it.
        address staker = makeAddr("staker");
        deal(WETH, staker, 2 ether);
        vm.startPrank(staker);
        IERC20(WETH).approve(address(swap), type(uint256).max);
        _buyTokenWithWeth(tokenKey, 1 ether);
        MockRouterCheck(token).approve(router.stakingVault(), type(uint256).max);
        HolderStakingVault(router.stakingVault()).stake(MockRouterCheck(token).balanceOf(staker));
        vm.stopPrank();

        _buyTokenWithWeth(tokenKey, 4 ether); // generates a real 1% WETH fee -> owed[router]

        uint256 creatorBefore = IERC20(WETH).balanceOf(realCreator);
        uint256 lockedBefore = ProjectTreasury(treasury).lockedBalance(address(treasuryAsset));
        uint256 burnedBefore = MockRouterCheck(token).balanceOf(DEAD);

        router.route(0, 0, 0);

        assertGt(IERC20(WETH).balanceOf(realCreator) - creatorBefore, 0, "creator bucket paid");
        assertGt(ProjectTreasury(treasury).lockedBalance(address(treasuryAsset)) - lockedBefore, 0, "treasury bucket locked forever");
        assertGt(MockRouterCheck(token).balanceOf(DEAD) - burnedBefore, 0, "buyback bucket burned tokens");
        assertGt(router.totalRoutedToRewards(), 0, "rewards bucket funded the vault");
        assertGt(HolderStakingVault(router.stakingVault()).claimable(staker), 0, "staker has claimable rewards");

        // Treasury deposit is genuinely permanent — no creator-withdrawable balance
        // was created by the fee-router path (only lockedBalance moved).
        assertEq(ProjectTreasury(treasury).creatorWithdrawable(address(treasuryAsset)), 0);
    }

    // --------------------------------------------------------------------- //
    //  Slippage: an impossible floor reverts and moves nothing               //
    // --------------------------------------------------------------------- //

    function test_fork_treasurySwap_minOutNotMet_revertsCleanly() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouter router, address token,) = _launchViaRouter(1000);
        factory.graduate(token);
        PoolKey memory tokenKey =
            PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});

        vm.prank(realCreator);
        router.scheduleSplit(0, 10000, 0, 0);
        vm.warp(block.timestamp + 7 days);

        _buyTokenWithWeth(tokenKey, 4 ether);

        vm.expectRevert(); // MinAmountOutNotMet
        router.route(0, type(uint256).max, 0);
    }

    // --------------------------------------------------------------------- //
    //  Buyback deferred pre-graduation, flushed once wired                  //
    // --------------------------------------------------------------------- //

    function test_fork_buybackDeferredThenFlushed() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (FeeRouter router, address token,) = _launchViaRouter(1000);

        // Fees can only accrue via a real swap, which needs a seeded pool, which
        // needs graduation — so simulate a pre-graduation fee arrival directly
        // (the deferral logic under test doesn't care WHERE the WETH came from).
        vm.prank(realCreator);
        router.scheduleSplit(0, 0, 10000, 0);
        vm.warp(block.timestamp + 7 days);
        deal(WETH, address(router), 1 ether);

        router.route(1 ether, 0, 0);
        assertEq(router.pendingBuybackWeth(), 1 ether);
        assertEq(MockRouterCheck(token).balanceOf(DEAD), 0);

        factory.graduate(token);
        router.wireBuybackPool();
        router.flushDeferredBuyback(0);

        assertEq(router.pendingBuybackWeth(), 0);
        assertGt(MockRouterCheck(token).balanceOf(DEAD), 0);
    }
}

/// @dev Minimal fixed-price Chainlink feed for the ETH/USD leg BallastFactory
///      requires at construction — WETH-quoted launches never actually read it
///      (see BallastFactory._p0Tick), but the constructor still needs an address.
contract FixedFeed {
    uint8 public constant decimals = 8;
    int256 internal immutable _answer;
    uint256 internal immutable _updatedAt;

    constructor(int256 answer_, uint256 updatedAt_) {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}

/// @dev BallastToken's full ABI isn't needed here, just what this file reads.
interface MockRouterCheck {
    function creator() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
