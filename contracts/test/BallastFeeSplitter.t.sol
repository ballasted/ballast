// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BallastFeeSplitter} from "../src/BallastFeeSplitter.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {BlockableERC20} from "./mocks/BlockableERC20.sol";
import {NoReturnERC20} from "./mocks/NoReturnERC20.sol";

contract BallastFeeSplitterTest is Test {
    uint256 constant BPS = 10_000;

    BallastFeeSplitterFactory factory;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 rewardToken;

    address safe = makeAddr("safe"); // protocolRecipient, baked into the factory
    address creatorRecipient = makeAddr("creatorRecipient");
    address launcher = makeAddr("launcher"); // simulated trusted-launcher caller
    address stranger = makeAddr("stranger");
    address locker = makeAddr("locker"); // informational only in these unit tests
    uint256 constant POSITION_ID = 42;

    function setUp() public {
        factory = new BallastFeeSplitterFactory(safe);
        tokenA = new MockERC20("TokenA", "A", 18);
        tokenB = new MockERC20("TokenB", "B", 18);
        rewardToken = new MockERC20("Reward", "RWD", 18);
    }

    function _deploySplitter(address token, uint16 creatorBps, uint16 protocolBps)
        internal
        returns (BallastFeeSplitter splitter)
    {
        vm.prank(launcher);
        splitter = BallastFeeSplitter(
            factory.createSplitter(token, locker, POSITION_ID, creatorRecipient, creatorBps, protocolBps)
        );
    }

    function _defaultSplitter() internal returns (BallastFeeSplitter) {
        return _deploySplitter(address(tokenA), 8000, 2000);
    }

    // --------------------------------------------------------------------- //
    //  Factory                                                               //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroProtocolRecipient_reverts() public {
        vm.expectRevert(BallastFeeSplitterFactory.ZeroAddress.selector);
        new BallastFeeSplitterFactory(address(0));
    }

    function test_createSplitter_initializesCorrectly() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        assertTrue(splitter.initialized());
        assertEq(splitter.token(), address(tokenA));
        assertEq(splitter.locker(), locker);
        assertEq(splitter.positionId(), POSITION_ID);
        assertEq(splitter.creatorRecipient(), creatorRecipient);
        assertEq(splitter.protocolRecipient(), safe);
        assertEq(splitter.creatorBps(), 8000);
        assertEq(splitter.protocolBps(), 2000);
    }

    function test_createSplitter_emitsEventWithCallerForLauncherRecognition() public {
        vm.expectEmit(false, true, true, false, address(factory));
        emit BallastFeeSplitterFactory.SplitterCreated(
            address(0), address(tokenA), POSITION_ID, locker, launcher, creatorRecipient, safe, 8000, 2000
        );
        vm.prank(launcher);
        factory.createSplitter(address(tokenA), locker, POSITION_ID, creatorRecipient, 8000, 2000);
    }

    function test_createSplitter_badSplit_reverts() public {
        vm.expectRevert(BallastFeeSplitter.BadSplit.selector);
        factory.createSplitter(address(tokenA), locker, POSITION_ID, creatorRecipient, 7000, 2000);
    }

    function test_createSplitter_zeroCreatorRecipient_reverts() public {
        vm.expectRevert(BallastFeeSplitter.ZeroAddress.selector);
        factory.createSplitter(address(tokenA), locker, POSITION_ID, address(0), 8000, 2000);
    }

    function test_createSplitter_permissionless_anyCallerCanDeployAnySplit() public {
        // No access control on the factory — approved design. A rogue 10000/0
        // splitter is fully functional but harmless until something real points
        // a locker's feeReceiver at it (see Phase 2 report, launcher design note).
        vm.prank(stranger);
        BallastFeeSplitter rogue = BallastFeeSplitter(
            factory.createSplitter(address(tokenA), locker, 999, creatorRecipient, 10_000, 0)
        );
        assertEq(rogue.creatorBps(), 10_000);
        assertEq(rogue.protocolBps(), 0);
    }

    function test_initialize_cannotBeCalledTwice() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.expectRevert(BallastFeeSplitter.AlreadyInitialized.selector);
        splitter.initialize(address(tokenA), locker, POSITION_ID, creatorRecipient, safe, 8000, 2000);
    }

    // --------------------------------------------------------------------- //
    //  distribute() — split math + dust                                     //
    // --------------------------------------------------------------------- //

    function test_distribute_splitsByBps() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        tokenA.mint(address(splitter), 10_000 ether);

        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(tokenA));

        assertEq(toCreator, 8_000 ether);
        assertEq(toProtocol, 2_000 ether);
        assertEq(tokenA.balanceOf(creatorRecipient), 8_000 ether);
        assertEq(tokenA.balanceOf(safe), 2_000 ether);
    }

    function test_distribute_dustGoesToCreator() public {
        // 10 wei at 8000/2000: protocol floor = (10*2000)/10000 = 2, creator = 8 (exact here).
        // Use an amount that does NOT divide evenly to force real dust.
        BallastFeeSplitter splitter = _defaultSplitter();
        tokenA.mint(address(splitter), 3); // 3 * 2000 / 10000 = 0 (floor) -> protocol 0, creator 3
        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(tokenA));
        assertEq(toProtocol, 0);
        assertEq(toCreator, 3);

        tokenA.mint(address(splitter), 9); // 9*2000/10000 = 1 (floor), creator = 8 (remainder, incl. dust)
        (uint256 toCreator2, uint256 toProtocol2) = splitter.distribute(address(tokenA));
        assertEq(toProtocol2, 1);
        assertEq(toCreator2, 8);
        assertEq(toCreator2 + toProtocol2, 9);
    }

    function test_distribute_zeroBalance_reverts() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.expectRevert(BallastFeeSplitter.NothingToDistribute.selector);
        splitter.distribute(address(tokenA));
    }

    function test_distribute_permissionless() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        tokenA.mint(address(splitter), 100 ether);
        vm.prank(stranger);
        splitter.distribute(address(tokenA));
        assertEq(tokenA.balanceOf(creatorRecipient), 80 ether);
        assertEq(tokenA.balanceOf(safe), 20 ether);
    }

    // --------------------------------------------------------------------- //
    //  Both legs of a pair + a reward token                                 //
    // --------------------------------------------------------------------- //

    function test_distribute_bothTokensOfPair() public {
        BallastFeeSplitter splitter = _defaultSplitter(); // token = tokenA, but distribute() is generic
        tokenA.mint(address(splitter), 1_000 ether);
        tokenB.mint(address(splitter), 500 ether);

        splitter.distribute(address(tokenA));
        splitter.distribute(address(tokenB));

        assertEq(tokenA.balanceOf(creatorRecipient), 800 ether);
        assertEq(tokenA.balanceOf(safe), 200 ether);
        assertEq(tokenB.balanceOf(creatorRecipient), 400 ether);
        assertEq(tokenB.balanceOf(safe), 100 ether);
    }

    function test_distribute_rewardToken() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        rewardToken.mint(address(splitter), 777 ether);

        splitter.distribute(address(rewardToken));

        assertEq(rewardToken.balanceOf(creatorRecipient), (777 ether * 8000) / BPS);
        assertEq(rewardToken.balanceOf(safe), (777 ether * 2000) / BPS);
    }

    function test_distribute_noReturnValueToken_treatedAsSuccess() public {
        NoReturnERC20 usdtLike = new NoReturnERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(usdtLike), 8000, 2000);
        usdtLike.mint(address(splitter), 1_000 ether);

        splitter.distribute(address(usdtLike));

        assertEq(usdtLike.balanceOf(creatorRecipient), 800 ether);
        assertEq(usdtLike.balanceOf(safe), 200 ether);
        assertEq(splitter.pending(address(usdtLike), BallastFeeSplitter.Role.Creator), 0);
        assertEq(splitter.pending(address(usdtLike), BallastFeeSplitter.Role.Protocol), 0);
    }

    // --------------------------------------------------------------------- //
    //  Blocked recipient must not block the other                          //
    // --------------------------------------------------------------------- //

    function test_distribute_blockedCreator_doesNotBlockProtocol() public {
        BlockableERC20 blk = new BlockableERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(blk), 8000, 2000);
        blk.mint(address(splitter), 1_000 ether);
        blk.setBlocked(creatorRecipient, true);

        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(blk));

        // Protocol's share still landed despite creator being blocked.
        assertEq(toCreator, 800 ether);
        assertEq(toProtocol, 200 ether);
        assertEq(blk.balanceOf(safe), 200 ether);
        assertEq(blk.balanceOf(creatorRecipient), 0);
        assertEq(splitter.pending(address(blk), BallastFeeSplitter.Role.Creator), 800 ether);
        assertEq(splitter.pending(address(blk), BallastFeeSplitter.Role.Protocol), 0);

        // Unblock and retry via withdraw — nothing was lost.
        blk.setBlocked(creatorRecipient, false);
        vm.prank(stranger); // permissionless retry
        splitter.withdraw(address(blk), BallastFeeSplitter.Role.Creator);
        assertEq(blk.balanceOf(creatorRecipient), 800 ether);
        assertEq(splitter.pending(address(blk), BallastFeeSplitter.Role.Creator), 0);
    }

    function test_distribute_blockedProtocol_doesNotBlockCreator() public {
        BlockableERC20 blk = new BlockableERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(blk), 8000, 2000);
        blk.mint(address(splitter), 1_000 ether);
        blk.setBlocked(safe, true);

        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(blk));

        assertEq(toCreator, 800 ether);
        assertEq(toProtocol, 200 ether);
        assertEq(blk.balanceOf(creatorRecipient), 800 ether);
        assertEq(splitter.pending(address(blk), BallastFeeSplitter.Role.Protocol), 200 ether);
    }

    // --------------------------------------------------------------------- //
    //  withdraw() — pull fallback, role-keyed                               //
    // --------------------------------------------------------------------- //

    function test_withdraw_nothingPending_reverts() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.expectRevert(BallastFeeSplitter.NothingToWithdraw.selector);
        splitter.withdraw(address(tokenA), BallastFeeSplitter.Role.Creator);
    }

    function test_withdraw_paysWhoeverCurrentlyHoldsTheRole() public {
        BlockableERC20 blk = new BlockableERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(blk), 8000, 2000);
        blk.mint(address(splitter), 1_000 ether);
        blk.setBlocked(creatorRecipient, true);
        splitter.distribute(address(blk)); // creator's 800 ether lands in `pending`, keyed by Role.Creator

        // Rotate creatorRecipient to a fresh address BEFORE the stuck credit is withdrawn.
        address newCreator = makeAddr("newCreator");
        vm.prank(creatorRecipient);
        splitter.setCreatorRecipient(newCreator);

        // Role-keyed pending now pays the NEW creator, not the old (still-blocked) one.
        splitter.withdraw(address(blk), BallastFeeSplitter.Role.Creator);
        assertEq(blk.balanceOf(newCreator), 800 ether);
        assertEq(blk.balanceOf(creatorRecipient), 0);
    }

    // --------------------------------------------------------------------- //
    //  Recipient rotation — access control                                  //
    // --------------------------------------------------------------------- //

    function test_setCreatorRecipient_onlyCurrentCreatorRecipient() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.expectRevert(BallastFeeSplitter.NotCreatorRecipient.selector);
        vm.prank(stranger);
        splitter.setCreatorRecipient(stranger);
    }

    function test_setCreatorRecipient_zeroAddress_reverts() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.prank(creatorRecipient);
        vm.expectRevert(BallastFeeSplitter.ZeroAddress.selector);
        splitter.setCreatorRecipient(address(0));
    }

    function test_setCreatorRecipient_updatesAndFutureDistributesPayNewAddress() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        address newCreator = makeAddr("newCreator");
        vm.prank(creatorRecipient);
        splitter.setCreatorRecipient(newCreator);
        assertEq(splitter.creatorRecipient(), newCreator);

        tokenA.mint(address(splitter), 100 ether);
        splitter.distribute(address(tokenA));
        assertEq(tokenA.balanceOf(newCreator), 80 ether);
        assertEq(tokenA.balanceOf(creatorRecipient), 0);
    }

    function test_setProtocolRecipient_onlyCurrentProtocolRecipient() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.expectRevert(BallastFeeSplitter.NotProtocolRecipient.selector);
        vm.prank(creatorRecipient); // not the protocol recipient
        splitter.setProtocolRecipient(stranger);
    }

    function test_setProtocolRecipient_currentHolderCanRotate() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        address newSafe = makeAddr("newSafe");
        vm.prank(safe);
        splitter.setProtocolRecipient(newSafe);
        assertEq(splitter.protocolRecipient(), newSafe);
    }

    function test_setProtocolRecipient_zeroAddress_reverts() public {
        BallastFeeSplitter splitter = _defaultSplitter();
        vm.prank(safe);
        vm.expectRevert(BallastFeeSplitter.ZeroAddress.selector);
        splitter.setProtocolRecipient(address(0));
    }

    // --------------------------------------------------------------------- //
    //  Reentrancy                                                           //
    // --------------------------------------------------------------------- //

    function test_reentrancy_distribute_attemptIsNeutralizedNotDoubled() public {
        ReentrantERC20 evil = new ReentrantERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(evil), 8000, 2000);
        evil.mint(address(splitter), 1_000 ether);

        // Reenter distribute() on the outbound transfer FROM the splitter. The
        // nested call hits nonReentrant and reverts, which reverts the ENTIRE
        // evil.transfer() call frame — including ReentrantERC20's own "one shot"
        // `armed = false` disarm, since EVM reverts roll back every state change
        // made during the reverted frame, not just the balance update. So
        // `armed` stays true across the rollback, and the attempt re-fires on
        // every subsequent outbound transfer in the same distribute() call, not
        // just the first — both the creator and protocol legs hit it here.
        // Either way, distribute()'s non-reverting push wrapper credits each
        // failed leg to `pending` instead of losing it or paying it twice.
        evil.arm(address(splitter), abi.encodeCall(BallastFeeSplitter.distribute, (address(evil))));

        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(evil));

        assertEq(toCreator, 800 ether);
        assertEq(toProtocol, 200 ether);
        assertEq(evil.balanceOf(creatorRecipient), 0); // push failed due to reentrancy revert
        assertEq(evil.balanceOf(safe), 0); // push failed due to reentrancy revert too (see above)
        assertEq(splitter.pending(address(evil), BallastFeeSplitter.Role.Creator), 800 ether);
        assertEq(splitter.pending(address(evil), BallastFeeSplitter.Role.Protocol), 200 ether);
        // Total accounted for, nothing lost or duplicated despite two reentrancy attempts:
        assertEq(
            evil.balanceOf(creatorRecipient) + evil.balanceOf(safe)
                + splitter.pending(address(evil), BallastFeeSplitter.Role.Creator)
                + splitter.pending(address(evil), BallastFeeSplitter.Role.Protocol),
            1_000 ether
        );
    }

    function test_reentrancy_withdraw_revertsWholeCallCleanly() public {
        ReentrantERC20 evil = new ReentrantERC20();
        BallastFeeSplitter splitter = _deploySplitter(address(evil), 8000, 2000);
        evil.mint(address(splitter), 1_000 ether);
        evil.arm(address(splitter), abi.encodeCall(BallastFeeSplitter.distribute, (address(evil))));
        splitter.distribute(address(evil)); // creator's 800 ether ends up pending (see test above)

        // Re-arm for the withdraw() path: withdraw uses SafeERC20.safeTransfer,
        // which REVERTS on failure (unlike distribute's non-reverting wrapper) —
        // so a reentrancy attempt during withdraw reverts the whole call, and
        // CEI (pending zeroed before the external call) means no state changes.
        evil.arm(address(splitter), abi.encodeCall(BallastFeeSplitter.withdraw, (address(evil), BallastFeeSplitter.Role.Creator)));
        uint256 pendingBefore = splitter.pending(address(evil), BallastFeeSplitter.Role.Creator);
        vm.expectRevert();
        splitter.withdraw(address(evil), BallastFeeSplitter.Role.Creator);
        assertEq(splitter.pending(address(evil), BallastFeeSplitter.Role.Creator), pendingBefore);
    }

    // --------------------------------------------------------------------- //
    //  Fuzz                                                                 //
    // --------------------------------------------------------------------- //

    function testFuzz_distribute_splitMath(uint256 bal, uint16 creatorBpsSeed) public {
        bal = bound(bal, 1, 1e30);
        uint16 creatorBps_ = uint16(bound(creatorBpsSeed, 0, BPS));
        uint16 protocolBps_ = uint16(BPS - creatorBps_);

        MockERC20 fuzzToken = new MockERC20("Fuzz", "FZZ", 18);
        BallastFeeSplitter splitter = _deploySplitter(address(fuzzToken), creatorBps_, protocolBps_);
        fuzzToken.mint(address(splitter), bal);

        (uint256 toCreator, uint256 toProtocol) = splitter.distribute(address(fuzzToken));

        assertEq(toCreator + toProtocol, bal, "no wei lost or created");
        assertEq(toProtocol, (bal * protocolBps_) / BPS, "protocol share matches floor division");
        assertEq(fuzzToken.balanceOf(creatorRecipient), toCreator);
        assertEq(fuzzToken.balanceOf(safe), toProtocol);
    }

    function testFuzz_createSplitter_badSplitReverts(uint16 creatorBps_, uint16 protocolBps_) public {
        vm.assume(uint256(creatorBps_) + protocolBps_ != BPS);
        vm.expectRevert(BallastFeeSplitter.BadSplit.selector);
        factory.createSplitter(address(tokenA), locker, POSITION_ID, creatorRecipient, creatorBps_, protocolBps_);
    }

    // Full-flow coverage against a real locker (mint -> lock -> collect ->
    // distribute, both legs, gauge rewards, setFeeReceiver access control) now
    // lives in test/RamsesLockLauncher.t.sol against the REAL (vendored)
    // RamsesLocker.sol + RamsesLockLauncher.sol, not a hand-rolled mock locker
    // whose collect() shape (per-token sweep) no longer matches the real
    // contract's collect(tokenId) (pays both legs directly to the receiver in
    // one call). See that file and contracts/lib/ramses-v3-contracts/VENDORED.md.
}
