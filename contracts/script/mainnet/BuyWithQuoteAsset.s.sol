// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RobinhoodV4} from "../../src/interfaces/IRobinhoodV4Router.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title BuyWithQuoteAsset — buy a graduated token by spending an ALREADY-HELD
///        ERC-20 quote asset (not WETH) — generalizes FirstBuy.s.sol's proven
///        mainnet encoding (same actions, same ExactInputSingleParams shape) for
///        a token whose only real pool is quoted in something other than WETH
///        (e.g. HARUNA, NVDA-only). The buyer must already hold QUOTE_ASSET —
///        this script does NOT wrap ETH or acquire the quote asset itself (see
///        AcquireNvda.s.sol for that leg, a separate, explicit action).
///
/// Env:
///   TOKEN            the launched token address
///   HOOK             the hook this launch graduated under
///   QUOTE_ASSET      the ERC-20 the buyer is spending (must be one of the
///                    token's real quoteAssetsOf() entries)
///   SWAP_AMOUNT_IN   raw units of QUOTE_ASSET to spend
///   MIN_OUT          amountOutMinimum (default 0 = real buy; set absurdly high
///                    to prove the slippage guard reverts)
///   DEPLOYER_PRIVATE_KEY   the buyer's key
contract BuyWithQuoteAsset is Script {
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 constant FEE = 0; // every Ballast-graduated pool: fee=0, tickSpacing=60
    int24 constant TICK_SPACING = 60;

    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;
    bytes1 constant CMD_V4_SWAP = 0x10;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address token = vm.envAddress("TOKEN");
        address hook = vm.envAddress("HOOK");
        address quoteAsset = vm.envAddress("QUOTE_ASSET");
        uint128 amountIn = uint128(vm.envUint("SWAP_AMOUNT_IN"));
        uint128 minOut = uint128(vm.envOr("MIN_OUT", uint256(0)));
        address eoa = vm.addr(pk);

        console2.log("=== BuyWithQuoteAsset ===");
        console2.log("EOA:", eoa);
        console2.log("token:", token);
        console2.log("quoteAsset:", quoteAsset);
        console2.log("amountIn:", amountIn);
        console2.log("minOut:", minOut, minOut == 0 ? "(real buy)" : "(expect REVERT if absurd)");
        require(IERC20(quoteAsset).balanceOf(eoa) >= amountIn, "insufficient quote asset balance");

        bool tokenIsCurrency0 = token < quoteAsset;
        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: tokenIsCurrency0 ? token : quoteAsset,
            currency1: tokenIsCurrency0 ? quoteAsset : token,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        // Buying token by spending quoteAsset: zeroForOne = true iff quoteAsset is currency0.
        bool zeroForOne = !tokenIsCurrency0;

        RobinhoodV4.ExactInputSingleParams memory sp = RobinhoodV4.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            minHopPriceX36: 0,
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(sp);
        params[1] = abi.encode(quoteAsset, uint256(amountIn));
        params[2] = abi.encode(token, uint256(minOut));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);

        uint256 tokenBefore = IERC20(token).balanceOf(eoa);

        vm.startBroadcast(pk);
        IERC20(quoteAsset).approve(PERMIT2, amountIn);
        (bool ok,) = PERMIT2.call(
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)", quoteAsset, ROUTER, amountIn, block.timestamp + 3600
            )
        );
        require(ok, "Permit2 approve failed");
        IUniversalRouter(ROUTER).execute(commands, inputs, block.timestamp + 300);
        vm.stopBroadcast();

        uint256 received = IERC20(token).balanceOf(eoa) - tokenBefore;
        console2.log("token received:", received);
        require(received > 0, "no output received");
        console2.log("BUY OK");
    }
}
