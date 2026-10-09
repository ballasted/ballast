// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from
    "../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";
import {RamsesLocker} from "../lib/ramses-v3-contracts/contracts/RamsesLocker.sol";
import {RamsesLockLauncher} from "../src/RamsesLockLauncher.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";
import {BallastFeeSplitter} from "../src/BallastFeeSplitter.sol";
import {MockRamsesPositionManager} from "./mocks/MockRamsesPositionManager.sol";
import {MockRamsesVoter} from "./mocks/MockRamsesVoter.sol";
import {MockRamsesV3PoolDeployer} from "./mocks/MockRamsesV3PoolDeployer.sol";
import {MockRamsesV3Factory} from "./mocks/MockRamsesV3Factory.sol";
import {MockRamsesV3Pool} from "./mocks/MockRamsesV3Pool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {NoReturnERC20} from "./mocks/NoReturnERC20.sol";

/// @notice Unit + fuzz + invariant coverage for RamsesLockLauncher and the
///         REAL (vendored, pinned) RamsesLocker.sol — against
///         MockRamsesPositionManager, our own deterministic stand-in (see
///         that file's header for why it isn't the authoritative proof).
///         The authoritative proof against Ramses' actual deployed
///         infrastructure is test/BallastFeeSplitterFork.t.sol.
contract RamsesLockLauncherTest is Test {
    uint256 constant BPS = 10_000;

    MockRamsesPositionManager pm;
    MockRamsesVoter voter;
    MockRamsesV3Factory v3Factory;
    RamsesLocker locker;
    BallastFeeSplitterFactory factory;
    RamsesLockLauncher launcher;

    MockERC20 tokenA; // sorts as token0 in our tests (address not actually sorted here — mock trusts caller order)
    MockERC20 tokenB;

    // 1:1 price (sqrtPriceX96 = 2^96) -- the fixed price every happy-path test
    // in this file creates its pool at. Each test gets a fresh MockRamsesV3Factory
    // (new setUp() per test), so the first createAndLock on any given token pair
    // always hits the "pool doesn't exist yet" branch and creates it at this price.
    uint160 constant PRICE_1_TO_1 = 1 << 96;

    address safe = makeAddr("safe");
    address creator = makeAddr("creator");
    address caller = makeAddr("caller"); // the account funding createAndLock
    // Set in setUp() to address(tokenA) -- must be legs.token0 or legs.token1
    // (RamsesLockLauncher.LaunchedTokenMismatch), so it can't be a field
    // initializer (tokenA doesn't exist yet at that point).
    address launchedToken;

    function setUp() public {
        v3Factory = new MockRamsesV3Factory();
        MockRamsesV3PoolDeployer poolDeployer = new MockRamsesV3PoolDeployer(address(v3Factory));
        pm = new MockRamsesPositionManager(address(poolDeployer));
        voter = new MockRamsesVoter();
        locker = new RamsesLocker(address(pm), address(voter));
        factory = new BallastFeeSplitterFactory(safe);
        launcher = new RamsesLockLauncher(address(pm), address(locker), address(factory));

        tokenA = new MockERC20("TokenA", "A", 18);
        tokenB = new MockERC20("TokenB", "B", 18);
        // PoolAddress.computeAddress requires token0 < token1 (same convention
        // real Ramses/Uniswap V3 callers must follow) — `legs()` below treats
        // tokenA as token0, so enforce that ordering here regardless of each
        // mock's deployed address.
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);
        launchedToken = address(tokenA);
    }

    function _legs(uint256 amount0, uint256 amount1) internal view returns (RamsesLockLauncher.MintLegs memory) {
        return RamsesLockLauncher.MintLegs({
            token0: address(tokenA),
            token1: address(tokenB),
            tickSpacing: 60,
            tickLower: -60,
            tickUpper: 60,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1
        });
    }

    /// @dev Every existing happy-path test creates its pool fresh at
    ///      PRICE_1_TO_1 (via `_ensurePoolPrice`'s "doesn't exist yet" branch),
    ///      so 0 deviation is correct — there's nothing yet to deviate from.
    function _createAndLock(
        RamsesLockLauncher.MintLegs memory legs,
        address launchedToken_,
        address creatorRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    ) internal returns (uint256 tokenId, address splitter) {
        return launcher.createAndLock(legs, launchedToken_, creatorRecipient, creatorBps, protocolBps, PRICE_1_TO_1, 0);
    }

    function _sorted(address x, address y) internal pure returns (address, address) {
        return x < y ? (x, y) : (y, x);
    }

    function _fundAndApprove(uint256 amount0, uint256 amount1) internal {
        tokenA.mint(caller, amount0);
        tokenB.mint(caller, amount1);
        vm.startPrank(caller);
        tokenA.approve(address(launcher), amount0);
        tokenB.approve(address(launcher), amount1);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------- //
    //  Constructor                                                           //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(RamsesLockLauncher.ZeroAddress.selector);
        new RamsesLockLauncher(address(0), address(locker), address(factory));
        vm.expectRevert(RamsesLockLauncher.ZeroAddress.selector);
        new RamsesLockLauncher(address(pm), address(0), address(factory));
        vm.expectRevert(RamsesLockLauncher.ZeroAddress.selector);
        new RamsesLockLauncher(address(pm), address(locker), address(0));
    }

    // --------------------------------------------------------------------- //
    //  createAndLock — happy path, single-sided (matches a real launch)     //
    // --------------------------------------------------------------------- //

    function test_createAndLock_singleSided_locksToFreshSplitter() public {
        _fundAndApprove(1_000 ether, 0);

        vm.prank(caller);
        (uint256 tokenId, address splitter) = _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        assertEq(pm.ownerOf(tokenId), address(locker), "locker must own the NFT after lock()");
        assertEq(locker.feeReceiverOf(tokenId), splitter);
        assertEq(BallastFeeSplitter(splitter).creatorRecipient(), creator);
        assertEq(BallastFeeSplitter(splitter).protocolRecipient(), safe);
        assertEq(BallastFeeSplitter(splitter).creatorBps(), 8000);

        // The launcher itself never ends up holding the NFT or either token.
        assertEq(IERC20(tokenA).balanceOf(address(launcher)), 0);
        assertEq(IERC20(tokenB).balanceOf(address(launcher)), 0);
    }

    function test_createAndLock_bothLegs() public {
        _fundAndApprove(500 ether, 300 ether);
        vm.prank(caller);
        (uint256 tokenId,) = _createAndLock(_legs(500 ether, 300 ether), launchedToken, creator, 8000, 2000);
        assertEq(pm.ownerOf(tokenId), address(locker));
        assertEq(tokenA.balanceOf(address(launcher)), 0);
        assertEq(tokenB.balanceOf(address(launcher)), 0);
    }

    // --------------------------------------------------------------------- //
    //  Dust refund — mint() uses less than desired                          //
    // --------------------------------------------------------------------- //

    function test_createAndLock_mintShortfall_refundsDustToCaller() public {
        pm.setMintShortfallBps(1000); // mint() will only use 90% of desired
        _fundAndApprove(1_000 ether, 0);

        uint256 callerBalBefore = tokenA.balanceOf(caller);
        vm.prank(caller);
        _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        // 10% dust (100 ether) must have been refunded to caller, not stuck in the launcher.
        assertEq(tokenA.balanceOf(caller), callerBalBefore - 900 ether);
        assertEq(tokenA.balanceOf(address(launcher)), 0);
    }

    function testFuzz_createAndLock_neverLeavesBalanceInLauncher(uint256 amount0, uint256 amount1, uint256 shortfallBps)
        public
    {
        amount0 = bound(amount0, 0, 1e24);
        amount1 = bound(amount1, 0, 1e24);
        vm.assume(amount0 > 0 || amount1 > 0);
        shortfallBps = bound(shortfallBps, 0, 10_000);

        pm.setMintShortfallBps(shortfallBps);
        _fundAndApprove(amount0, amount1);

        vm.prank(caller);
        _createAndLock(_legs(amount0, amount1), launchedToken, creator, 8000, 2000);

        assertEq(tokenA.balanceOf(address(launcher)), 0, "token0 invariant");
        assertEq(tokenB.balanceOf(address(launcher)), 0, "token1 invariant");
    }

    function test_createAndLock_feeOnTransferToken_usesActualReceivedAmount() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(500); // 5% fee
        fot.mint(caller, 1_000 ether);
        vm.prank(caller);
        fot.approve(address(launcher), 1_000 ether);

        bool fotIsToken0 = address(fot) < address(tokenB);
        (address t0, address t1) = _sorted(address(fot), address(tokenB));
        RamsesLockLauncher.MintLegs memory legs = RamsesLockLauncher.MintLegs({
            token0: t0,
            token1: t1,
            tickSpacing: 60,
            tickLower: -60,
            tickUpper: 60,
            // launcher only actually RECEIVES 950 ether of `fot` after the transfer fee
            amount0Desired: fotIsToken0 ? 1_000 ether : 0,
            amount1Desired: fotIsToken0 ? 0 : 1_000 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1
        });

        // The launcher pulls by actual balance delta (950 ether), not the
        // requested 1000 — so the mint uses 950, not a reverting/incorrect 1000.
        vm.prank(caller);
        (uint256 tokenId,) = _createAndLock(legs, address(fot), creator, 8000, 2000);
        assertEq(pm.ownerOf(tokenId), address(locker));
        assertEq(fot.balanceOf(address(launcher)), 0, "no stuck balance");
    }

    function test_createAndLock_noReturnValueToken_works() public {
        NoReturnERC20 usdtLike = new NoReturnERC20();
        usdtLike.mint(caller, 1_000 ether);
        vm.prank(caller);
        usdtLike.approve(address(launcher), 1_000 ether);

        bool usdtIsToken0 = address(usdtLike) < address(tokenB);
        (address t0, address t1) = _sorted(address(usdtLike), address(tokenB));
        RamsesLockLauncher.MintLegs memory legs = RamsesLockLauncher.MintLegs({
            token0: t0,
            token1: t1,
            tickSpacing: 60,
            tickLower: -60,
            tickUpper: 60,
            amount0Desired: usdtIsToken0 ? 1_000 ether : 0,
            amount1Desired: usdtIsToken0 ? 0 : 1_000 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1
        });
        vm.prank(caller);
        (uint256 tokenId,) = _createAndLock(legs, address(usdtLike), creator, 8000, 2000);
        assertEq(pm.ownerOf(tokenId), address(locker));
        assertEq(usdtLike.balanceOf(address(launcher)), 0);
    }

    // --------------------------------------------------------------------- //
    //  Real locker semantics: collect() pays BOTH legs directly to the      //
    //  splitter in one call (NOT a per-token sweep like the retired mock)   //
    // --------------------------------------------------------------------- //

    function test_realLocker_collect_paysBothLegsDirectlyToSplitter() public {
        _fundAndApprove(1_000 ether, 1_000 ether);
        vm.prank(caller);
        (uint256 tokenId, address splitter) =
            _createAndLock(_legs(1_000 ether, 1_000 ether), launchedToken, creator, 8000, 2000);

        address trader = makeAddr("trader");
        tokenA.mint(trader, 100 ether);
        tokenB.mint(trader, 40 ether);
        vm.startPrank(trader);
        tokenA.approve(address(pm), 100 ether);
        tokenB.approve(address(pm), 40 ether);
        pm.accrueFees(tokenId, 100 ether, 40 ether);
        vm.stopPrank();

        // Permissionless — anyone may call collect(), and it pays BOTH legs in one shot.
        vm.prank(makeAddr("stranger"));
        (uint256 c0, uint256 c1) = locker.collect(tokenId);
        assertEq(c0, 100 ether);
        assertEq(c1, 40 ether);
        assertEq(tokenA.balanceOf(splitter), 100 ether);
        assertEq(tokenB.balanceOf(splitter), 40 ether);

        BallastFeeSplitter(splitter).distribute(address(tokenA));
        BallastFeeSplitter(splitter).distribute(address(tokenB));
        assertEq(tokenA.balanceOf(creator), 80 ether);
        assertEq(tokenA.balanceOf(safe), 20 ether);
        assertEq(tokenB.balanceOf(creator), 32 ether);
        assertEq(tokenB.balanceOf(safe), 8 ether);
    }

    function test_realLocker_collect_revertsIfNotLocked() public {
        vm.expectRevert(RamsesLocker.NotLocked.selector);
        locker.collect(999);
    }

    // --------------------------------------------------------------------- //
    //  Real locker semantics: collectRewards() forwards only the NEW delta  //
    // --------------------------------------------------------------------- //

    function test_realLocker_collectRewards_forwardsOnlyNewDelta() public {
        _fundAndApprove(1_000 ether, 0);
        vm.prank(caller);
        (uint256 tokenId, address splitter) = _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        MockERC20 reward = new MockERC20("Reward", "RWD", 18);
        reward.mint(address(this), 777 ether);
        reward.approve(address(voter), 777 ether);
        voter.fundRewards(address(reward), 777 ether);

        address[] memory tokens = new address[](1);
        tokens[0] = address(reward);
        vm.prank(makeAddr("stranger"));
        uint256[] memory amounts = locker.collectRewards(tokenId, tokens);

        assertEq(amounts[0], 777 ether);
        assertEq(reward.balanceOf(splitter), 777 ether);
        assertEq(reward.balanceOf(address(locker)), 0, "locker must not retain reward tokens");

        // A second claim with nothing newly funded forwards zero, not a stale replay.
        vm.prank(makeAddr("stranger"));
        uint256[] memory amounts2 = locker.collectRewards(tokenId, tokens);
        assertEq(amounts2[0], 0);
    }

    // --------------------------------------------------------------------- //
    //  setFeeReceiver — only the CURRENT receiver, and the splitter never   //
    //  calls it (confirmed by code inspection: BallastFeeSplitter.sol       //
    //  imports no locker interface and has no call site referencing it)    //
    // --------------------------------------------------------------------- //

    function test_realLocker_setFeeReceiver_onlyCurrentReceiver() public {
        _fundAndApprove(1_000 ether, 0);
        vm.prank(caller);
        (uint256 tokenId, address splitter) = _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(RamsesLocker.NotAuthorized.selector);
        locker.setFeeReceiver(tokenId, makeAddr("stranger"));

        // Even the splitter's OWN creatorRecipient/protocolRecipient cannot call
        // this — only msg.sender == feeReceiverOf[tokenId] (the splitter CONTRACT
        // itself) can, and the splitter contract has no function that does so.
        vm.prank(creator);
        vm.expectRevert(RamsesLocker.NotAuthorized.selector);
        locker.setFeeReceiver(tokenId, creator);

        assertEq(locker.feeReceiverOf(tokenId), splitter, "receiver never moved");
    }

    // --------------------------------------------------------------------- //
    //  lock() NFT-custody assumption: direct transferFrom bypassing lock()  //
    //  leaves the NFT un-tracked ("stuck", per RamsesLocker's own doc)      //
    // --------------------------------------------------------------------- //

    function test_nftSentDirectly_bypassingLock_isNotTrackedAsLocked() public {
        _fundAndApprove(1_000 ether, 0);
        // Mint directly (not through the launcher) to simulate an owner who
        // transfers the raw NFT instead of calling lock().
        tokenA.mint(address(this), 1_000 ether);
        tokenA.approve(address(pm), 1_000 ether);
        (uint256 tokenId,,,) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: address(tokenA),
                token1: address(tokenB),
                tickSpacing: 60,
                tickLower: -60,
                tickUpper: 60,
                amount0Desired: 1_000 ether,
                amount1Desired: 0,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp + 1
            })
        );
        pm.transferFrom(address(this), address(locker), tokenId);

        assertFalse(locker.isLocked(tokenId), "a bare transferFrom must not register a lock");
        vm.expectRevert(RamsesLocker.NotLocked.selector);
        locker.collect(tokenId);
    }

    // --------------------------------------------------------------------- //
    //  Pool-init price protection (_ensurePoolPrice) — ADVERSARIAL FIRST     //
    // --------------------------------------------------------------------- //

    function test_constructor_derivesV3FactoryFromPositionManager() public view {
        assertEq(address(launcher.v3Factory()), address(v3Factory));
    }

    function test_createAndLock_deviationExceedsCeiling_reverts() public {
        _fundAndApprove(1_000 ether, 0);
        uint16 tooWide = launcher.MAX_PRICE_DEVIATION_BPS() + 1;
        vm.prank(caller);
        vm.expectRevert(RamsesLockLauncher.DeviationTooWide.selector);
        launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000, PRICE_1_TO_1, tooWide);
    }

    /// @notice Front-run scenario: someone else already created the pool at a
    ///         wildly different price before this call lands. Must refuse to
    ///         mint, not silently lock liquidity in at a price the caller
    ///         never agreed to.
    function test_createAndLock_existingPoolOutsideTolerance_reverts() public {
        _fundAndApprove(2_000 ether, 0);

        // First call creates the real (mock) pool at PRICE_1_TO_1.
        vm.prank(caller);
        _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        // Second call on the SAME pair "expects" 2x that price, tight tolerance
        // — the pool's actual price hasn't moved, so this must revert.
        uint160 wrongExpected = PRICE_1_TO_1 * 2;
        uint256 lower = (uint256(wrongExpected) * 9_900) / 10_000;
        uint256 upper = (uint256(wrongExpected) * 10_100) / 10_000;
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(RamsesLockLauncher.PoolPriceOutOfBounds.selector, PRICE_1_TO_1, lower, upper)
        );
        launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000, wrongExpected, 100);

        // The reverted second attempt pulled nothing.
        assertEq(tokenA.balanceOf(address(launcher)), 0);
    }

    function test_createAndLock_existingPoolWithinTolerance_succeeds() public {
        _fundAndApprove(2_000 ether, 0);

        vm.prank(caller);
        _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        // Second call, same pair, same price, exact match (0 tolerance) — must succeed.
        vm.prank(caller);
        (uint256 tokenId2,) =
            launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000, PRICE_1_TO_1, 0);
        assertEq(pm.ownerOf(tokenId2), address(locker));
    }

    function test_createAndLock_poolDoesNotExist_createsItAtExpectedPrice() public {
        _fundAndApprove(1_000 ether, 0);
        assertEq(v3Factory.getPool(address(tokenA), address(tokenB), 60), address(0), "precondition: no pool yet");

        vm.prank(caller);
        _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        address pool = v3Factory.getPool(address(tokenA), address(tokenB), 60);
        assertTrue(pool != address(0), "launcher must have created the pool itself");
        assertEq(MockRamsesV3Pool(pool).sqrtPriceX96(), PRICE_1_TO_1);
    }

    /// @notice Defensive branch in the real contract (Ramses' own factory's
    ///         createPool always initializes) — reachable here only via the
    ///         mock's forceRegister test hook, which deliberately produces a
    ///         pool that exists but was never initialized (price == 0).
    function test_createAndLock_existingButUninitializedPool_getsInitialized() public {
        MockRamsesV3Pool uninitialized = new MockRamsesV3Pool(0, 0);
        v3Factory.forceRegister(address(tokenA), address(tokenB), 60, address(uninitialized));

        _fundAndApprove(1_000 ether, 0);
        vm.prank(caller);
        _createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

        assertEq(uninitialized.sqrtPriceX96(), PRICE_1_TO_1, "launcher must initialize the uninitialized pool");
    }

    // --------------------------------------------------------------------- //
    //  launchedToken must actually be one of the position's legs            //
    // --------------------------------------------------------------------- //

    /// @notice ADVERSARIAL: a position must never be emitted (discoverable)
    ///         under a token it isn't actually paired with — e.g. a stranger
    ///         minting a tokenA/tokenB position while naming an unrelated
    ///         token as `launchedToken`, which the frontend would otherwise
    ///         have to trust blindly when discovering positions by event.
    function test_createAndLock_launchedTokenNotAPositionLeg_reverts() public {
        _fundAndApprove(1_000 ether, 0);
        address unrelated = makeAddr("unrelatedToken");

        vm.prank(caller);
        vm.expectRevert(RamsesLockLauncher.LaunchedTokenMismatch.selector);
        launcher.createAndLock(_legs(1_000 ether, 0), unrelated, creator, 8000, 2000, PRICE_1_TO_1, 0);

        // Nothing was pulled from the caller on the reverted attempt.
        assertEq(tokenA.balanceOf(address(launcher)), 0);
    }

    function test_createAndLock_launchedTokenIsToken1_succeeds() public {
        _fundAndApprove(1_000 ether, 0);
        vm.prank(caller);
        (uint256 tokenId,) =
            launcher.createAndLock(_legs(1_000 ether, 0), address(tokenB), creator, 8000, 2000, PRICE_1_TO_1, 0);
        assertEq(pm.ownerOf(tokenId), address(locker));
    }
}
