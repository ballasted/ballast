// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RobinhoodV4} from "../src/interfaces/IRobinhoodV4Router.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title ProveSwapMainnet — execution proof of the modified UniversalRouter's v4
///        single-hop encoding (ExactInputSingleParams with minHopPriceX36 = 0).
///
/// @notice Wraps a few cents of ETH → WETH, then swaps WETH → token through the
///         fork router using OUR ExactInputSingleParams shape. Run WITHOUT
///         --broadcast first (simulates execute() via eth_call against live state
///         — this is where a mis-shaped struct reverts, and it costs nothing), then
///         with --broadcast for end-to-end confirmation.
///
/// Target pool (verified to have liquidity via StateView): WETH/token dynamic-fee
/// pool with the launchpad hook — representative of BALLAST's own future
/// token/WETH+hook graduated pools.
contract ProveSwapMainnet is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant TOKEN = 0xDD750A6b221FB9215d36325cE89bcEBAE90ac2AB; // pool counterparty
    address constant HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    uint24 constant FEE = 8388608; // dynamic-fee flag (0x800000)
    int24 constant TICK_SPACING = 200;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // v4 action ids
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;
    bytes1 constant CMD_V4_SWAP = 0x10;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint128 amountIn = uint128(vm.envOr("SWAP_AMOUNT_IN", uint256(10_000_000_000_000))); // 0.00001 WETH
        address eoa = vm.addr(pk);

        console2.log("=== swap proof ===");
        console2.log("EOA:", eoa);
        console2.log("amountIn (WETH wei):", amountIn);
        console2.log("ETH balance:", eoa.balance);
        require(eoa.balance > uint256(amountIn) + 1e14, "need ETH for amountIn + gas");

        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: WETH,
            currency1: TOKEN,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: HOOK
        });
        RobinhoodV4.ExactInputSingleParams memory sp = RobinhoodV4.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: true, // WETH (currency0) -> TOKEN
            amountIn: amountIn,
            amountOutMinimum: 0, // proof: accept any out
            minHopPriceX36: 0, // FORK FIELD, disabled
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(sp);
        params[1] = abi.encode(WETH, uint256(amountIn)); // SETTLE_ALL(currency, maxAmount)
        params[2] = abi.encode(TOKEN, uint256(0)); // TAKE_ALL(currency, minAmount)

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);

        uint256 tokenBefore = IERC20(TOKEN).balanceOf(eoa);

        vm.startBroadcast(pk);
        IWETH(WETH).deposit{value: amountIn}();
        IWETH(WETH).approve(PERMIT2, amountIn);
        IPermit2(PERMIT2).approve(WETH, ROUTER, amountIn, uint48(block.timestamp + 3600));
        IUniversalRouter(ROUTER).execute(commands, inputs, block.timestamp + 300);
        vm.stopBroadcast();

        uint256 received = IERC20(TOKEN).balanceOf(eoa) - tokenBefore;
        console2.log("token received:", received);
        require(received > 0, "no output received");
        console2.log("SWAP OK - ExactInputSingleParams with minHopPriceX36=0 accepted by the fork router");
    }
}
