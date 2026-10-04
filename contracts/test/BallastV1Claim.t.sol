// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BallastV1Claim} from "../src/BallastV1Claim.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Adversarial-first tests for BallastV1Claim. Tree is a fixed 4-leaf
/// tree built off-chain (data/snapshot/build_merkle.cjs's exact algorithm,
/// reproduced by hand here for 4 known vm.addr(n) addresses) — see the
/// constants below for the derivation. Re-derive with:
///   node -e "... see contracts/test/BallastV1Claim.t.sol history ..."
/// if any of the fixture values below ever need to change.
contract BallastV1ClaimTest is Test {
    BallastV1Claim claimC;
    MockERC20 v1;

    address alice = vm.addr(1); // 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    address bob = vm.addr(2); // 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF
    address carol = vm.addr(3); // 0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69
    address dave = vm.addr(4); // 0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718
    address sweepTo = makeAddr("safe");

    // claimToken's swap infra is exercised end-to-end only in the mainnet fork
    // suite (BallastV1ClaimFork.t.sol), against the real WETH/BALLAST v2 pool.
    // Here these are just non-zero placeholders so the constructor's zero-
    // address guards and the one-path-per-holder lock (which reverts before
    // ever touching swap infra) can be tested without a real router/pool.
    address ballastV2 = makeAddr("ballastV2");
    address weth = makeAddr("weth");
    address universalRouter = makeAddr("universalRouter");
    address permit2 = makeAddr("permit2");
    address hook = makeAddr("hook");

    bytes32 constant ROOT = 0x5ea4a70e41505a7a7959a862d806722968399a068f962e2d8e48e415939b35ba;

    uint256 constant ALICE_BAL = 1000e18;
    uint256 constant ALICE_ETH = 1e18;
    uint256 constant BOB_BAL = 2000e18;
    uint256 constant BOB_ETH = 2e18;
    uint256 constant CAROL_BAL = 500e18;
    uint256 constant CAROL_ETH = 0.5e18;
    uint256 constant DAVE_BAL = 100e18;
    uint256 constant DAVE_ETH = 0.1e18;

    uint256 deadline;

    function aliceProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x5d7b5512bbacf80736cf2aac8807be3f83413f5e32e43dcd3b1bcd75f841fb3c;
        p[1] = 0x0335eeca444b0c452a0be6971cf022f48ff525544cf0d36565c6447a4b2ec0f7;
    }

    function bobProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0xbf65f9001e8f1e44cf22017e501c67ea1b976df8cd60481d4073e86ec7137c39;
        p[1] = 0x0335eeca444b0c452a0be6971cf022f48ff525544cf0d36565c6447a4b2ec0f7;
    }

    function carolProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x86d8072b6424721878fa9666bc42795702353da1b8103069cd7c71abb5182899;
        p[1] = 0x086b6dcc7a74ac253f1b8a536be5ea25de3a68c1e1607b2d3191ec9d49d95da0;
    }

    function daveProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x611b28d86710f8e40437f68ed1d1d07f9466c7e6783bd8776e62ab1c6e33001c;
        p[1] = 0x086b6dcc7a74ac253f1b8a536be5ea25de3a68c1e1607b2d3191ec9d49d95da0;
    }

    function setUp() public {
        v1 = new MockERC20("Ballast", "BALLAST", 18);
        deadline = block.timestamp + 30 days;
        claimC = new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, ballastV2, weth, universalRouter, permit2, hook);

        v1.mint(alice, ALICE_BAL);
        v1.mint(bob, BOB_BAL);
        v1.mint(carol, CAROL_BAL);
        v1.mint(dave, DAVE_BAL);

        // Fund the contract with the exact total budget for these 4 leaves.
        vm.deal(address(this), 100 ether);
        (bool ok,) = address(claimC).call{value: ALICE_ETH + BOB_ETH + CAROL_ETH + DAVE_ETH}("");
        require(ok);

        vm.prank(alice);
        v1.approve(address(claimC), type(uint256).max);
        vm.prank(bob);
        v1.approve(address(claimC), type(uint256).max);
        vm.prank(carol);
        v1.approve(address(claimC), type(uint256).max);
        vm.prank(dave);
        v1.approve(address(claimC), type(uint256).max);
    }

    // ── Happy paths ──────────────────────────────────────────────────────

    function test_claim_full_oneShot() public {
        vm.prank(alice);
        uint256 paid = claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
        assertEq(paid, ALICE_ETH);
        assertEq(alice.balance, ALICE_ETH);
        assertEq(v1.balanceOf(claimC.DEAD()), ALICE_BAL);
        assertEq(claimC.burnedOf(alice), ALICE_BAL);
    }

    function test_claim_partial_thenRest_sumsExactlyToEthAmount() public {
        vm.startPrank(bob);
        uint256 paid1 = claimC.claimETH(BOB_BAL / 2, BOB_BAL, BOB_ETH, bobProof());
        uint256 paid2 = claimC.claimETH(BOB_BAL - BOB_BAL / 2, BOB_BAL, BOB_ETH, bobProof());
        vm.stopPrank();
        assertEq(paid1 + paid2, BOB_ETH, "no dust lost across partial claims that sum to full balance");
        assertEq(bob.balance, BOB_ETH);
        assertEq(v1.balanceOf(claimC.DEAD()), BOB_BAL);
    }

    function test_claim_manySmallPartials_sumsExactlyToEthAmount() public {
        uint256 chunk = DAVE_BAL / 7; // odd division on purpose -- rounding-dust probe
        uint256 totalPaid;
        vm.startPrank(dave);
        for (uint256 i = 0; i < 7; i++) {
            totalPaid += claimC.claimETH(chunk, DAVE_BAL, DAVE_ETH, daveProof());
        }
        // Sweep the dust remainder (7*chunk < DAVE_BAL by integer division).
        uint256 remainder = DAVE_BAL - chunk * 7;
        if (remainder > 0) totalPaid += claimC.claimETH(remainder, DAVE_BAL, DAVE_ETH, daveProof());
        vm.stopPrank();
        assertEq(totalPaid, DAVE_ETH, "7-way partial claim still sums to exactly the full entitlement");
        assertEq(claimC.burnedOf(dave), DAVE_BAL);
    }

    // ── Adversarial ──────────────────────────────────────────────────────

    function test_claim_wrongProof_reverts() public {
        vm.prank(alice);
        vm.expectRevert(BallastV1Claim.InvalidProof.selector);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, bobProof());
    }

    function test_claim_wrongAmounts_withRightProofShape_reverts() public {
        // Alice's proof is only valid for HER (balance, ethAmount) pair -- lying
        // about the amounts (e.g. claiming Bob's larger entitlement) must fail,
        // not just lying about the proof array.
        vm.prank(alice);
        vm.expectRevert(BallastV1Claim.InvalidProof.selector);
        claimC.claimETH(ALICE_BAL, BOB_BAL, BOB_ETH, aliceProof());
    }

    function test_claim_byNonLeafAddress_reverts() public {
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(BallastV1Claim.InvalidProof.selector);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
    }

    function test_claim_doubleClaim_afterFull_reverts() public {
        vm.startPrank(alice);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.expectRevert(BallastV1Claim.AlreadyFullyClaimed.selector);
        claimC.claimETH(1, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.stopPrank();
    }

    function test_claim_afterDeadline_reverts() public {
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(BallastV1Claim.DeadlinePassed.selector);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
    }

    function test_claim_requestingMoreThanRemaining_clampsNotOverpays() public {
        // Ask for 10x the snapshot balance in one call -- must clamp to
        // exactly ALICE_BAL burned and ALICE_ETH paid, never more.
        vm.prank(alice);
        uint256 paid = claimC.claimETH(ALICE_BAL * 10, ALICE_BAL, ALICE_ETH, aliceProof());
        assertEq(paid, ALICE_ETH);
        assertEq(v1.balanceOf(claimC.DEAD()), ALICE_BAL, "never burns more than the snapshot balance");
        assertEq(alice.balance, ALICE_ETH, "never pays more than ethAmount");
    }

    function test_claim_zeroAmount_afterAlreadyFull_reverts() public {
        vm.startPrank(alice);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.expectRevert(BallastV1Claim.AlreadyFullyClaimed.selector);
        claimC.claimETH(0, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.stopPrank();
    }

    /// @notice "Sold after the snapshot -> less": Carol only holds a THIRD of
    /// her snapshot balance (sold the rest before claiming). She can only ever
    /// burn what she actually holds, which caps her real entitlement below
    /// 100% forever -- no explicit balance check needed in the contract, plain
    /// ERC20 transferFrom enforces it.
    function test_soldAfterSnapshot_capsEntitlementBelowFull() public {
        uint256 held = CAROL_BAL / 3;
        vm.prank(carol);
        v1.transfer(makeAddr("buyer"), CAROL_BAL - held); // Carol sells 2/3 of her v1

        vm.prank(carol);
        uint256 paid = claimC.claimETH(held, CAROL_BAL, CAROL_ETH, carolProof());
        assertEq(paid, (CAROL_ETH * held) / CAROL_BAL, "proportional to what she actually burned");
        assertLt(paid, CAROL_ETH, "can never reach full entitlement having sold most of her v1");

        // Trying to claim the rest reverts because she doesn't hold it anymore
        // (plain ERC20 insufficient-balance revert from the token, not a
        // custom error from this contract -- confirms no shortcut exists).
        vm.prank(carol);
        vm.expectRevert();
        claimC.claimETH(CAROL_BAL - held, CAROL_BAL, CAROL_ETH, carolProof());
    }

    /// @notice "Bought MORE after -> nothing extra": Dave buys additional v1
    /// far beyond his snapshot balance, then claims. He can still only ever
    /// burn up to DAVE_BAL and receive up to DAVE_ETH -- the clamp in `claim`
    /// (not his real balance) is what bounds it.
    function test_boughtMoreAfterSnapshot_getsNothingExtra() public {
        v1.mint(dave, DAVE_BAL * 100); // Dave now holds 101x his snapshot balance
        vm.prank(dave);
        uint256 paid = claimC.claimETH(DAVE_BAL * 101, DAVE_BAL, DAVE_ETH, daveProof());
        assertEq(paid, DAVE_ETH, "capped at the snapshot entitlement despite holding much more");
        assertEq(v1.balanceOf(claimC.DEAD()), DAVE_BAL, "only the snapshot amount is ever burned, not the extra");
    }

    // ── Sweep ────────────────────────────────────────────────────────────

    function test_sweep_beforeDeadline_reverts() public {
        vm.expectRevert(BallastV1Claim.DeadlineNotYetPassed.selector);
        claimC.sweep();
    }

    function test_sweep_afterDeadline_sendsExactRemainder() public {
        // Only Alice and Bob claim; Carol and Dave's ETH is never claimed.
        vm.prank(alice);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());

        vm.warp(deadline);
        uint256 expectedRemainder = BOB_ETH + CAROL_ETH + DAVE_ETH;
        uint256 sweptAmount = claimC.sweep();
        assertEq(sweptAmount, expectedRemainder);
        assertEq(sweepTo.balance, expectedRemainder);
        assertEq(address(claimC).balance, 0);
    }

    function test_sweep_isPermissionless_anyCallerCanTrigger() public {
        vm.warp(deadline);
        vm.prank(makeAddr("randomStranger"));
        uint256 swept = claimC.sweep();
        assertEq(swept, ALICE_ETH + BOB_ETH + CAROL_ETH + DAVE_ETH);
        assertEq(sweepTo.balance, swept);
    }

    function test_sweep_zeroBalance_noopNoRevert() public {
        vm.warp(deadline);
        claimC.sweep();
        assertEq(address(claimC).balance, 0);
        uint256 second = claimC.sweep(); // already empty -- must not revert
        assertEq(second, 0);
    }

    function test_sweep_afterDeadline_thenLateClaim_stillWorksIfFunded() public {
        // Claims remain valid after the deadline is irrelevant here -- claim()
        // itself hard-reverts post-deadline regardless of contract balance.
        // This test documents that a claim strictly cannot happen once the
        // sweep window opens, even if funds are still sitting there.
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(BallastV1Claim.DeadlinePassed.selector);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
    }

    // ── Invariants ───────────────────────────────────────────────────────

    function test_v1_neverHeldByContract_acrossEveryPath() public {
        vm.prank(alice);
        claimC.claimETH(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.prank(bob);
        claimC.claimETH(BOB_BAL / 2, BOB_BAL, BOB_ETH, bobProof());
        assertEq(v1.balanceOf(address(claimC)), 0, "the claim contract must never hold v1 at any point");
    }

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(0), ROOT, deadline, sweepTo, ballastV2, weth, universalRouter, permit2, hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, address(0), ballastV2, weth, universalRouter, permit2, hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, address(0), weth, universalRouter, permit2, hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, ballastV2, address(0), universalRouter, permit2, hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, ballastV2, weth, address(0), permit2, hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, ballastV2, weth, universalRouter, address(0), hook);
        vm.expectRevert(BallastV1Claim.ZeroAddress.selector);
        new BallastV1Claim(address(v1), ROOT, deadline, sweepTo, ballastV2, weth, universalRouter, permit2, address(0));
    }

    // ── One path per holder ──────────────────────────────────────────────

    function test_ethThenToken_sameHolder_reverts() public {
        vm.startPrank(alice);
        claimC.claimETH(ALICE_BAL / 2, ALICE_BAL, ALICE_ETH, aliceProof());
        vm.expectRevert(BallastV1Claim.WrongPath.selector);
        // Reverts on the path lock, before ever touching the (placeholder,
        // non-functional) swap infra configured in this mock suite.
        claimC.claimToken(ALICE_BAL - ALICE_BAL / 2, ALICE_BAL, ALICE_ETH, aliceProof(), 1, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    function test_claimETH_locksPathOf() public {
        // claimToken locking path=Token (and claimETH reverting WrongPath
        // afterward) needs a real pool to actually complete, so that half of
        // the one-path invariant is proven in the mainnet fork suite instead
        // (BallastV1ClaimFork.t.sol) -- here we only confirm the ETH side of
        // the lock, which needs no swap infra at all.
        vm.prank(alice);
        claimC.claimETH(1, ALICE_BAL, ALICE_ETH, aliceProof());
        assertEq(uint256(claimC.pathOf(alice)), uint256(1), "locked to ClaimPath.Eth (1) after the first claimETH");
    }

    function test_claimToken_zeroMinOut_reverts() public {
        vm.prank(alice);
        vm.expectRevert(BallastV1Claim.MinOutTooLow.selector);
        claimC.claimToken(ALICE_BAL, ALICE_BAL, ALICE_ETH, aliceProof(), 0, block.timestamp + 1 hours);
    }

    // ── Reentrancy ───────────────────────────────────────────────────────

    /// @notice Builds a SEPARATE, single-leaf claim contract whose only
    /// claimant is a freshly-deployed attacker contract, so this test needs no
    /// precomputed off-chain tree: a one-leaf Merkle tree's root IS the leaf,
    /// so the proof is simply empty. Solidity computes the leaf hash itself
    /// (same `keccak256(keccak256(abi.encode(...)))` encoding as the contract
    /// and the off-chain builder), so this is self-contained and can't drift
    /// from the real leaf format.
    function test_reentrancy_onClaim_blocked() public {
        // Deploy the attacker at nonce N, compute the address it WILL have one
        // nonce later (nonce N+1, since attacker's constructor runs before we
        // know its own address to build a leaf around it) -- simplest fix:
        // deploy attacker first, then build the one-leaf tree AROUND its real
        // address, then deploy a fresh claim contract with that root.
        uint256 bal = 10e18;
        uint256 ethAmt = 1 ether;

        ReentrantClaimer attacker = new ReentrantClaimer(v1);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(address(attacker), bal, ethAmt))));
        bytes32[] memory emptyProof = new bytes32[](0);

        BallastV1Claim soloClaim = new BallastV1Claim(
            address(v1), leaf, block.timestamp + 30 days, sweepTo, ballastV2, weth, universalRouter, permit2, hook
        );
        vm.deal(address(this), ethAmt);
        (bool ok,) = address(soloClaim).call{value: ethAmt}("");
        require(ok);

        v1.mint(address(attacker), bal);
        attacker.approve(address(soloClaim));
        attacker.setTarget(soloClaim, bal, bal, ethAmt, emptyProof);

        vm.expectRevert(); // ReentrancyGuard's ReentrancyGuardReentrantCall
        attacker.go();
    }
}

/// @notice Minimal attacker that calls `claimETH()` once via `go()`, then tries
/// to re-enter the SAME `claimETH()` from its own `receive()` (fired mid-payout,
/// when BallastV1Claim sends it ETH) -- the second, nested call must revert.
contract ReentrantClaimer {
    MockERC20 public v1_;
    BallastV1Claim target_;
    uint256 amountV1;
    uint256 snapshotBalance;
    uint256 ethAmount;
    bytes32[] proof;
    bool reentered;

    constructor(MockERC20 v1Token) {
        v1_ = v1Token;
    }

    function approve(address spender) external {
        v1_.approve(spender, type(uint256).max);
    }

    function setTarget(
        BallastV1Claim target,
        uint256 _amountV1,
        uint256 _snapshotBalance,
        uint256 _ethAmount,
        bytes32[] memory _proof
    ) external {
        target_ = target;
        amountV1 = _amountV1;
        snapshotBalance = _snapshotBalance;
        ethAmount = _ethAmount;
        proof = _proof;
    }

    function go() external {
        target_.claimETH(amountV1, snapshotBalance, ethAmount, proof);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            target_.claimETH(amountV1, snapshotBalance, ethAmount, proof);
        }
    }
}
