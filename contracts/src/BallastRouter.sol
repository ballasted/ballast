// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinhoodV4Router, RobinhoodV4} from "./interfaces/IRobinhoodV4Router.sol";
import {IAllowanceTransfer} from "./interfaces/IPermit2.sol";

interface IUniswapV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IWETH9Router {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title BallastRouter — pay with any token that has a verified route, v1
///
/// @notice v1 SCOPE (design report `docs/phase2-combination-design.md` §4b,
///         decided 2026-09-26: ship direct-pool-only, defer aggregators):
///         leg 1 (tokenIn -> quoteAsset) only ever calls a pool from `routes`,
///         a small, CONSTRUCTOR-FIXED, append-only-at-deploy list of verified
///         v3-style (Uniswap v3 / Ramses v3 — identical swap/callback ABI)
///         pools. Leg 2 (quoteAsset <-> a Ballast v4 pool) always calls the
///         ONE fixed, independently verified UniversalRouter fork address
///         (contracts/src/interfaces/IRobinhoodV4Router.sol) — the exact
///         encoding proven against a live pool this session. No aggregator
///         leg exists yet; adding one later is a redeploy (see below), not a
///         rewrite.
///
/// @dev Security invariants (design report §4c), enforced structurally:
///      - EVERY external call this contract makes targets either (a) a pool
///        address from the fixed `routes` list, or (b) the fixed
///        `universalRouter` address. Never a caller-supplied arbitrary
///        target. `routeIndex` selects WHICH fixed route, never a target.
///      - Delta measurement, not trusted return values: every leg's actual
///        received amount is read from a balanceOf before/after, and that
///        real number (never a declared/quoted one) feeds the next leg.
///      - Exact Permit2 approvals, reset to zero immediately after use —
///        never an infinite/standing approval anywhere.
///      - No owner, no pause, no upgradeability, holds nothing between
///        calls — `routes` is set once at construction and immutable
///        after. Adding a route is a new deploy; the frontend just points at
///        the new address (see docs/phase2-combination-design.md §0's own
///        "redeploy is cheap by design" reasoning, same principle here).
///      - Dust is swept to `msg.sender` before the end-of-call clean-balance
///        assertion, so the assertion catches a real stuck-fund bug, not
///        ordinary rounding.
///
///      NOT solved here (flagged, not silently assumed away — design report
///      §10 risk #5): a token that rebases DURING a call (not just between
///      blocks) could move the leg-2 input after leg 1's delta was already
///      computed from it. There is no fully general on-chain way to detect
///      "this token rebases" on first contact with it; this contract does
///      not claim to. What IS enforced: the end-of-call zero-balance
///      assertion still catches any resulting stuck balance, so a rebasing
///      token can make a trade behave unexpectedly but cannot leave funds
///      trapped in this contract afterward.
contract BallastRouter {
    using SafeERC20 for IERC20;

    error DeadlineExpired();
    error InsufficientOutput();
    error UnknownRoute();
    error BadCallback();
    error DirtyBalance(address token, uint256 amount);
    error Reentrant();

    /// @dev Cheap defense-in-depth: routes are fixed to real, audited v3-style
    ///      pools whose own swap/callback mechanics don't reenter arbitrary
    ///      contracts, but a lock costs little and this contract moves real
    ///      user funds — no reason to rely solely on "the venues are trusted"
    ///      when a lock is this cheap.
    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @notice The one and only fixed leg-2 target — the independently
    ///         verified Robinhood UniversalRouter fork
    ///         (0x8876789976dEcBfCbBbe364623C63652db8C0904 at deploy time;
    ///         re-verify before reusing this address on any future chain).
    address public immutable universalRouter;
    /// @notice Canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3).
    address public immutable permit2;
    address public immutable weth;

    struct Route {
        address pool;
        address tokenA;
        address tokenB;
    }

    /// @notice Fixed, append-only-at-deploy leg-1 venues. Public for the
    ///         frontend to enumerate "which tokenIn values have a route" —
    ///         see design report §4d.
    Route[] public routes;

    constructor(address universalRouter_, address permit2_, address weth_, Route[] memory routes_) {
        universalRouter = universalRouter_;
        permit2 = permit2_;
        weth = weth_;
        for (uint256 i = 0; i < routes_.length; i++) {
            routes.push(routes_[i]);
        }
    }

    function routesLength() external view returns (uint256) {
        return routes.length;
    }

    receive() external payable {}

    // ===================================================================== //
    //  Buy                                                                  //
    // ===================================================================== //

    /// @notice Buy `ballastToken` by spending `amountIn` of `tokenIn`.
    /// @param routeIndex Ignored when tokenIn == quoteAsset.
    /// @param hook The Ballast pool's hook address for (ballastToken, quoteAsset).
    function buy(
        address tokenIn,
        uint256 amountIn,
        address quoteAsset,
        uint256 routeIndex,
        address ballastToken,
        address hook,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 quoteAmount =
            tokenIn == quoteAsset ? amountIn : _swapDirect(tokenIn, amountIn, quoteAsset, routeIndex);

        out = _swapBallastPool(quoteAsset, quoteAmount, ballastToken, hook, deadline);
        if (out < minOut) revert InsufficientOutput();

        IERC20(ballastToken).safeTransfer(msg.sender, out);
        _sweepAndAssertClean(tokenIn);
        if (quoteAsset != tokenIn) _sweepAndAssertClean(quoteAsset);
        _assertClean(ballastToken);
    }

    /// @notice Buy `ballastToken` with native ETH.
    function buyWithETH(address quoteAsset, uint256 routeIndex, address ballastToken, address hook, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        IWETH9Router(weth).deposit{value: msg.value}();

        uint256 quoteAmount =
            weth == quoteAsset ? msg.value : _swapDirect(weth, msg.value, quoteAsset, routeIndex);

        out = _swapBallastPool(quoteAsset, quoteAmount, ballastToken, hook, deadline);
        if (out < minOut) revert InsufficientOutput();

        IERC20(ballastToken).safeTransfer(msg.sender, out);
        if (quoteAsset != weth) _sweepAndAssertClean(quoteAsset);
        _sweepAndAssertClean(weth);
        _assertClean(ballastToken);
    }

    // ===================================================================== //
    //  Sell                                                                 //
    // ===================================================================== //

    /// @notice Sell `amountIn` of `ballastToken` for `tokenOut`.
    /// @param routeIndex Ignored when tokenOut == quoteAsset.
    function sell(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        address tokenOut,
        uint256 routeIndex,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        IERC20(ballastToken).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 quoteAmount = _swapBallastPool(ballastToken, amountIn, quoteAsset, hook, deadline);
        out = tokenOut == quoteAsset ? quoteAmount : _swapDirect(quoteAsset, quoteAmount, tokenOut, routeIndex);
        if (out < minOut) revert InsufficientOutput();

        IERC20(tokenOut).safeTransfer(msg.sender, out);
        _sweepAndAssertClean(ballastToken);
        if (tokenOut != quoteAsset) _sweepAndAssertClean(quoteAsset);
        _assertClean(tokenOut);
    }

    /// @notice Sell `amountIn` of `ballastToken` for native ETH.
    function sellToETH(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256 routeIndex,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        IERC20(ballastToken).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 quoteAmount = _swapBallastPool(ballastToken, amountIn, quoteAsset, hook, deadline);
        out = weth == quoteAsset ? quoteAmount : _swapDirect(quoteAsset, quoteAmount, weth, routeIndex);
        if (out < minOut) revert InsufficientOutput();

        IWETH9Router(weth).withdraw(out);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "eth send failed");

        _sweepAndAssertClean(ballastToken);
        if (quoteAsset != weth) _sweepAndAssertClean(quoteAsset);
        _assertClean(weth);
    }

    // ===================================================================== //
    //  Leg 1 — direct v3-style pool, constructor-fixed route list only      //
    // ===================================================================== //

    /// @dev Spends `amountIn` of `tokenIn` (already held by this contract)
    ///      for `tokenOut` through `routes[routeIndex]`. Reverts (array
    ///      out-of-bounds, or UnknownRoute) rather than falling back to any
    ///      other pool if the index doesn't match the requested pair — no
    ///      implicit "best route" search, the caller (frontend) already
    ///      chose which curated route to use.
    function _swapDirect(address tokenIn, uint256 amountIn, address tokenOut, uint256 routeIndex)
        internal
        returns (uint256 received)
    {
        Route memory r = routes[routeIndex];
        bool matches = (r.tokenA == tokenIn && r.tokenB == tokenOut) || (r.tokenA == tokenOut && r.tokenB == tokenIn);
        if (!matches) revert UnknownRoute();

        bool zeroForOne = tokenIn < tokenOut;
        uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3PoolSwap(r.pool).swap(address(this), zeroForOne, int256(amountIn), sqrtPriceLimitX96, abi.encode(tokenIn));
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @dev Uniswap-v3-style callback. Pays the pool from THIS contract's own
    ///      balance (it already holds tokenIn by the time _swapDirect runs —
    ///      unlike a router that never custodies funds between calls, this
    ///      one legitimately holds the user's input for the duration of a
    ///      single buy()/sell() call). msg.sender must be one of the fixed
    ///      route pools — never any other caller — so an attacker cannot
    ///      invoke this directly to move an arbitrary token out of the
    ///      contract; the token moved is exactly the one recorded in `data`
    ///      by our own _swapDirect call for the swap actually in progress.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        bool knownPool;
        for (uint256 i = 0; i < routes.length; i++) {
            if (routes[i].pool == msg.sender) {
                knownPool = true;
                break;
            }
        }
        if (!knownPool) revert BadCallback();

        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }

    // ===================================================================== //
    //  Leg 2 — Ballast v4 pool, always via the fixed UniversalRouter        //
    // ===================================================================== //

    /// @dev Swaps `amountIn` of `tokenIn` for `tokenOut` through the Ballast
    ///      v4 pool at (tokenIn, tokenOut, hook) — works for either buy
    ///      (quoteAsset -> ballastToken) or sell (ballastToken -> quoteAsset)
    ///      depending on which side is passed as tokenIn. The call target is
    ///      ALWAYS `universalRouter` (fixed); only the poolKey's currencies
    ///      and direction vary by argument — see the design report's note on
    ///      why a caller-supplied poolKey is safe here (bounded by the
    ///      caller's own minOut, never a redirected external call target).
    ///      No individual minOut on this leg — see buy()/sell()'s own final
    ///      check; TAKE_ALL's minAmount is set to 0 deliberately, matching
    ///      "minOut/deadline apply to the final output only."
    function _swapBallastPool(address tokenIn, uint256 amountIn, address tokenOut, address hook, uint256 deadline)
        internal
        returns (uint256 out)
    {
        bool tokenInIsCurrency0 = tokenIn < tokenOut;
        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: tokenInIsCurrency0 ? tokenIn : tokenOut,
            currency1: tokenInIsCurrency0 ? tokenOut : tokenIn,
            fee: 0,
            tickSpacing: 60,
            hooks: hook
        });

        IERC20(tokenIn).forceApprove(permit2, amountIn);
        IAllowanceTransfer(permit2).approve(tokenIn, universalRouter, uint160(amountIn), uint48(deadline));

        RobinhoodV4.ExactInputSingleParams memory params = RobinhoodV4.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: tokenInIsCurrency0,
            amountIn: uint128(amountIn),
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(
            RobinhoodV4.ACT_SWAP_EXACT_IN_SINGLE, RobinhoodV4.ACT_SETTLE_ALL, RobinhoodV4.ACT_TAKE_ALL
        );
        bytes[] memory v4Params = new bytes[](3);
        v4Params[0] = abi.encode(params);
        v4Params[1] = abi.encode(tokenIn, amountIn);
        v4Params[2] = abi.encode(tokenOut, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, v4Params);
        bytes memory commands = abi.encodePacked(RobinhoodV4.CMD_V4_SWAP);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IRobinhoodV4Router(universalRouter).execute(commands, inputs, deadline);
        out = IERC20(tokenOut).balanceOf(address(this)) - before;

        // Exact-approval hygiene: reset immediately, never leave a standing
        // allowance for either Permit2 itself or the router-as-spender.
        IAllowanceTransfer(permit2).approve(tokenIn, universalRouter, 0, 0);
        IERC20(tokenIn).forceApprove(permit2, 0);
    }

    // ===================================================================== //
    //  Cleanup                                                              //
    // ===================================================================== //

    function _sweepAndAssertClean(address token) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) IERC20(token).safeTransfer(msg.sender, bal);
        _assertClean(token);
    }

    function _assertClean(address token) internal view {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) revert DirtyBalance(token, bal);
    }
}
