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
    RamsesLocker locker;
    BallastFeeSplitterFactory factory;
    RamsesLockLauncher launcher;

    MockERC20 tokenA; // sorts as token0 in our tests (address not actually sorted here — mock trusts caller order)
    MockERC20 tokenB;

    address safe = makeAddr("safe");
    address creator = makeAddr("creator");
    address caller = makeAddr("caller"); // the account funding createAndLock
    address launchedToken = makeAddr("launchedToken");
    address poolDeployer = makeAddr("poolDeployer");

    function setUp() public {
        pm = new MockRamsesPositionManager(poolDeployer);
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
        (uint256 tokenId, address splitter) = launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

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
        (uint256 tokenId,) = launcher.createAndLock(_legs(500 ether, 300 ether), launchedToken, creator, 8000, 2000);
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
        launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

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
        launcher.createAndLock(_legs(amount0, amount1), launchedToken, creator, 8000, 2000);

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
        (uint256 tokenId,) = launcher.createAndLock(legs, launchedToken, creator, 8000, 2000);
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
        (uint256 tokenId,) = launcher.createAndLock(legs, launchedToken, creator, 8000, 2000);
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
            launcher.createAndLock(_legs(1_000 ether, 1_000 ether), launchedToken, creator, 8000, 2000);

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
        (uint256 tokenId, address splitter) = launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

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
        (uint256 tokenId, address splitter) = launcher.createAndLock(_legs(1_000 ether, 0), launchedToken, creator, 8000, 2000);

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
}
