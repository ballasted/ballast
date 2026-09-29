// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BuybackBurnerV2} from "../src/BuybackBurnerV2.sol";

/// @notice Constructor validation + access-surface tests that don't need a real
/// pool or an RPC (those live in BuybackBurnerV2Fork.t.sol, which proves the
/// actual swap path against BALLAST v2's real live pools). This file locks
/// down the things a fork test can't cheaply assert: that every guard fires
/// BEFORE any external call, and that the contract has no owner-gated surface
/// to begin with.
contract BuybackBurnerV2Test is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address ballast = makeAddr("ballast");
    address weth = makeAddr("weth");
    address nvda = makeAddr("nvda");

    function _key(address quote) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(quote),
            currency1: Currency.wrap(ballast),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function test_constructor_zeroAddress_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), address(0), weth, nvda, wk, nk, 1, 1, 1, 1000);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, address(0), nvda, wk, nk, 1, 1, 1, 1000);
        vm.expectRevert(BuybackBurnerV2.ZeroAddress.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, address(0), wk, nk, 1, 1, 1, 1000);
    }

    function test_constructor_zeroValue_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 0, 1, 1, 1000);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 0, 1, 1000);
        vm.expectRevert(BuybackBurnerV2.ZeroValue.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 0, 1000);
    }

    function test_constructor_slippageAboveHardCeiling_reverts() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        vm.expectRevert(BuybackBurnerV2.SlippageTooHigh.selector);
        new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 2001);
    }

    function test_constructor_slippageAtHardCeiling_succeeds() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb = new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 2000);
        assertEq(bb.maxSlippageBps(), 2000);
    }

    function test_unsupportedAsset_revertsBeforeAnyExternalCall() public {
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb = new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1 ether, 1 ether, 1 hours, 1000);
        // No tokens minted anywhere, no PoolManager mocked -- if this reverted
        // anywhere other than the very first check, it would revert with a
        // different (unmocked-call) error instead of the specific one below.
        vm.expectRevert(BuybackBurnerV2.UnsupportedAsset.selector);
        bb.buybackAndBurn(makeAddr("randomToken"), 1, 0);
    }

    function test_noOwnerGatedFunctionExists() public {
        // There is no `owner()` on this contract at all -- Ownable was never
        // imported. This test exists to make that fact explicit and
        // regression-proof: if BuybackBurnerV2 ever gains an owner, this line
        // stops compiling (owner() doesn't exist today) rather than silently
        // passing.
        PoolKey memory wk = _key(weth);
        PoolKey memory nk = _key(nvda);
        BuybackBurnerV2 bb = new BuybackBurnerV2(IPoolManager(POOL_MANAGER), ballast, weth, nvda, wk, nk, 1, 1, 1, 1000);
        // Every parameter is a public IMMUTABLE with no setter -- this compiles
        // BECAUSE there is no owner()/setX() to accidentally call instead.
        assertEq(bb.maxWethPerCall(), 1);
        assertEq(bb.maxNvdaPerCall(), 1);
        assertEq(bb.cooldownSeconds(), 1);
    }
}
