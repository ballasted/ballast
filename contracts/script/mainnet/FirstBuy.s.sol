// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RobinhoodV4} from "../../src/interfaces/IRobinhoodV4Router.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title FirstBuy — buy a freshly-graduated token's WETH pool, for real, small.
///
/// @notice Reuses EXACTLY the encoding ProveSwapMainnet.s.sol already proved on
///         mainnet (ExactInputSingleParams, minHopPriceX36=0, actions
///         [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]) - only TOKEN/HOOK are
///         parameters, since every Ballast-graduated pool uses the same fixed
///         fee=0/tickSpacing=60. Doubles as the impossible-minOut revert check:
///         set MIN_OUT to an absurd value and the run must revert.
///
/// Env:
///   TOKEN            the launched token address (from the Launched event)
///   HOOK             the hook this launch graduated under (NEXT_PUBLIC_V4_HOOK_ADDRESS)
///   SWAP_AMOUNT_IN   wei of WETH to spend (default 0.0001 ETH)
///   MIN_OUT          amountOutMinimum (default 0 = real buy; set absurdly high to
///                    prove the slippage guard reverts)
///   DEPLOYER_PRIVATE_KEY   the buyer's key
contract FirstBuy is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
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
        uint128 amountIn = uint128(vm.envOr("SWAP_AMOUNT_IN", uint256(100_000_000_000_000))); // 0.0001 ETH
        uint128 minOut = uint128(vm.envOr("MIN_OUT", uint256(0)));
        address eoa = vm.addr(pk);

        console2.log("=== FirstBuy ===");
        console2.log("EOA:", eoa);
        console2.log("token:", token);
        console2.log("amountIn (wei):", amountIn);
        console2.log("minOut:", minOut, minOut == 0 ? "(real buy)" : "(expect REVERT if absurd)");
        require(eoa.balance > uint256(amountIn) + 1e14, "need ETH for amountIn + gas");

        bool tokenIsCurrency0 = token < WETH;
        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: tokenIsCurrency0 ? token : WETH,
            currency1: tokenIsCurrency0 ? WETH : token,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        // Buying token by spending WETH: zeroForOne = true iff WETH is currency0.
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
        params[1] = abi.encode(WETH, uint256(amountIn));
        params[2] = abi.encode(token, uint256(minOut));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);

        uint256 tokenBefore = IERC20(token).balanceOf(eoa);

        vm.startBroadcast(pk);
        IWETH(WETH).deposit{value: amountIn}();
        IWETH(WETH).approve(PERMIT2, amountIn);
        (bool ok,) = PERMIT2.call(
            abi.encodeWithSignature("approve(address,address,uint160,uint48)", WETH, ROUTER, amountIn, block.timestamp + 3600)
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
