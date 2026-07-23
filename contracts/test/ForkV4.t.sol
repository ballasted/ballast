// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @dev Fork-harness scaffold for the factory's graduation phase. Skips when
///      RH_RPC_URL_PAID isn't set, so the normal `forge test` stays green offline.
///      When set, it forks mainnet and confirms the real Uniswap v4 singletons are
///      present — the same infra the (upcoming) graduation + single-hop swap tests
///      will run against. No mainnet deploy; reads only.
contract ForkV4Test is Test {
    // Verified v4 infrastructure (docs/robinhood-chain-research.md §4).
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function _forkOrSkip() internal {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
    }

    function test_v4Singletons_deployedOnFork() public {
        _forkOrSkip();
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager");
        assertGt(POSITION_MANAGER.code.length, 0, "PositionManager");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "UniversalRouter");
        assertGt(V4_QUOTER.code.length, 0, "V4Quoter");
        assertGt(STATE_VIEW.code.length, 0, "StateView");
        assertGt(WETH.code.length, 0, "WETH");
    }
}
