// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeConfig} from "./FeeConfig.sol";
import {BallastToken} from "./BallastToken.sol";

/// @title BallastHook — singleton v4 hook that takes a fee on the WETH leg
///
/// @notice Charges `FeeConfig.feeBps` (1%) of the WETH side of every swap and
///         splits it creator/platform/referrer (read live). Fee is ALWAYS in WETH
///         — never the project token — so the platform never becomes a holder of
///         the tokens it reports on.
///
/// @dev The fee is skimmed where the WETH leg is reachable, which depends on
///      whether WETH is the swap's SPECIFIED or UNSPECIFIED currency (a function
///      of direction AND exact-in/out — four cases, not two):
///        - WETH specified   (buy exact-in, sell exact-out)  -> beforeSwap
///        - WETH unspecified (buy exact-out, sell exact-in)  -> afterSwap
///      because `beforeSwap`'s BeforeSwapDelta can only move the SPECIFIED currency
///      and `afterSwap`'s return delta only the UNSPECIFIED one. Keying on direction
///      alone would skim the wrong leg or nothing, and it would leak SILENTLY.
///
///      ⚠️ The delta SIGNS below are pending the 8-combo fork verification
///      (4 cases × both currency orderings, each asserting collected == 1% of the
///      WETH leg). Do not trust this hook until that matrix is green.
///
///      Distribution is accrue-and-claim (pull, not push): a reverting/blocklisted
///      recipient can only fail its own claim(), never brick a swap.
contract BallastHook {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    FeeConfig public immutable feeConfig;
    address public immutable weth;

    /// @notice WETH owed to each recipient, claimable on demand.
    mapping(address => uint256) public owed;

    event FeeTaken(address indexed token, uint256 feeWeth, address creator, address platform, address referrer);
    event Claimed(address indexed recipient, uint256 amount);

    error NotPoolManager();
    /// @notice Sell-exact-out (WETH specified as output) is rejected: the WETH fee
    ///         would have to be skimmed in beforeSwap on the REQUESTED amount before
    ///         the fill is known, over-collecting on a partial fill, and afterSwap
    ///         cannot correct it (it only touches the unspecified currency). We
    ///         revert loudly instead of overcharging silently. Route sells as
    ///         exact-in. (Buy-exact-out is fine — WETH is unspecified there, so the
    ///         fee is charged on the actual fill in afterSwap.)
    error SellExactOutNotSupported();

    /// Flag bits this hook's mined address must carry (and only these).
    uint160 public constant FLAGS =
        Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    constructor(IPoolManager poolManager_, FeeConfig feeConfig_, address weth_) {
        poolManager = poolManager_;
        feeConfig = feeConfig_;
        weth = weth_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice For HookMiner / readability — the four permissions this hook needs.
    function getHookPermissions() external pure returns (Hooks.Permissions memory p) {
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    // --------------------------------------------------------------------- //
    //  beforeSwap — skim when WETH is the SPECIFIED currency                //
    // --------------------------------------------------------------------- //
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bool exactIn = params.amountSpecified < 0;
        Currency specified = _specified(key, params.zeroForOne, exactIn);
        if (Currency.unwrap(specified) != weth) {
            // WETH is unspecified here -> afterSwap handles it.
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
        }
        // WETH is specified. Exact-out here == sell-exact-out: reject it rather than
        // over-collect on a partial fill (see SellExactOutNotSupported).
        if (!exactIn) revert SellExactOutNotSupported();
        // Exact-in: the specified magnitude IS the WETH input leg.
        uint256 wethAmt = uint256(-params.amountSpecified);
        uint256 fee = (wethAmt * feeConfig.feeBps()) / feeConfig.BPS();
        if (fee == 0) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        poolManager.take(Currency.wrap(weth), address(this), fee);
        _distribute(key, fee, hookData);
        // +fee on the specified currency: the swapper covers the fee we took.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    // --------------------------------------------------------------------- //
    //  afterSwap — skim when WETH is the UNSPECIFIED currency               //
    // --------------------------------------------------------------------- //
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        bool exactIn = params.amountSpecified < 0;
        Currency specified = _specified(key, params.zeroForOne, exactIn);
        if (Currency.unwrap(specified) == weth) {
            return (IHooks.afterSwap.selector, 0); // WETH was specified -> beforeSwap handled it
        }
        // WETH is the unspecified currency; its moved amount is now known from delta.
        bool wethIsCurrency0 = Currency.unwrap(key.currency0) == weth;
        int128 wethDelta = wethIsCurrency0 ? delta.amount0() : delta.amount1();
        uint256 wethAmt = uint256(int256(wethDelta < 0 ? -wethDelta : wethDelta));
        uint256 fee = (wethAmt * feeConfig.feeBps()) / feeConfig.BPS();
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(Currency.wrap(weth), address(this), fee);
        _distribute(key, fee, hookData);
        // +fee on the unspecified currency: the swapper covers the fee we took.
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // --------------------------------------------------------------------- //
    //  Distribution + claim                                                 //
    // --------------------------------------------------------------------- //
    function _distribute(PoolKey calldata key, uint256 fee, bytes calldata hookData) internal {
        // The non-WETH currency is the project token; its creator is on the token.
        address token = Currency.unwrap(key.currency0) == weth
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        address creator = BallastToken(token).creator();

        address referrerReq = hookData.length >= 32 ? abi.decode(hookData, (address)) : address(0);
        (, uint16 creatorBps, uint16 platformBps,, address platformVault) = feeConfig.feeParams();
        address referrer = feeConfig.effectiveReferrer(referrerReq);
        uint16 bps = feeConfig.BPS();

        uint256 creatorCut = (fee * creatorBps) / bps;
        uint256 platformCut = (fee * platformBps) / bps;
        uint256 referrerCut = fee - creatorCut - platformCut; // remainder avoids dust loss

        if (referrer == address(0)) {
            platformCut += referrerCut; // no eligible referrer -> rolls to platform
            referrerCut = 0;
        }

        owed[creator] += creatorCut;
        owed[platformVault] += platformCut;
        if (referrerCut != 0) owed[referrer] += referrerCut;

        emit FeeTaken(token, fee, creator, platformVault, referrer);
    }

    /// @notice Pull WETH owed to the caller. Pull-not-push: a reverting recipient
    ///         can only fail its own claim, never a swap.
    function claim() external returns (uint256 amount) {
        amount = owed[msg.sender];
        owed[msg.sender] = 0;
        if (amount != 0) IERC20(weth).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function _specified(PoolKey calldata key, bool zeroForOne, bool exactIn) internal pure returns (Currency) {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        return exactIn ? input : output;
    }
}
