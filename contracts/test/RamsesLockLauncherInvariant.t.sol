// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RamsesLocker} from "../lib/ramses-v3-contracts/contracts/RamsesLocker.sol";
import {RamsesLockLauncher} from "../src/RamsesLockLauncher.sol";
import {BallastFeeSplitterFactory} from "../src/BallastFeeSplitterFactory.sol";
import {MockRamsesPositionManager} from "./mocks/MockRamsesPositionManager.sol";
import {MockRamsesVoter} from "./mocks/MockRamsesVoter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Random sequences of createAndLock() calls, with randomized amounts
///         and mint shortfalls. The launcher must NEVER end a call holding a
///         balance of either leg token or owning the position NFT, no matter
///         how many times it's called or with what split of amounts.
contract RamsesLockLauncherHandler is Test {
    RamsesLockLauncher public launcher;
    MockRamsesPositionManager public pm;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    address public creator = makeAddr("handlerCreator");
    uint256 public calls;

    constructor(RamsesLockLauncher launcher_, MockRamsesPositionManager pm_, MockERC20 tokenA_, MockERC20 tokenB_) {
        launcher = launcher_;
        pm = pm_;
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    function createAndLock(uint256 amount0Seed, uint256 amount1Seed, uint256 shortfallSeed) external {
        uint256 amount0 = bound(amount0Seed, 0, 1_000 ether);
        uint256 amount1 = bound(amount1Seed, 0, 1_000 ether);
        if (amount0 == 0 && amount1 == 0) amount0 = 1 ether;
        uint256 shortfallBps = bound(shortfallSeed, 0, 9999); // never 100% — mint() still needs to succeed

        pm.setMintShortfallBps(shortfallBps);
        tokenA.mint(address(this), amount0);
        tokenB.mint(address(this), amount1);
        tokenA.approve(address(launcher), amount0);
        tokenB.approve(address(launcher), amount1);

        RamsesLockLauncher.MintLegs memory legs = RamsesLockLauncher.MintLegs({
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
        launcher.createAndLock(legs, address(0xBA17), creator, 8000, 2000);
        calls++;
    }
}

contract RamsesLockLauncherInvariantTest is Test {
    RamsesLockLauncherHandler handler;
    RamsesLockLauncher launcher;
    MockERC20 tokenA;
    MockERC20 tokenB;

    function setUp() public {
        MockRamsesPositionManager pm = new MockRamsesPositionManager(makeAddr("poolDeployer"));
        MockRamsesVoter voter = new MockRamsesVoter();
        RamsesLocker locker = new RamsesLocker(address(pm), address(voter));
        BallastFeeSplitterFactory factory = new BallastFeeSplitterFactory(makeAddr("safe"));
        launcher = new RamsesLockLauncher(address(pm), address(locker), address(factory));
        tokenA = new MockERC20("TokenA", "A", 18);
        tokenB = new MockERC20("TokenB", "B", 18);
        // PoolAddress.computeAddress requires token0 < token1 — the handler's
        // legs always use tokenA as token0, so enforce that ordering here.
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        handler = new RamsesLockLauncherHandler(launcher, pm, tokenA, tokenB);
        targetContract(address(handler));
    }

    /// @notice No matter what sequence of createAndLock() calls (with any mix
    ///         of amounts and mint shortfalls) ran during this campaign, the
    ///         launcher holds zero of either leg token right now.
    function invariant_launcherHoldsNoResidualBalance() public view {
        assertEq(IERC20(tokenA).balanceOf(address(launcher)), 0);
        assertEq(IERC20(tokenB).balanceOf(address(launcher)), 0);
    }
}
