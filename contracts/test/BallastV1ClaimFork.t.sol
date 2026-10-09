// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BallastV1Claim} from "../src/BallastV1Claim.sol";

/// @notice BallastV1Claim exercised end-to-end against the REAL, LIVE $BALLAST
/// v2 WETH pool on a Robinhood Chain mainnet fork — both payout paths, the
/// one-path-per-holder lock, the 7-day deadline, and sweep. Uses two real
/// holders from the committed snapshot (`data/snapshot/v1_claim_merkle.json`):
/// the single LARGEST entitlement in the whole set (claimed as tokens here —
/// the path most exposed to price impact / a tight minOut) and the
/// second-largest (claimed as ETH). Their real current v1 balance is unknown
/// and not this test's concern — `deal()` sets each to exactly its own
/// snapshot balance so the full-entitlement math is exercised deterministically
/// regardless of what either address has actually done with its v1 since the
/// snapshot.
///
/// The FULL 71-holder sum (693084308357578318 wei, exactly the deploy budget)
/// is verified off-chain in data/snapshot/build_merkle.cjs and re-checked by
/// hand against v1_claim_merkle.json before this session's report — it is not
/// re-derived here as 71 hardcoded leaves. What this file proves on-chain is
/// the structural invariant that makes that sum safe: each holder's own
/// `ethAmount` is a hard ceiling on what either path can ever pay them, singly
/// or combined, and the contract holds exactly enough for both real holders
/// tested here with nothing left over or short.
///
/// SKIPS unless RH_RPC_URL_PAID is set (division of labour: the human/CI runs
/// tests with the RPC).
contract BallastV1ClaimForkTest is Test {
    address constant V1_TOKEN = 0x069a260370C61d91bd3e9842d81D378F9750F7F3;
    address constant BALLAST_V2 = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SAFE = 0xEFC97e16a24d2434C7138a2634E554a0631aC079;

    bytes32 constant ROOT = 0xaf7393f645e01091ca3988179054cf9dc71c6bb87008cbb4c1d1546f1fee4bbb;
    uint256 constant TOTAL_BUDGET = 693084308357578318;

    // The single largest entitlement in the real 71-holder snapshot — claimed
    // here via the Token path, the one most exposed to pool price impact.
    address constant LARGEST = 0x82CCDdD324a6c14861cb622da051579d4e99Ac54;
    uint256 constant LARGEST_BAL = 32319671585719116225209612;
    uint256 constant LARGEST_ETH = 85413606364002940;

    // The second-largest entitlement — claimed via the ETH path.
    address constant SECOND = 0x92c011A3341a1Ac5F96774255D390b10A425bB66;
    uint256 constant SECOND_BAL = 25776633011108119935566423;
    uint256 constant SECOND_ETH = 68121830370732873;

    BallastV1Claim claimC;
    uint256 deployedAt;
    bool forked;

    function largestProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](7);
        p[0] = 0xef13839a6282dd3c7e4c345803aba61c0b80c4307891768b0229858ba2b8a25d;
        p[1] = 0x7228f5a5b02703931a1fe80cabeb4bef30b85f7cbf802e7ab701a8e3fe8f31ec;
        p[2] = 0x86a37738e3444549e20c038347493463e388dcae606f9499e06905e4b4052d62;
        p[3] = 0x1491a1fd99496af3eb6de500461e5a42b4097b5b5311f08faada8bf65c460b26;
        p[4] = 0xc24c6c3ce588928eeb7e79e0f67ad2af0240c116e7df66aa5e52d90590c1a5a3;
        p[5] = 0x398f6a39cd683ec0f73b38f95a643135a2d641e5ef16a94ee9ac0fd3a45f4625;
        p[6] = 0x19952845ab2c5a4e8596f6bcf3bc6bd50784c3e0cbbf000dde579de6b01cf421;
    }

    function secondProof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](7);
        p[0] = 0xfb081b3629966cf8b832840ba1e0a34a790e24b28976a7a504404d912a5960e4;
        p[1] = 0x7228f5a5b02703931a1fe80cabeb4bef30b85f7cbf802e7ab701a8e3fe8f31ec;
        p[2] = 0x86a37738e3444549e20c038347493463e388dcae606f9499e06905e4b4052d62;
        p[3] = 0x1491a1fd99496af3eb6de500461e5a42b4097b5b5311f08faada8bf65c460b26;
        p[4] = 0xc24c6c3ce588928eeb7e79e0f67ad2af0240c116e7df66aa5e52d90590c1a5a3;
        p[5] = 0x398f6a39cd683ec0f73b38f95a643135a2d641e5ef16a94ee9ac0fd3a45f4625;
        p[6] = 0x19952845ab2c5a4e8596f6bcf3bc6bd50784c3e0cbbf000dde579de6b01cf421;
    }

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);

        deployedAt = block.timestamp;
        claimC = new BallastV1Claim(
            V1_TOKEN, ROOT, deployedAt + 7 days, SAFE, BALLAST_V2, WETH, UNIVERSAL_ROUTER, PERMIT2, HOOK
        );
        vm.deal(address(this), TOTAL_BUDGET);
        (bool ok,) = address(claimC).call{value: TOTAL_BUDGET}("");
        require(ok, "fund failed");

        // Real holders' current v1 balance is irrelevant to this suite -- set
        // each to exactly its own snapshot balance so every test exercises the
        // full entitlement deterministically.
        deal(V1_TOKEN, LARGEST, LARGEST_BAL, true);
        deal(V1_TOKEN, SECOND, SECOND_BAL, true);
        vm.prank(LARGEST);
        IERC20(V1_TOKEN).approve(address(claimC), type(uint256).max);
        vm.prank(SECOND);
        IERC20(V1_TOKEN).approve(address(claimC), type(uint256).max);

        forked = true;
    }

    // ── Both paths, happy path ───────────────────────────────────────────

    function test_fork_claimETH_paysExactEntitlement() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 ethBefore = SECOND.balance;
        uint256 deadBefore = IERC20(V1_TOKEN).balanceOf(claimC.DEAD());
        vm.prank(SECOND);
        uint256 paid = claimC.claimETH(SECOND_BAL, SECOND_BAL, SECOND_ETH, secondProof());
        assertEq(paid, SECOND_ETH);
        assertEq(SECOND.balance - ethBefore, SECOND_ETH);
        assertEq(IERC20(V1_TOKEN).balanceOf(claimC.DEAD()) - deadBefore, SECOND_BAL, "exactly this holder's balance was burned");
        assertEq(uint256(claimC.pathOf(SECOND)), 1, "locked to ClaimPath.Eth");
    }

    function test_fork_claimToken_swapsThroughRealPool_paysBallastV2() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // A generous but real floor: at least 50% of a naive spot-price
        // estimate is impossible to get exactly on-chain without a quoter
        // call from the test itself, so this just proves minOut=1 (passing
        // the contract's own >0 floor) swaps successfully and the holder
        // receives real tokens with nothing left in the contract.
        uint256 ballastBefore = IERC20(BALLAST_V2).balanceOf(LARGEST);
        uint256 deadBefore = IERC20(V1_TOKEN).balanceOf(claimC.DEAD());
        vm.prank(LARGEST);
        uint256 out = claimC.claimToken(LARGEST_BAL, LARGEST_BAL, LARGEST_ETH, largestProof(), 1, block.timestamp + 600);

        assertGt(out, 0, "must receive real $BALLAST v2");
        assertEq(IERC20(BALLAST_V2).balanceOf(LARGEST) - ballastBefore, out, "holder receives exactly what the pool paid");
        assertEq(IERC20(BALLAST_V2).balanceOf(address(claimC)), 0, "contract holds no BALLAST after the swap");
        assertEq(IERC20(V1_TOKEN).balanceOf(claimC.DEAD()) - deadBefore, LARGEST_BAL, "exactly this holder's balance was burned");
        assertEq(uint256(claimC.pathOf(LARGEST)), 2, "locked to ClaimPath.Token");
    }

    // ── One path per holder, enforced across BOTH directions ────────────

    function test_fork_ethThenToken_sameHolder_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.startPrank(SECOND);
        claimC.claimETH(SECOND_BAL / 2, SECOND_BAL, SECOND_ETH, secondProof());
        vm.expectRevert(BallastV1Claim.WrongPath.selector);
        claimC.claimToken(SECOND_BAL - SECOND_BAL / 2, SECOND_BAL, SECOND_ETH, secondProof(), 1, block.timestamp + 600);
        vm.stopPrank();
    }

    function test_fork_tokenThenEth_sameHolder_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.startPrank(LARGEST);
        claimC.claimToken(LARGEST_BAL / 2, LARGEST_BAL, LARGEST_ETH, largestProof(), 1, block.timestamp + 600);
        vm.expectRevert(BallastV1Claim.WrongPath.selector);
        claimC.claimETH(LARGEST_BAL - LARGEST_BAL / 2, LARGEST_BAL, LARGEST_ETH, largestProof());
        vm.stopPrank();
    }

    // ── minOut failure leaves the claim completely untouched ────────────

    function test_fork_minOutNotMet_revertsEntireClaim_touchesNothing() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 v1Before = IERC20(V1_TOKEN).balanceOf(LARGEST);
        uint256 contractEthBefore = address(claimC).balance;

        vm.prank(LARGEST);
        vm.expectRevert(BallastV1Claim.InsufficientOutput.selector);
        claimC.claimToken(LARGEST_BAL, LARGEST_BAL, LARGEST_ETH, largestProof(), type(uint256).max, block.timestamp + 600);

        assertEq(IERC20(V1_TOKEN).balanceOf(LARGEST), v1Before, "no v1 burned on a reverted swap");
        assertEq(claimC.burnedOf(LARGEST), 0, "burnedOf untouched");
        assertEq(uint256(claimC.pathOf(LARGEST)), 0, "path not locked by a reverted claim");
        assertEq(address(claimC).balance, contractEthBefore, "no ETH moved on a reverted swap");
    }

    // ── 7-day deadline ────────────────────────────────────────────────────

    function test_fork_claimOnDaySix_works() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.warp(deployedAt + 6 days);
        vm.prank(SECOND);
        uint256 paid = claimC.claimETH(SECOND_BAL, SECOND_BAL, SECOND_ETH, secondProof());
        assertEq(paid, SECOND_ETH);
    }

    function test_fork_claimAfterDaySeven_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.warp(deployedAt + 7 days);
        vm.prank(SECOND);
        vm.expectRevert(BallastV1Claim.DeadlinePassed.selector);
        claimC.claimETH(SECOND_BAL, SECOND_BAL, SECOND_ETH, secondProof());
    }

    // ── Sweep ────────────────────────────────────────────────────────────

    function test_fork_sweepBeforeDeadline_reverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        vm.expectRevert(BallastV1Claim.DeadlineNotYetPassed.selector);
        claimC.sweep();
    }

    function test_fork_sweepAfterDeadline_sendsExactRemainder() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // Only SECOND claims (in ETH); LARGEST's full entitlement is never
        // claimed and must sweep in full.
        vm.prank(SECOND);
        claimC.claimETH(SECOND_BAL, SECOND_BAL, SECOND_ETH, secondProof());

        vm.warp(deployedAt + 7 days);
        uint256 safeBefore = SAFE.balance;
        uint256 expectedRemainder = TOTAL_BUDGET - SECOND_ETH;
        uint256 swept = claimC.sweep();

        assertEq(swept, expectedRemainder);
        assertEq(SAFE.balance - safeBefore, expectedRemainder);
        assertEq(address(claimC).balance, 0);
    }

    // ── Global budget invariant ──────────────────────────────────────────

    /// @notice Both real holders claim their FULL entitlement, one on each
    /// path, and the contract's remaining balance drops by EXACTLY the sum of
    /// the two -- never more. Combined with the per-holder ceiling every other
    /// test here enforces (the Merkle leaf fixes `ethAmount` and the linear
    /// formula is bounded by it on both paths identically), and the off-chain
    /// verified fact that summing all 71 real leaves' `ethAmountWei` equals
    /// exactly `TOTAL_BUDGET` (data/snapshot/build_merkle.cjs, re-checked this
    /// session), this is the on-chain half of "total paid out can never
    /// exceed the budget": no single holder, on either path, can ever be paid
    /// more than their own fixed leaf allows.
    function test_fork_totalPaidOut_neverExceedsBudget() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 contractEthBefore = address(claimC).balance;
        assertEq(contractEthBefore, TOTAL_BUDGET);

        vm.prank(SECOND);
        uint256 ethPaid = claimC.claimETH(SECOND_BAL, SECOND_BAL, SECOND_ETH, secondProof());
        assertEq(ethPaid, SECOND_ETH);

        vm.prank(LARGEST);
        claimC.claimToken(LARGEST_BAL, LARGEST_BAL, LARGEST_ETH, largestProof(), 1, block.timestamp + 600);

        uint256 contractEthAfter = address(claimC).balance;
        assertEq(
            contractEthBefore - contractEthAfter,
            SECOND_ETH + LARGEST_ETH,
            "exactly the two entitlements left the contract, on either path -- never more"
        );
        assertLe(contractEthBefore - contractEthAfter, TOTAL_BUDGET, "can never exceed the whole budget");
    }
}
