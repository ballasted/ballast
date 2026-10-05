// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {OpenTreasuryVault} from "../src/OpenTreasuryVault.sol";
import {OpenTreasuryVaultFactory} from "../src/OpenTreasuryVaultFactory.sol";

interface IWETH9c {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IBallastHookOwed {
    function owed(address) external view returns (uint256);
}

interface IBallastTokenLike {
    function creator() external view returns (address);
    function treasury() external view returns (address);
}

/// @dev Real mainnet state, real gen-4 contracts, NOT redeployed — exactly the
///      hard rule "do not modify or redeploy the gen-4 factory/hook/registry."
///      Only OpenTreasuryVaultFactory (new, additive) is deployed fresh and
///      pointed at the REAL BallastFactory/AssetRegistry/BallastHook/WETH.
///
///      SKIPS unless RH_RPC_URL_PAID is set — say so loudly in the final report,
///      this file stays runnable as-is once a key is available.
contract OpenTreasuryForkTest is Test {
    // Verified mainnet addresses (contracts/docs/BALLAST_STATE.md, this task's own brief).
    address constant BALLAST_FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address constant ASSET_REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant BALLAST_HOOK = 0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // A real gen-4 token launched through BALLAST_FACTORY.
    address constant REAL_GEN4_TOKEN = 0xDc605041F02e41CbD8FDC347023e93C4c3fA243C; // BALLAST (v2)
    // A real listed stock asset, allowlisted in the real AssetRegistry with its
    // Standard (never SVR) Chainlink proxy.
    address constant REAL_LISTED_ASSET = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5; // SGOV

    uint256 constant MIN_HOLD = 24 hours;
    uint256 constant REWARDS_DURATION = 7 days;

    OpenTreasuryVaultFactory factory;
    bool forked;

    address depositor = makeAddr("forkDepositor");
    address notifier = makeAddr("forkNotifier");

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        factory = new OpenTreasuryVaultFactory(BALLAST_FACTORY, ASSET_REGISTRY, WETH, MIN_HOLD, REWARDS_DURATION);
    }

    function test_fork_vaultCreation_realGen4Token() public {
        if (!forked) return;
        address vault = factory.getOrCreateVault(REAL_GEN4_TOKEN);
        assertEq(vault, factory.vaultFor(REAL_GEN4_TOKEN));
        assertEq(factory.getOrCreateVault(REAL_GEN4_TOKEN), vault); // idempotent
    }

    function test_fork_vaultCreation_notLaunchedToken_reverts() public {
        if (!forked) return;
        address randomAddr = makeAddr("notAToken");
        vm.expectRevert(abi.encodeWithSelector(OpenTreasuryVaultFactory.NotLaunchedToken.selector, randomAddr));
        factory.getOrCreateVault(randomAddr);
    }

    function test_fork_depositRealListedAsset_withdrawAfterHoldTime() public {
        if (!forked) return;
        OpenTreasuryVault vault = OpenTreasuryVault(factory.getOrCreateVault(REAL_GEN4_TOKEN));

        uint256 amount = 10e18; // SGOV is an 18-decimal ERC-8056 token
        deal(REAL_LISTED_ASSET, depositor, amount, true);
        assertEq(IERC20(REAL_LISTED_ASSET).balanceOf(depositor), amount, "deal() must have set a real balance");

        vm.startPrank(depositor);
        IERC20(REAL_LISTED_ASSET).approve(address(vault), amount);
        vault.deposit(REAL_LISTED_ASSET, amount);
        vm.stopPrank();

        assertEq(vault.principal(depositor, REAL_LISTED_ASSET), amount);
        assertGt(vault.assetWeight(depositor, REAL_LISTED_ASSET), 0, "real feed must have produced a positive USD weight");

        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(depositor);
        vault.withdraw(REAL_LISTED_ASSET, amount);
        assertEq(IERC20(REAL_LISTED_ASSET).balanceOf(depositor), amount);
        assertEq(vault.principal(depositor, REAL_LISTED_ASSET), 0);
    }

    function test_fork_fundRewardsWithRealWeth_streamsAndClaims() public {
        if (!forked) return;
        OpenTreasuryVault vault = OpenTreasuryVault(factory.getOrCreateVault(REAL_GEN4_TOKEN));

        uint256 amount = 5e18;
        deal(REAL_LISTED_ASSET, depositor, amount, true);
        vm.startPrank(depositor);
        IERC20(REAL_LISTED_ASSET).approve(address(vault), amount);
        vault.deposit(REAL_LISTED_ASSET, amount);
        vm.stopPrank();

        vm.deal(notifier, 2 ether);
        vm.prank(notifier);
        IWETH9c(WETH).deposit{value: 1 ether}();
        vm.startPrank(notifier);
        IWETH9c(WETH).approve(address(vault), 1 ether);
        vault.notifyReward(1 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + REWARDS_DURATION);
        assertApproxEqAbs(vault.earned(depositor), 1 ether, 1e12);

        vm.prank(depositor);
        uint256 claimed = vault.claim();
        assertEq(IERC20(WETH).balanceOf(depositor), claimed);
    }

    /// Swap-fee accounting on the REAL, live, un-redeployed BallastHook is
    /// identical before and after Open Treasury activity — proven by reading its
    /// real owed() ledger for the token's real creator around a full deposit/
    /// notify/withdraw sequence, not merely asserted from the absence of imports.
    function test_fork_hookAccountingUnaffectedByOpenTreasuryActivity() public {
        if (!forked) return;
        address creator = IBallastTokenLike(REAL_GEN4_TOKEN).creator();
        uint256 owedBefore = IBallastHookOwed(BALLAST_HOOK).owed(creator);

        OpenTreasuryVault vault = OpenTreasuryVault(factory.getOrCreateVault(REAL_GEN4_TOKEN));
        uint256 amount = 3e18;
        deal(REAL_LISTED_ASSET, depositor, amount, true);
        vm.startPrank(depositor);
        IERC20(REAL_LISTED_ASSET).approve(address(vault), amount);
        vault.deposit(REAL_LISTED_ASSET, amount);
        vm.stopPrank();

        vm.deal(notifier, 1 ether);
        vm.prank(notifier);
        IWETH9c(WETH).deposit{value: 0.5 ether}();
        vm.startPrank(notifier);
        IWETH9c(WETH).approve(address(vault), 0.5 ether);
        vault.notifyReward(0.5 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + MIN_HOLD);
        vm.prank(depositor);
        vault.withdraw(REAL_LISTED_ASSET, amount);

        uint256 owedAfter = IBallastHookOwed(BALLAST_HOOK).owed(creator);
        assertEq(owedBefore, owedAfter, "Open Treasury activity must never touch BallastHook's fee ledger");
    }
}
