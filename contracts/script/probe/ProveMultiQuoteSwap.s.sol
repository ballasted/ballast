// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {BallastFactory} from "../../src/BallastFactory.sol";
import {BallastSeeder} from "../../src/BallastSeeder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

interface IStateViewLike {
    function getLiquidity(bytes32 id) external view returns (uint128);
    function getSlot0(bytes32 id) external view returns (uint160, int24, uint24, uint24);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Like {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice ONE-SHOT local-fork proof (anvil only, never real mainnet): deploy a
///         GREEN-quote-asset factory, launch a token paired ONLY against NVDA (no
///         WETH pool at all — the exact case the new useSwap/buildErc20SwapInput
///         path exists for), graduate it, then prove (a) a real buy against the
///         NVDA pool succeeds and (b) an impossible amountOutMinimum reverts.
///
/// @dev NOT YET RUN SUCCESSFULLY end-to-end (2026-09-23) — every attempt against
///      `anvil --fork-url https://rpc.mainnet.chain.robinhood.com` (the free public
///      RPC) failed with "historical state ... is not available" once execution
///      reached BallastSeeder (0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4) — that
///      endpoint's state-retention window is apparently only a few seconds/blocks
///      (chain 4663 has ~100ms blocks), too short for anvil's lazy per-account
///      state fetch to keep up even within a SINGLE forge-script run. Isolated
///      pieces DID verify cleanly on that same fork: factory deploy, launch() with
///      a single non-WETH GREEN quote asset, and a direct PoolManager.initialize()
///      call all succeeded as real broadcast transactions. Run this script instead
///      against a stable/paid RPC (RH_RPC_URL_PAID, e.g. Alchemy) — DO NOT reuse
///      the free public URL for this, it will very likely hit the same wall.
contract ProveMultiQuoteSwap is Script, StdCheats {
    address constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant SEEDER = 0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4;
    address constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    int24 constant TICK_SPACING = 60;

    // Mirrors web/lib/swap.ts buildErc20SwapInput exactly.
    bytes1 constant CMD_V4_SWAP = 0x10;
    uint8 constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant ACT_SETTLE_ALL = 0x0c;
    uint8 constant ACT_TAKE_ALL = 0x0f;

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    function run() external {
        address[] memory green = new address[](3);
        green[0] = SGOV;
        green[1] = NVDA;
        green[2] = SPY;

        vm.startBroadcast();
        BallastFactory factory =
            new BallastFactory(REGISTRY, WETH, BallastSeeder(SEEDER), ETH_USD_FEED, 24 hours, green);
        console2.log("factory:", address(factory));

        address[] memory quoteAssets = new address[](1);
        quoteAssets[0] = NVDA; // NVDA-only launch: no WETH pool exists for this token at all.
        (, address token,) = factory.launch("Test Stock Pair", "TSP", 7 days, "ipfs://test", quoteAssets);
        console2.log("token:", token);

        factory.graduate(token);
        console2.log("graduated:", factory.graduated(token));

        bool tokenIsCurrency0 = token < NVDA;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : NVDA),
            currency1: Currency.wrap(tokenIsCurrency0 ? NVDA : token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(0x743102aa1De955b5F0Fada1377B6E545Fdb080cc)
        });
        bytes32 id = keccak256(abi.encode(key));
        uint128 liq = IStateViewLike(STATE_VIEW).getLiquidity(id);
        console2.log("pool liquidity:", liq);
        require(liq > 0, "no liquidity seeded");

        // Fund the deployer with NVDA via forge-std's storage-slot deal() cheatcode
        // (anvil-only local state write, not a real transfer from anyone).
        vm.stopBroadcast();
        deal(NVDA, msg.sender, 1_000e18);

        vm.startBroadcast();
        bool zeroForOne = !tokenIsCurrency0; // spending NVDA (as currency1) for token(currency0) == buy
        IERC20(NVDA).approve(PERMIT2, type(uint256).max);
        IPermit2Like(PERMIT2).approve(NVDA, UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);

        uint128 amountIn = 10e18; // 10 NVDA
        bytes memory swapParams = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        bytes memory settleAll = abi.encode(NVDA, amountIn);
        bytes memory takeAll = abi.encode(token, uint256(0));
        bytes memory actions =
            abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = swapParams;
        params[1] = settleAll;
        params[2] = takeAll;
        bytes memory v4Input = abi.encode(actions, params);
        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4Input;

        uint256 tokenBalBefore = IERC20(token).balanceOf(msg.sender);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(commands, inputs, block.timestamp + 600);
        uint256 tokenBalAfter = IERC20(token).balanceOf(msg.sender);
        console2.log("REAL SWAP: token received =", tokenBalAfter - tokenBalBefore);
        require(tokenBalAfter > tokenBalBefore, "swap produced nothing");

        // Check 7: an impossible amountOutMinimum must revert, never silently
        // under-pay. Re-approve (allowance was consumed) and try amountOutMinimum
        // absurdly higher than any possible output.
        deal(NVDA, msg.sender, 1_000e18);
        IERC20(NVDA).approve(PERMIT2, type(uint256).max);
        IPermit2Like(PERMIT2).approve(NVDA, UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        bytes memory badSwapParams = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: type(uint128).max, // impossible
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        bytes[] memory badParams = new bytes[](3);
        badParams[0] = badSwapParams;
        badParams[1] = settleAll;
        badParams[2] = takeAll;
        bytes memory badV4Input = abi.encode(actions, badParams);
        bytes[] memory badInputs = new bytes[](1);
        badInputs[0] = badV4Input;

        (bool ok,) = UNIVERSAL_ROUTER.call(
            abi.encodeWithSelector(IUniversalRouter.execute.selector, commands, badInputs, block.timestamp + 600)
        );
        console2.log("CHECK 7: impossible amountOutMinimum reverted =", !ok);
        require(!ok, "CHECK 7 FAILED: impossible minOut did NOT revert - slippage guard is not wired");

        vm.stopBroadcast();
        console2.log("");
        console2.log("=== ALL CHECKS PASSED ===");
    }
}
