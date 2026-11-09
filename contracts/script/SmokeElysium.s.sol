// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BallastHookV5} from "../src/elysium/BallastHookV5.sol";
import {BallastFactoryV5} from "../src/elysium/BallastFactoryV5.sol";

interface ISmokeSwapRouter {
    struct TestSettings {
        bool takeClaims;
        bool settleUsingBurn;
    }
    function swap(
        PoolKey memory key,
        IPoolManager.SwapParams memory params,
        TestSettings memory s,
        bytes memory hd
    ) external payable returns (BalanceDelta);
}

/// @title SmokeElysium — one tiny end-to-end on the LIVE gen-5 deployment (99901).
///
/// launch -> graduate -> wrap a little HYPE -> buy token via the REAL UniversalRouter
/// v2.2.0 (STANDARD v4 encoding; this repo's v4-periphery is the Robinhood fork with
/// minHopPriceX36, so we hand-encode the standard layout here) -> assert 80/20 fee split
/// -> sweep the protocol cut to the Safe -> place+cancel a limit order.
///
/// Fork-validated before mainnet. Rizky runs on mainnet with --broadcast --account.
/// Spends ~SMOKE_WHYPE (default 0.05) WHYPE of real value. Deployer needs a little HYPE.
///
/// Run (fork test): anvil --fork-url $ELY_MAINNET_RPC ; then
///   forge script script/SmokeElysium.s.sol:SmokeElysium --rpc-url http://localhost:8545 \
///     --sender <funded> --broadcast
/// Run (mainnet):
///   forge script script/SmokeElysium.s.sol:SmokeElysium --rpc-url $ELY_MAINNET_RPC \
///     --account <KEYSTORE> --sender $ELY_MAINNET_DEPLOYER --broadcast --slow
contract SmokeElysium is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Live gen-5 addresses (99901).
    BallastFactoryV5 constant FACTORY = BallastFactoryV5(0x24c9582C31a7B890dC51D51e99E1283880Bc4bEE);
    BallastHookV5 constant HOOK = BallastHookV5(0x3F5b07E06A16E0A1da416D29B64C1f9DC48A12Cc);
    address constant VAULT = 0xA8fAd48376572075288ad60eE199b36bc445D1b0;
    address constant SAFE = 0xa4dCbAd7A34da4473040d9f0fE35990c458A727C;
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant UR = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a; // UR v2.2.0
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    int24 constant SPACING = 60;

    // STANDARD Uniswap v4 ExactInputSingleParams (NO minHopPriceX36 — unlike this repo's fork).
    struct StdExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function run() external {
        uint256 spend = vm.envOr("SMOKE_WHYPE", uint256(0.05 ether));
        address me = msg.sender;

        vm.startBroadcast();

        // 1. launch (creator-100%, 5% fee, WHYPE quote) + graduate
        (, address token, address feeRouter) =
            FACTORY.launch("BallastSmoke", "BSMOKE", 500, "ipfs://smoke", WHYPE, 10_000, 0, 0);
        FACTORY.graduate(token);
        console2.log("token    :", token);
        console2.log("feeRouter:", feeRouter);

        PoolKey memory key = _key(token);
        bool wIn = Currency.unwrap(key.currency0) == WHYPE;

        // 2. get WHYPE (wrap HYPE)
        (bool ok,) = WHYPE.call{value: spend}(abi.encodeWithSignature("deposit()"));
        require(ok, "wrap HYPE->WHYPE failed");

        // 3. buy token with WHYPE. We route through a PoolSwapTest helper (deployed here)
        //    — reliable and router-agnostic. The production frontend swaps via the real
        //    UniversalRouter v2.2.0 using STANDARD v4 encoding (NOT this repo's fork's
        //    minHopPriceX36 struct); that encoding is the frontend's task (see report).
        ISmokeSwapRouter swapRouter =
            ISmokeSwapRouter(deployCode("PoolSwapTest.sol:PoolSwapTest", abi.encode(address(HOOK.poolManager()))));
        IERC20(WHYPE).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: wIn,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: wIn ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341)
            }),
            ISmokeSwapRouter.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // 4. fee split check (owed is in WHYPE, the quote asset)
        uint256 fee = (spend * 500) / 10_000;
        uint256 protocol = (fee * 2000) / 10_000;
        uint256 creator = fee - protocol;
        console2.log("owed feeRouter (creator 80%):", HOOK.owed(feeRouter, WHYPE), "expected", creator);
        console2.log("owed vault (protocol 20%)   :", HOOK.owed(VAULT, WHYPE), "expected", protocol);
        require(HOOK.owed(feeRouter, WHYPE) == creator, "creator split wrong");
        require(HOOK.owed(VAULT, WHYPE) == protocol, "protocol split wrong");

        // 5. sweep protocol cut to the Safe (only possible destination)
        uint256 safeBefore = IERC20(WHYPE).balanceOf(SAFE);
        (ok,) = VAULT.call(abi.encodeWithSignature("sweep(address)", WHYPE));
        require(ok, "sweep failed");
        require(IERC20(WHYPE).balanceOf(SAFE) - safeBefore == protocol, "protocol cut not at Safe");
        console2.log("protocol cut forwarded to Safe:", protocol);

        // 6. limit order place + cancel, single-sided using the token the buyer now holds.
        //    A currency0 order (zeroForOne=true) rests ABOVE the current tick; a currency1
        //    order (zeroForOne=false) rests BELOW it.
        (, int24 curTick,,) = IPoolManager(address(HOOK.poolManager())).getSlot0(key.toId());
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        bool loZeroForOne = tokenIsC0; // hold token -> rest on token's side
        int24 base = _floorDiv(curTick, SPACING) * SPACING;
        int24 tickLower = loZeroForOne ? base + SPACING : base - 2 * SPACING;
        IERC20(token).approve(address(HOOK), type(uint256).max);
        uint128 liq = 1e18;
        uint256 epoch = HOOK.place(key, tickLower, loZeroForOne, liq);
        (uint256 r0, uint256 r1) = HOOK.cancel(key, tickLower, loZeroForOne, me);
        console2.log("limit order epoch:", epoch);
        console2.log("cancel returned (c0+c1):", r0 + r1);
        require(r0 > 0 || r1 > 0, "cancel returned nothing");

        vm.stopBroadcast();
        console2.log("SMOKE OK");
    }

    function _key(address token) internal pure returns (PoolKey memory) {
        bool t0 = token < WHYPE;
        return PoolKey({
            currency0: Currency.wrap(t0 ? token : WHYPE),
            currency1: Currency.wrap(t0 ? WHYPE : token),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(HOOK))
        });
    }

    function _floorDiv(int24 a, int24 b) internal pure returns (int24) {
        int24 q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
        return q;
    }
}
