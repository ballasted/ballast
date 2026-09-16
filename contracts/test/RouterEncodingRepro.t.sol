// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {RobinhoodV4} from "../src/interfaces/IRobinhoodV4Router.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title RouterEncodingRepro — the honeypot-flag diagnosis, as a runnable proof
///
/// @notice Ballast's launched tokens get flagged "honeypot" / sell-fails by some
///         third-party scanners (GoPlus/GMGN and similar). This test settles WHICH
///         of two possible causes is real, against a REAL graduated pool on a REAL
///         fork of this chain — not a claim, an assertion that fails loudly if it
///         ever stops being true:
///
///         (a) the token itself blocks or breaks sells — ruled out by
///             `contracts/src/BallastToken.sol`: no transfer hook, no pause, no
///             blacklist, no owner-controlled parameter, no fee-on-transfer, no
///             mint (the constructor mints once and there is no mint function).
///             There is nothing in that contract capable of failing a sell.
///
///         (b) the SELL PATH IS UNSIMULATABLE BY STANDARD TOOLING — confirmed here.
///             This chain's UniversalRouter (0x8876789976dEcBfCbBbe364623C63652db8C0904,
///             verified fork source on Blockscout) requires an extra `minHopPriceX36`
///             field on its v4 swap struct that the stock Uniswap v4 SDK omits.
///             A scanner that builds calldata with the standard SDK shape (or
///             simulates with a v2/v3 router against a v4-only pool) gets a revert
///             on the BUY step — before a sell is ever attempted — and some tooling
///             appears to attribute that revert to the token being unsellable. It
///             is not: it is a calldata-shape mismatch specific to this chain's
///             router fork, upstream of anything token- or pool-specific.
///
///         Encoding source of truth: `docs/robinhood-chain-research.md` §4 and
///         `web/lib/robinhoodRouter.ts` (the same shapes this test builds, kept in
///         sync by hand — if this test ever needs to change, that file does too).
///
///         Anyone with an RH_RPC_URL_PAID key can run this and watch both things
///         happen on a real fork:
///           forge test --match-path "test/RouterEncodingRepro.t.sol" -vv
///
/// @dev The target token/pool (found via the live factory + StateView at the time
///      this test was written — re-derive with the commands in the comment below if
///      it ever stops existing):
///        FACTORY (0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1).launches(0) ->
///          token 0x0107442A5EceDA6B3A108E0d55368deB91b18eE6
///        FACTORY.graduated(token) == true
///        current hook 0x743102aa1De955b5F0Fada1377B6E545Fdb080cc has nonzero
///          liquidity at this pool's id (the prior hook does not — this token
///          graduated under the current hook generation).
contract RouterEncodingReproTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // The real graduated launch this test targets (see contract doc comment).
    address constant TOKEN = 0x0107442A5EceDA6B3A108E0d55368deB91b18eE6;
    address constant HOOK = 0x743102aa1De955b5F0Fada1377B6E545Fdb080cc;
    uint24 constant FEE = 0;
    int24 constant TICK_SPACING = 60;

    // UniversalRouter command ids (docs/robinhood-chain-research.md §4;
    // web/lib/robinhoodRouter.ts CMD_*).
    bytes1 constant CMD_WRAP_ETH = 0x0b;
    bytes1 constant CMD_UNWRAP_WETH = 0x0c;
    bytes1 constant CMD_V4_SWAP = 0x10;

    // v4 Action ids used inside a V4_SWAP input.
    uint8 constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant ACT_SETTLE = 0x0b;
    uint8 constant ACT_SETTLE_ALL = 0x0c;
    uint8 constant ACT_TAKE = 0x0e;
    uint8 constant ACT_TAKE_ALL = 0x0f;

    // UniversalRouter address sentinels (web/lib/robinhoodRouter.ts).
    address constant UR_ADDRESS_THIS = address(2);
    address constant UR_MSG_SENDER = address(1);
    uint256 constant UR_CONTRACT_BALANCE = 1 << 255;

    bool forked;

    function setUp() public {
        string memory url = vm.envOr("RH_RPC_URL_PAID", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        vm.deal(address(this), 10 ether);
    }

    /// @dev UNWRAP_WETH sends native ETH to UR_MSG_SENDER (this test contract) at
    ///      the end of a sell — needs a payable receive to accept it.
    receive() external payable {}

    function _poolKey() internal pure returns (RobinhoodV4.PoolKey memory) {
        return RobinhoodV4.PoolKey({currency0: TOKEN, currency1: WETH, fee: FEE, tickSpacing: TICK_SPACING, hooks: HOOK});
    }

    /// @dev The real v4-core PoolKey (Currency-wrapped types) StateLibrary needs —
    ///      separate from RobinhoodV4.PoolKey, which uses plain `address` fields for
    ///      the router's ABI encoding. Identical bytes, different Solidity type.
    function _v4PoolId() internal pure returns (PoolId) {
        return PoolKey({
            currency0: Currency.wrap(TOKEN),
            currency1: Currency.wrap(WETH),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(HOOK)
        }).toId();
    }

    // ── Encoding (i): OUR shape, WITH minHopPriceX36 — both buy and sell succeed ──
    function test_ourEncoding_buyAndSell_succeed() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertGt(MANAGER.getLiquidity(_v4PoolId()), 0, "pool must have real liquidity for this proof to mean anything");

        uint128 amountIn = 0.01 ether;
        RobinhoodV4.ExactInputSingleParams memory sp = RobinhoodV4.ExactInputSingleParams({
            poolKey: _poolKey(),
            zeroForOne: false, // WETH (currency1) -> TOKEN (currency0): buy
            amountIn: amountIn,
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(sp);
        params[1] = abi.encode(WETH, UR_CONTRACT_BALANCE, false); // SETTLE(currency, amount, payerIsUser)
        params[2] = abi.encode(TOKEN, uint256(0)); // TAKE_ALL(currency, minAmount)

        bytes[] memory buyInputs = new bytes[](2);
        buyInputs[0] = abi.encode(UR_ADDRESS_THIS, UR_CONTRACT_BALANCE); // WRAP_ETH(recipient, amount)
        buyInputs[1] = abi.encode(actions, params);
        bytes memory buyCommands = abi.encodePacked(CMD_WRAP_ETH, CMD_V4_SWAP);

        uint256 tokenBefore = IERC20(TOKEN).balanceOf(address(this));
        IUniversalRouter(ROUTER).execute{value: amountIn}(buyCommands, buyInputs, block.timestamp + 600);
        uint256 tokenReceived = IERC20(TOKEN).balanceOf(address(this)) - tokenBefore;

        console2.log("(i) BUY: token received:", tokenReceived);
        assertGt(tokenReceived, 0, "(i) buy: expected a real token balance increase");

        // Sell it all back. SETTLE_ALL pulls the token from us via Permit2 — the two
        // approvals below are the real, un-skippable path (web/lib/swap.ts's
        // comment: "the sell STILL needs the two Permit2 approvals").
        IERC20(TOKEN).approve(PERMIT2, tokenReceived);
        IPermit2(PERMIT2).approve(TOKEN, ROUTER, uint160(tokenReceived), uint48(block.timestamp + 3600));

        RobinhoodV4.ExactInputSingleParams memory sellSp = RobinhoodV4.ExactInputSingleParams({
            poolKey: _poolKey(),
            zeroForOne: true, // TOKEN (currency0) -> WETH (currency1): sell
            amountIn: uint128(tokenReceived),
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: ""
        });
        bytes memory sellActions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE);
        bytes[] memory sellParams = new bytes[](3);
        sellParams[0] = abi.encode(sellSp);
        sellParams[1] = abi.encode(TOKEN, uint256(tokenReceived)); // SETTLE_ALL(currency, maxAmount)
        sellParams[2] = abi.encode(WETH, UR_ADDRESS_THIS, uint256(0)); // TAKE(currency, recipient, amount=OPEN_DELTA)

        bytes[] memory sellInputs = new bytes[](2);
        sellInputs[0] = abi.encode(sellActions, sellParams);
        sellInputs[1] = abi.encode(UR_MSG_SENDER, uint256(0)); // UNWRAP_WETH(recipient, amountMin)
        bytes memory sellCommands = abi.encodePacked(CMD_V4_SWAP, CMD_UNWRAP_WETH);

        uint256 ethBefore = address(this).balance;
        IUniversalRouter(ROUTER).execute(sellCommands, sellInputs, block.timestamp + 600);
        uint256 ethReceived = address(this).balance - ethBefore;

        console2.log("(i) SELL: ETH received:", ethReceived);
        assertGt(ethReceived, 0, "(i) sell: expected a real ETH balance increase");
        assertEq(IERC20(TOKEN).balanceOf(address(this)), 0, "(i) sell: expected the full token balance to be sold");
    }

    // ── Encoding (ii): standard v4-SDK shape, minHopPriceX36 OMITTED — buy reverts ──
    //
    // This is what an unmodified `@uniswap/v4-sdk`-built transaction looks like: the
    // exact same struct as above with the fork-only `minHopPriceX36` field deleted.
    // It reverts on the BUY — before a sell is ever attempted — because the router
    // decodes a 5-field struct where it expects 6, not because of anything about
    // this specific token. Sells are never even reached by a scanner using this
    // shape, which is exactly how a router-encoding mismatch gets misread as
    // "sells fail" by tooling that doesn't distinguish the two.
    struct SdkShapeExactInputSingleParams {
        RobinhoodV4.PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData; // minHopPriceX36 does not exist in this shape
    }

    function test_sdkShapeEncoding_buyReverts() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertGt(MANAGER.getLiquidity(_v4PoolId()), 0, "pool must have real liquidity for this proof to mean anything");

        uint128 amountIn = 0.01 ether;
        SdkShapeExactInputSingleParams memory sp = SdkShapeExactInputSingleParams({
            poolKey: _poolKey(),
            zeroForOne: false,
            amountIn: amountIn,
            amountOutMinimum: 0,
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(sp); // SDK shape — one field short
        params[1] = abi.encode(WETH, UR_CONTRACT_BALANCE, false);
        params[2] = abi.encode(TOKEN, uint256(0));

        bytes[] memory buyInputs = new bytes[](2);
        buyInputs[0] = abi.encode(UR_ADDRESS_THIS, UR_CONTRACT_BALANCE);
        buyInputs[1] = abi.encode(actions, params);
        bytes memory buyCommands = abi.encodePacked(CMD_WRAP_ETH, CMD_V4_SWAP);

        // Bare expectRevert: the actual failure (confirmed by hand against this same
        // pool, see the diagnosis this test was written from) is a plain
        // "execution reverted" with no decodable reason — a struct-decode-level
        // mismatch, not a clean custom error. Matching any revert is the correct
        // (and only reliable) assertion here.
        vm.expectRevert();
        IUniversalRouter(ROUTER).execute{value: amountIn}(buyCommands, buyInputs, block.timestamp + 600);
    }
}
