// SPDX-License-Identifier: MIT
// Pinned to 0.8.26, not this repo's usual 0.8.28 — this file imports
// v4-periphery's V4Router.sol, itself pinned to exactly 0.8.26, same reason
// BallastRouterV2.sol carries the identical pin (one Solidity import graph
// can only ever compile under one version).
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {V4Router} from "v4-periphery/src/V4Router.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "v4-periphery/src/libraries/ActionConstants.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

interface IWETH9Basket {
    function deposit() external payable;
}

/// @dev The slice of BallastFactory's public surface BasketZap needs to resolve
///      (treasury, creator) for a launch token. `launches(id)` is the
///      auto-generated getter for `Launch[] public launches` — Solidity omits
///      the dynamic `quoteAssets` array member from the tuple, so it returns
///      exactly (token, treasury, creator) (see contracts/src/BallastFactory.sol
///      and docs/BASKET_DISCOVERY.md §1, confirmed live on-chain).
interface IBallastFactoryBasket {
    function launchIdOf(address token) external view returns (uint256);
    function launches(uint256 id) external view returns (address token, address treasury, address creator);
}

/// @title BasketZap — swap ETH into up to 6 stock tokens in one transaction,
///        for a Ballast launch's creator to then deposit into their own treasury.
///
/// @notice Immutable, no owner, no admin, no pause, no upgrade, no rescue
///         function of any kind. Holds no funds between calls.
///
/// @dev REWRITE (docs/BASKET_DISCOVERY.md, this session): the original version
///      of this contract routed each leg through the external UniversalRouter
///      against a caller-supplied single-hop WETH/<asset> PoolKey. Discovery
///      found zero such pools exist — real stock-token liquidity on this chain
///      is multi-hop (ETH -> USDG -> stock, Fables v4 hooks) or lives on Ramses
///      v3 pools, which the external UniversalRouter cannot reach at all (its
///      V3 swap path is hardcoded to Uniswap's own V3 factory/init-code-hash,
///      confirmed empirically — a Ramses pool requires a caller that
///      implements `uniswapV3SwapCallback` and is willing to target a
///      non-Uniswap factory's pool directly, which the external router does
///      not do). `BallastRouterV2` (contracts/src/BallastRouterV2.sol) already
///      solved exactly this problem for ETH -> quoteAsset acquisition, by
///      inheriting v4-periphery's `V4Router` directly (calling
///      `poolManager.unlock()` itself instead of going through the external
///      UniversalRouter) for Fables, and implementing the Uniswap-v3-style
///      swap-callback pattern directly for Ramses. BasketZap now follows the
///      IDENTICAL pattern — same fixed `fablesHops`/`ramsesRoutes` tables,
///      same per-venue attempt-with-fallback shape — but stops at the stock
///      token (no leg 2 into a Ballast pool; BallastRouterV2's leg 2 is not
///      optional in its own code, so it could not be reused directly for a
///      basket swap, see docs/BASKET_DISCOVERY.md for the full writeup) and
///      sends the output straight to the launch creator instead of back to
///      `msg.sender`.
///
///      Routes are NOT caller-supplied: unlike the original version (which let
///      the caller pick any fee/tickSpacing/hooks — safe only because a bad
///      choice could only ever hurt the caller themselves), every leg now
///      selects hops by INDEX into this contract's own fixed, construction-time
///      `fablesHops`/`ramsesRoutes` tables — exactly `BallastRouterV2`'s own
///      convention. A wrong index either fails to chain (`BadHopChain`) or
///      chains to the wrong asset (also `BadHopChain`); it can never reach an
///      address outside the fixed tables. This is strictly safer than the
///      prior caller-supplied-PoolKey design, not just a routing fix.
///
///      Each leg tries its preferred venue first (an off-chain quote decides
///      which, same as `BallastRouterV2.buyWithETH`) and falls back to the
///      other venue in the SAME transaction if the first reverts — thin
///      liquidity on one venue for a given ticker (confirmed in research: PLTR
///      and COIN are routinely thin/reverting on Fables) no longer means the
///      whole basket has to fail. `minOut` is checked exactly once per leg,
///      after whichever attempt actually produced an output — never
///      per-venue — so a too-high minOut fails cleanly regardless of which
///      venue got further. The WHOLE basket stays all-or-nothing: if a leg
///      exhausts both venues (or its winning venue undershoots `minOut`), the
///      entire `swapBasket` call reverts, including every leg that already
///      succeeded earlier in the loop.
contract BasketZap is V4Router, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEGS = 6;
    uint256 public constant BPS = 10_000;

    /// @notice Same band as OpenTreasuryVault's deposit-time oracle guard
    ///         (contracts/src/OpenTreasuryVault.sol) — 20%, widening by one more
    ///         increment every 7 days since this contract's own last-seen price
    ///         for that asset, capped at 4x (80%), so a long-idle asset isn't
    ///         permanently stuck behind a price move that happened while nobody
    ///         was swapping it here.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 2_000;
    uint256 public constant DEVIATION_WIDEN_PERIOD = 7 days;
    uint256 public constant MAX_DEVIATION_WIDEN_PERIODS = 4;

    IBallastFactoryBasket public immutable factory;
    IAssetRegistry public immutable registry;
    address public immutable weth;

    /// @notice This contract's own last-seen price per asset, for the deviation
    ///         breaker — scoped to BasketZap globally (every launch, every
    ///         caller), same as OpenTreasuryVault's equivalent mapping.
    mapping(address asset => uint256) public lastPrice;
    mapping(address asset => uint256) public lastPriceAt;

    /// @notice A fixed Fables v4 PoolKey leg. Dynamic fee pools only (every
    ///         Fables pool we use runs the v4 dynamic-fee sentinel).
    struct FablesHop {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice A fixed Ramses-v3-style pool, pool address plus its two tokens —
    ///         exactly `BallastRouterV2.RamsesRoute`.
    struct RamsesRoute {
        address pool;
        address tokenA;
        address tokenB;
    }

    FablesHop[] public fablesHops;
    RamsesRoute[] public ramsesRoutes;

    struct Leg {
        address asset;
        uint16 weightBps;
        bool preferFables;
        uint256[] fablesHopIdx; // ETH -> ... -> asset; empty = no Fables route for this asset
        uint256[] ramsesHopIdx; // WETH -> ... -> asset; empty = no Ramses route for this asset
        uint256 minOut;
    }

    event BasketSwapped(
        address indexed launchToken,
        address indexed creator,
        uint256 ethIn,
        uint256 ethRefunded,
        address[] assets,
        uint16[] weightsBps,
        uint256[] amountsOut,
        bool[] usedFables
    );

    error ZeroAddress();
    error NotCreator();
    error UnknownLaunch();
    error NoLegs();
    error TooManyLegs();
    error WeightsMustSumToBps();
    error DuplicateAsset(address asset);
    error SelfBacking(address asset);
    error ZeroEthIn();
    error SwapDeadlineExpired();
    error AssetNotAllowed(address asset);
    error InvalidPrice(address asset);
    error StalePrice(address asset, uint256 updatedAt);
    error PriceDeviationTooLarge(address asset, uint256 lastPrice_, uint256 newPrice);
    error MinOutTooLow();
    error InsufficientOutput(address asset, uint256 out, uint256 minOut);
    error AllVenuesFailedForLeg(address asset);
    error NoRamsesRoute();
    error BadHopChain();
    error NotSelf();

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(
        address factory_,
        address registry_,
        IPoolManager poolManager_,
        address weth_,
        FablesHop[] memory fablesHops_,
        RamsesRoute[] memory ramsesRoutes_
    ) V4Router(poolManager_) {
        if (factory_ == address(0) || registry_ == address(0) || weth_ == address(0) || address(poolManager_) == address(0)) {
            revert ZeroAddress();
        }
        factory = IBallastFactoryBasket(factory_);
        registry = IAssetRegistry(registry_);
        weth = weth_;
        for (uint256 i = 0; i < fablesHops_.length; i++) {
            fablesHops.push(fablesHops_[i]);
        }
        for (uint256 i = 0; i < ramsesRoutes_.length; i++) {
            ramsesRoutes.push(ramsesRoutes_[i]);
        }
    }

    function fablesHopsLength() external view returns (uint256) {
        return fablesHops.length;
    }

    function ramsesRoutesLength() external view returns (uint256) {
        return ramsesRoutes.length;
    }

    receive() external payable {}

    /// @notice Never actually invoked at runtime: every SETTLE/TAKE action this
    ///         contract builds uses an explicit payer/recipient (`false` /
    ///         `creator`), never the MSG_SENDER sentinel — see attemptFablesLeg
    ///         / attemptRamsesLeg. Still required: V4Router's base contract
    ///         declares this abstract.
    function msgSender() public view override returns (address) {
        return address(this);
    }

    /// @notice Swap `msg.value` ETH across `legs` (weights in bps, summing to
    ///         10000) into up to 6 AssetRegistry-listed stock tokens, and send
    ///         every output straight to `launchToken`'s creator. All-or-nothing:
    ///         any leg failing on BOTH venues (or undershooting its own
    ///         minOut) reverts the ENTIRE call, including legs that already
    ///         succeeded earlier in the loop. Unused ETH left over from integer-
    ///         division weight rounding is refunded to the creator as native
    ///         ETH (computed before any swap executes, never left in this
    ///         contract).
    /// @param launchToken The Ballast launch token whose creator receives every
    ///        leg's output. Resolved against the factory, not trusted as a raw
    ///        parameter — see IBallastFactoryBasket above.
    /// @param swapDeadline A timestamp deadline for every leg (this chain has
    ///        ~100ms blocks — use time, never a block number).
    function swapBasket(address launchToken, Leg[] calldata legs, uint256 swapDeadline)
        external
        payable
        nonReentrant
        returns (uint256[] memory amountsOut, bool[] memory usedFables)
    {
        if (block.timestamp > swapDeadline) revert SwapDeadlineExpired();
        if (msg.value == 0) revert ZeroEthIn();

        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_LEGS) revert TooManyLegs();

        uint256 idPlusOne = factory.launchIdOf(launchToken);
        if (idPlusOne == 0) revert UnknownLaunch();
        (,, address creator) = factory.launches(idPlusOne - 1);
        if (msg.sender != creator) revert NotCreator();

        uint256 sumWeights;
        for (uint256 i = 0; i < n; i++) {
            address asset = legs[i].asset;
            if (asset == launchToken) revert SelfBacking(asset);
            sumWeights += legs[i].weightBps;
            for (uint256 j = i + 1; j < n; j++) {
                if (legs[j].asset == asset) revert DuplicateAsset(asset);
            }
        }
        if (sumWeights != BPS) revert WeightsMustSumToBps();

        amountsOut = new uint256[](n);
        usedFables = new bool[](n);
        address[] memory assetsOut = new address[](n);
        uint16[] memory weightsOut = new uint16[](n);
        uint256 spent;

        for (uint256 i = 0; i < n; i++) {
            Leg calldata leg = legs[i];
            assetsOut[i] = leg.asset;
            weightsOut[i] = leg.weightBps;

            if (!registry.isAllowed(leg.asset)) revert AssetNotAllowed(leg.asset);
            if (leg.minOut == 0) revert MinOutTooLow();
            _checkFreshPrice(leg.asset);

            uint256 amountIn = (msg.value * leg.weightBps) / BPS;
            if (amountIn == 0) continue;
            spent += amountIn;

            (uint256 out, bool usedF) = _swapLegToCreator(leg, amountIn, creator, swapDeadline);
            if (out < leg.minOut) revert InsufficientOutput(leg.asset, out, leg.minOut);
            amountsOut[i] = out;
            usedFables[i] = usedF;
        }

        uint256 refund = msg.value - spent;
        if (refund > 0) {
            (bool sent,) = creator.call{value: refund}("");
            require(sent, "eth refund failed");
        }

        emit BasketSwapped(launchToken, creator, msg.value, refund, assetsOut, weightsOut, amountsOut, usedFables);
    }

    /// @dev Same staleness bound + 20% (widening) deviation breaker
    ///      OpenTreasuryVault enforces at deposit time
    ///      (contracts/src/OpenTreasuryVault.sol `_priceAndValue`), replicated
    ///      here as a pure gate (no USD value needed — minOut, sourced from a
    ///      live pool quote, is what actually protects the swap's execution
    ///      price). Never multiplies the feed price by `uiMultiplier()` — the
    ///      feed price already includes it (CLAUDE.md rule 7).
    function _checkFreshPrice(address asset) internal {
        address feedAddr = registry.feedOf(asset);
        if (feedAddr == address(0)) revert AssetNotAllowed(asset);
        AggregatorV3Interface feed = AggregatorV3Interface(feedAddr);

        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice(asset);
        uint256 price = uint256(answer);

        uint256 staleAfter = registry.staleAfter(asset);
        if (block.timestamp - updatedAt > staleAfter) revert StalePrice(asset, updatedAt);

        uint256 last = lastPrice[asset];
        if (last != 0) {
            uint256 periods = (block.timestamp - lastPriceAt[asset]) / DEVIATION_WIDEN_PERIOD;
            if (periods > MAX_DEVIATION_WIDEN_PERIODS - 1) periods = MAX_DEVIATION_WIDEN_PERIODS - 1;
            uint256 bandBps = MAX_PRICE_DEVIATION_BPS * (periods + 1);
            uint256 lo = (last * (BPS - bandBps)) / BPS;
            uint256 hi = (last * (BPS + bandBps)) / BPS;
            if (price < lo || price > hi) revert PriceDeviationTooLarge(asset, last, price);
        }
        lastPrice[asset] = price;
        lastPriceAt[asset] = block.timestamp;
    }

    // ===================================================================== //
    //  Per-leg venue selection + fallback (mirrors BallastRouterV2)         //
    // ===================================================================== //

    function _swapLegToCreator(Leg calldata leg, uint256 amountIn, address creator, uint256 deadline)
        private
        returns (uint256 out, bool usedFables)
    {
        bool ok;
        if (leg.preferFables) {
            (ok, out) = _tryFables(leg.asset, leg.fablesHopIdx, amountIn, creator, deadline);
            usedFables = ok;
            if (!ok) (ok, out) = _tryRamses(leg.asset, leg.ramsesHopIdx, amountIn, creator, deadline);
        } else {
            (ok, out) = _tryRamses(leg.asset, leg.ramsesHopIdx, amountIn, creator, deadline);
            if (!ok) {
                (ok, out) = _tryFables(leg.asset, leg.fablesHopIdx, amountIn, creator, deadline);
                usedFables = ok;
            }
        }
        if (!ok) revert AllVenuesFailedForLeg(leg.asset);
    }

    function _tryFables(address asset, uint256[] calldata hopIdx, uint256 amountIn, address creator, uint256 deadline)
        private
        returns (bool ok, uint256 out)
    {
        if (hopIdx.length == 0) return (false, 0);
        try this.attemptFablesLeg{value: amountIn}(asset, hopIdx, creator, deadline) returns (uint256 o) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    function _tryRamses(address asset, uint256[] calldata hopIdx, uint256 amountIn, address creator, uint256 deadline)
        private
        returns (bool ok, uint256 out)
    {
        if (hopIdx.length == 0) return (false, 0);
        try this.attemptRamsesLeg{value: amountIn}(asset, hopIdx, creator, deadline) returns (uint256 o) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Self-call only. Native ETH -> (Fables multi-hop) -> `asset`, in
    ///         ONE PoolManager.unlock(). Output lands directly on `creator` via
    ///         an explicit TAKE recipient (never the MSG_SENDER sentinel, so
    ///         `msgSender()` above is never actually consulted).
    function attemptFablesLeg(address asset, uint256[] calldata hopIdx, address creator, uint256 deadline)
        external
        payable
        onlySelf
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert SwapDeadlineExpired();
        PathKey[] memory path = _buildFablesPath(hopIdx, Currency.wrap(address(0)), Currency.wrap(asset));

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN), uint8(Actions.SETTLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: Currency.wrap(address(0)),
                path: path,
                minHopPriceX36: new uint256[](0),
                amountIn: uint128(msg.value),
                amountOutMinimum: 0 // minOut is enforced once in swapBasket against the real output
            })
        );
        // SETTLE: native currency ignores the payer flag (always pays from this
        // contract's own balance, which already holds msg.value); OPEN_DELTA
        // settles the exact net debt.
        params[1] = abi.encode(Currency.wrap(address(0)), ActionConstants.OPEN_DELTA, false);
        // TAKE: explicit recipient = the launch creator, not a sentinel — the
        // output never passes through this contract's own balance.
        params[2] = abi.encode(Currency.wrap(asset), creator, ActionConstants.OPEN_DELTA);

        uint256 before = IERC20(asset).balanceOf(creator);
        poolManager.unlock(abi.encode(actions, params));
        out = IERC20(asset).balanceOf(creator) - before;
    }

    /// @notice Self-call only. Native ETH -> WETH -> (1-2 Ramses hops) ->
    ///         `asset`, synchronously. Output is sent to `creator` directly
    ///         after the chain completes (Ramses swaps always land on this
    ///         contract first — see `_runRamsesChain` — there is no "explicit
    ///         recipient" option on a raw Uniswap-v3-style pool swap).
    function attemptRamsesLeg(address asset, uint256[] calldata hopIdx, address creator, uint256 deadline)
        external
        payable
        onlySelf
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert SwapDeadlineExpired();
        if (hopIdx.length == 0) revert NoRamsesRoute();
        IWETH9Basket(weth).deposit{value: msg.value}();
        out = _runRamsesChain(hopIdx, weth, asset, msg.value);
        IERC20(asset).safeTransfer(creator, out);
    }

    // ===================================================================== //
    //  ERC20 payment hook required by V4Router's DeltaResolver              //
    // ===================================================================== //

    /// @dev Never actually reached: every Fables leg's SETTLE targets native
    ///      currency (address(0)), which DeltaResolver settles via
    ///      `poolManager.settle{value: amount}()` directly, bypassing `_pay`
    ///      entirely. Implemented anyway — V4Router declares this abstract —
    ///      with the same shape BallastRouterV2 uses, in case a future hop
    ///      table ever introduces an ERC20-denominated entry currency.
    function _pay(Currency token, address payer, uint256 amount) internal override {
        address asset = Currency.unwrap(token);
        if (payer == address(this)) {
            IERC20(asset).safeTransfer(address(poolManager), amount);
        } else {
            IERC20(asset).safeTransferFrom(payer, address(poolManager), amount);
        }
    }

    // ===================================================================== //
    //  Shared helpers — mirror BallastRouterV2's private helpers exactly    //
    // ===================================================================== //

    /// @dev Builds a PathKey[] by walking `fablesHops[idx]` in order, tracking
    ///      the running "current currency" and requiring each hop to actually
    ///      connect to it. Reverts (BadHopChain) if the first hop doesn't start
    ///      at `entryCurrency` or the chain doesn't end at `exitCurrency` —
    ///      this is what makes "caller selects fixed indices" as safe as
    ///      "caller selects a fixed target": a wrong index either doesn't chain
    ///      (revert here) or chains to the wrong final currency (revert here).
    function _buildFablesPath(uint256[] memory idx, Currency entryCurrency, Currency exitCurrency)
        private
        view
        returns (PathKey[] memory path)
    {
        if (idx.length == 0) revert BadHopChain();
        path = new PathKey[](idx.length);
        Currency cur = entryCurrency;
        for (uint256 i = 0; i < idx.length; i++) {
            FablesHop memory h = fablesHops[idx[i]];
            Currency c0 = Currency.wrap(h.currency0);
            Currency c1 = Currency.wrap(h.currency1);
            Currency next;
            if (Currency.unwrap(cur) == Currency.unwrap(c0)) {
                next = c1;
            } else if (Currency.unwrap(cur) == Currency.unwrap(c1)) {
                next = c0;
            } else {
                revert BadHopChain();
            }
            path[i] = PathKey({
                intermediateCurrency: next,
                fee: h.fee,
                tickSpacing: h.tickSpacing,
                hooks: IHooks(h.hooks),
                hookData: bytes("")
            });
            cur = next;
        }
        if (Currency.unwrap(cur) != Currency.unwrap(exitCurrency)) revert BadHopChain();
    }

    /// @dev Runs 1 or 2 fixed Ramses-style v3 callback swaps in sequence,
    ///      tokenIn -> [intermediate] -> tokenOut, using `routeIdx` as ordered
    ///      indices into `ramsesRoutes`. Each hop's swap pays the pool from
    ///      `address(this)`'s own balance (this contract always holds the
    ///      leg's input by the time this runs — either from `weth.deposit` or
    ///      from the previous hop's output).
    function _runRamsesChain(uint256[] memory routeIdx, address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 amountOut)
    {
        address cur = tokenIn;
        uint256 amt = amountIn;
        for (uint256 i = 0; i < routeIdx.length; i++) {
            RamsesRoute memory r = ramsesRoutes[routeIdx[i]];
            address next;
            if (r.tokenA == cur) {
                next = r.tokenB;
            } else if (r.tokenB == cur) {
                next = r.tokenA;
            } else {
                revert BadHopChain();
            }
            amt = _swapRamsesDirect(r.pool, cur, next, amt);
            cur = next;
        }
        if (cur != tokenOut) revert BadHopChain();
        amountOut = amt;
    }

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    function _swapRamsesDirect(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 received)
    {
        bool zeroForOne = tokenIn < tokenOut;
        uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3PoolSwap(pool).swap(address(this), zeroForOne, int256(amountIn), sqrtPriceLimitX96, abi.encode(tokenIn));
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @dev Uniswap-v3-style callback. msg.sender must be one of the fixed
    ///      `ramsesRoutes` pools — never any other caller.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        bool knownPool;
        for (uint256 i = 0; i < ramsesRoutes.length; i++) {
            if (ramsesRoutes[i].pool == msg.sender) {
                knownPool = true;
                break;
            }
        }
        if (!knownPool) revert BadHopChain();

        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }
}

interface IUniswapV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}
