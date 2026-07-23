// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

/// @dev Throwaway wiring check: confirms the v4-core + v4-periphery remappings
///      resolve and compile against a single core before any hook logic is written.
contract V4WiringTest is Test {
    function test_v4TypesResolve() public {
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(2)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        assertEq(k.fee, 3000);
        IPoolManager pm = IPoolManager(address(0));
        IPositionManager posm = IPositionManager(address(0));
        assertEq(address(pm), address(0));
        assertEq(address(posm), address(0));
    }
}
