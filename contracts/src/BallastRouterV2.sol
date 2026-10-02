// SPDX-License-Identifier: MIT
// Pinned to 0.8.26, not this repo's usual 0.8.28 — this file imports
// v4-periphery's V4Router.sol, itself pinned to exactly 0.8.26, and one
// Solidity import graph can only ever compile under one version. Every other
// contract (Hook/Factory/Router v1/etc) keeps its own 0.8.28 pin untouched;
// forge compiles each per its own pragma (see foundry.toml's removed global
// `solc` override).
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {V4Router} from "v4-periphery/src/V4Router.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "v4-periphery/src/libraries/ActionConstants.sol";

/// @title BallastRouterV2 — ETH -> stock -> Ballast pool, routed over Fables OR Ramses v3,
///        chosen per call off-chain, with an on-chain fallback to the other venue.
///
/// @notice v2 SCOPE, decided after the Fables-vs-Ramses research pass (docs: phase-2 go
///         message 2026-10-02):
///         - Leg 1 (ETH -> quoteAsset) is EITHER a fixed Fables v4 hop chain (multi-hop,
///           same PoolManager we use for our own pool — settled in ONE unlock together
///           with leg 2) OR a fixed Ramses-v3-style pool chain (1 or 2 hops, synchronous
///           callback swaps, exactly BallastRouter v1's mechanism, generalized to 2 hops
///           for the assets with no direct WETH pool).
///         - Leg 2 (quoteAsset -> ballastToken, our own hook) is ALWAYS executed through
///           this contract's own inherited V4Router machinery — never through the external
///           UniversalRouter fork. When the chosen venue is Fables, leg 2 rides inside the
///           SAME unlock as leg 1 (one PoolManager.unlock() for the whole buy). When the
///           chosen venue is Ramses, leg 2 gets its own (still internal, no external router
///           hop) unlock after leg 1 settles synchronously.
///         - The caller (frontend, quoting off V4Quoter + Ramses QuoterV2 at call time)
///           supplies which venue to try FIRST and the fixed-table hop indices for BOTH
///           venues. If the preferred venue's attempt reverts for any reason (observed in
///           research: genuine NotEnoughLiquidity on several Fables pools, and
///           floored/near-dead Ramses pools on others), this contract retries the other
///           venue in the SAME transaction before failing. minOut is checked exactly once,
///           after whichever attempt actually produced an output — never per-venue — so a
///           too-high minOut fails cleanly with InsufficientOutput regardless of which
///           venue got further, instead of being silently absorbed as a "this venue failed"
///           signal that would wrongly trigger a fallback.
///
/// @dev Security invariants, carried over from BallastRouter v1 and still enforced
///      structurally:
///      - EVERY external call this contract makes targets either (a) a Ramses pool from
///        the fixed `ramsesRoutes` list, (b) a Fables pool key built ONLY from the fixed
///        `fablesHops` list, or (c) the fixed PoolManager. Never a caller-supplied
///        arbitrary target — the caller selects WHICH fixed entries via index, never an
///        address. A hop index out of range reverts (array OOB); a chain whose currencies
///        don't actually connect reverts (`BadHopChain`).
///      - Delta measurement: every leg's actual received amount is read from a real
///        balance delta, never a declared one.
///      - No owner, no pause, no upgradeability, holds nothing of the user's between
///        calls (dust is swept back to the caller before the end-of-call clean-balance
///        assertion). `ramsesRoutes` and `fablesHops` are set once at construction and
///        immutable after — adding a route/hop is a new deploy, same as v1.
///      - The "attempt this venue" entry points are external (so they can be wrapped in
///        try/catch from the outer buy/sell function) but gated to `msg.sender ==
///        address(this)` — only this contract's own outer function can ever call them.
contract BallastRouterV2 is V4Router {
    using SafeERC20 for IERC20;

    error DeadlineExpired();
    error InsufficientOutput();
    error AllVenuesFailed();
    error NotSelf();
    error BadHopChain();
    error NoRamsesRoute();
    error DirtyBalance(address token, uint256 amount);
    error Reentrant();

    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    /// @notice The real caller behind the current buy/sell, captured once per attempt
    ///         function via `msgSender()` into a local `locker` and then used to build
    ///         EXPLICIT `TAKE`/`SETTLE` action params (recipient / payerIsUser) — never
    ///         via the `TAKE_ALL`/`SETTLE_ALL` sentinel actions, which always resolve
    ///         through `msgSender()` and so cannot express "pay from this contract's own
    ///         balance, but send the output to the original caller" within one unlock
    ///         (exactly the shape every multi-leg attempt here needs). `swapExactOutputSingleFables`
    ///         is the one single-leg exception and still uses the ALL-sentinel actions,
    ///         for which this resolves correctly throughout.
    address private _locker;

    function msgSender() public view override returns (address) {
        return _locker;
    }

    address public immutable weth;

    /// @notice A fixed Uniswap-v3-style (Ramses or compatible) pool, exactly
    ///         BallastRouter v1's `Route` — pool address plus its two tokens.
    struct RamsesRoute {
        address pool;
        address tokenA;
        address tokenB;
    }

    /// @notice A fixed Fables v4 PoolKey. Dynamic fee pools only (fee is always the v4
    ///         dynamic-fee sentinel on every Fables pool we use; stored anyway so a hop's
    ///         full key is self-contained and never caller-assembled).
    struct FablesHop {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    RamsesRoute[] public ramsesRoutes;
    FablesHop[] public fablesHops;

    constructor(IPoolManager poolManager_, address weth_, RamsesRoute[] memory ramsesRoutes_, FablesHop[] memory fablesHops_)
        V4Router(poolManager_)
    {
        weth = weth_;
        for (uint256 i = 0; i < ramsesRoutes_.length; i++) {
            ramsesRoutes.push(ramsesRoutes_[i]);
        }
        for (uint256 i = 0; i < fablesHops_.length; i++) {
            fablesHops.push(fablesHops_[i]);
        }
    }

    function ramsesRoutesLength() external view returns (uint256) {
        return ramsesRoutes.length;
    }

    function fablesHopsLength() external view returns (uint256) {
        return fablesHops.length;
    }

    receive() external payable {}

    // ===================================================================== //
    //  ERC20 payment hook required by V4Router's DeltaResolver              //
    // ===================================================================== //

    /// @dev Called by DeltaResolver._settle for every non-native currency. `payer` is
    ///      either `address(this)` (leg 1's output already sitting here — plain
    ///      transfer) or `msgSender()` (the original caller — transferFrom, requires
    ///      their prior approval; only used by `sell`'s ballastToken pull, which this
    ///      contract does itself via transferFrom before entering any unlock, so in
    ///      practice every `_pay` here pays from `address(this)`'s own balance).
    function _pay(Currency token, address payer, uint256 amount) internal override {
        address asset = Currency.unwrap(token);
        if (payer == address(this)) {
            IERC20(asset).safeTransfer(address(poolManager), amount);
        } else {
            IERC20(asset).safeTransferFrom(payer, address(poolManager), amount);
        }
    }

    // ===================================================================== //
    //  Buy: ETH -> quoteAsset (Fables or Ramses) -> ballastToken (our hook)  //
    // ===================================================================== //

    /// @param fablesHopIdx Ordered indices into `fablesHops`, ETH -> ... -> quoteAsset.
    ///        Empty if this quoteAsset has no Fables route (e.g. SGOV/GOOGL/MSFT/AMD/ORCL).
    /// @param ramsesHopIdx Ordered indices into `ramsesRoutes`, WETH -> ... -> quoteAsset.
    ///        Must be non-empty — every quoteAsset keeps a Ramses route.
    /// @param preferFables Which venue to attempt first. Chosen off-chain from a live
    ///        V4Quoter (Fables) vs Ramses QuoterV2 quote at call time — this contract does
    ///        not search for the better venue, it only knows how to run either one.
    function buyWithETH(
        uint256[] calldata fablesHopIdx,
        uint256[] calldata ramsesHopIdx,
        bool preferFables,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 minOut,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 out, bool usedFables) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _locker = msg.sender;

        bool ok;
        if (preferFables) {
            (ok, out) = _tryFablesBuy(fablesHopIdx, quoteAsset, ballastToken, hook, deadline);
            usedFables = ok;
            if (!ok) (ok, out) = _tryRamsesBuy(ramsesHopIdx, quoteAsset, ballastToken, hook, deadline);
        } else {
            (ok, out) = _tryRamsesBuy(ramsesHopIdx, quoteAsset, ballastToken, hook, deadline);
            if (!ok) {
                (ok, out) = _tryFablesBuy(fablesHopIdx, quoteAsset, ballastToken, hook, deadline);
                usedFables = ok;
            }
        }
        if (!ok) revert AllVenuesFailed();
        if (out < minOut) revert InsufficientOutput();

        _locker = address(0);
        // Both attempts land the output directly on msg.sender via TAKE_ALL inside their
        // own unlock (see attemptFablesBuy/attemptRamsesBuy) — nothing to sweep for
        // ballastToken. Any native ETH dust (there shouldn't be any: exact-input chains
        // consume amountIn exactly) goes back to the caller, never left behind.
        uint256 dust = address(this).balance;
        if (dust != 0) {
            (bool sent,) = msg.sender.call{value: dust}("");
            require(sent, "eth dust refund failed");
        }
    }

    function _tryFablesBuy(
        uint256[] calldata fablesHopIdx,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 deadline
    ) private returns (bool ok, uint256 out) {
        if (fablesHopIdx.length == 0) return (false, 0);
        try this.attemptFablesBuy{value: msg.value}(fablesHopIdx, quoteAsset, ballastToken, hook, deadline) returns (
            uint256 o
        ) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    function _tryRamsesBuy(
        uint256[] calldata ramsesHopIdx,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 deadline
    ) private returns (bool ok, uint256 out) {
        if (ramsesHopIdx.length == 0) return (false, 0);
        try this.attemptRamsesBuy{value: msg.value}(ramsesHopIdx, quoteAsset, ballastToken, hook, deadline) returns (
            uint256 o
        ) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Self-call only. ETH -> (Fables multi-hop) -> quoteAsset -> (our hook) ->
    ///         ballastToken, all inside ONE PoolManager.unlock(). Output lands on
    ///         `msgSender()` (the original caller) directly via TAKE_ALL.
    function attemptFablesBuy(
        uint256[] calldata fablesHopIdx,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 deadline
    ) external payable onlySelf returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address locker = msgSender();
        PathKey[] memory path = _buildFablesPath(fablesHopIdx, Currency.wrap(address(0)), Currency.wrap(quoteAsset));

        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN),
            uint8(Actions.SWAP_EXACT_IN_SINGLE),
            uint8(Actions.SETTLE),
            uint8(Actions.TAKE)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: Currency.wrap(address(0)),
                path: path,
                minHopPriceX36: new uint256[](0),
                amountIn: uint128(msg.value),
                amountOutMinimum: 0
            })
        );
        // OPEN_DELTA: spend exactly what the Fables path (params[0]) just credited in
        // quoteAsset, not a guessed amount.
        params[1] = abi.encode(_ourPoolExactInSingle(quoteAsset, ballastToken, hook, ActionConstants.OPEN_DELTA));
        // SETTLE: native currency ignores the payer flag (always pays from this
        // contract's own balance); OPEN_DELTA settles the exact net debt.
        params[2] = abi.encode(Currency.wrap(address(0)), ActionConstants.OPEN_DELTA, false);
        // TAKE: explicit recipient = the REAL caller, not the msgSender() sentinel —
        // this is what lets the final output skip a second transfer.
        params[3] = abi.encode(Currency.wrap(ballastToken), locker, ActionConstants.OPEN_DELTA);

        uint256 before = IERC20(ballastToken).balanceOf(locker);
        poolManager.unlock(abi.encode(actions, params));
        out = IERC20(ballastToken).balanceOf(locker) - before;
    }

    /// @notice Self-call only. WETH -> (1-2 Ramses hops) -> quoteAsset synchronously, then
    ///         quoteAsset -> ballastToken through our hook in its own unlock. Output lands
    ///         on `msgSender()` directly via TAKE_ALL.
    function attemptRamsesBuy(
        uint256[] calldata ramsesHopIdx,
        address quoteAsset,
        address ballastToken,
        address hook,
        uint256 deadline
    ) external payable onlySelf returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address locker = msgSender();
        IWETH9(weth).deposit{value: msg.value}();

        uint256 quoteAmount = _runRamsesChain(ramsesHopIdx, weth, quoteAsset, msg.value);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(_ourPoolExactInSingle(quoteAsset, ballastToken, hook, uint128(quoteAmount)));
        // SETTLE payerIsUser=false: pay from THIS contract's own balance (leg 1's
        // Ramses output is already sitting here), never from the original caller.
        params[1] = abi.encode(Currency.wrap(quoteAsset), quoteAmount, false);
        params[2] = abi.encode(Currency.wrap(ballastToken), locker, ActionConstants.OPEN_DELTA);

        uint256 before = IERC20(ballastToken).balanceOf(locker);
        poolManager.unlock(abi.encode(actions, params));
        out = IERC20(ballastToken).balanceOf(locker) - before;
    }

    // ===================================================================== //
    //  Sell: ballastToken -> quoteAsset (our hook) -> ETH (Fables or Ramses) //
    // ===================================================================== //

    function sellToETH(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata fablesHopIdx,
        uint256[] calldata ramsesHopIdx,
        bool preferFables,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 out, bool usedFables) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _locker = msg.sender;
        IERC20(ballastToken).safeTransferFrom(msg.sender, address(this), amountIn);

        bool ok;
        if (preferFables) {
            (ok, out) = _tryFablesSell(ballastToken, amountIn, quoteAsset, hook, fablesHopIdx, deadline);
            usedFables = ok;
            if (!ok) (ok, out) = _tryRamsesSell(ballastToken, amountIn, quoteAsset, hook, ramsesHopIdx, deadline);
        } else {
            (ok, out) = _tryRamsesSell(ballastToken, amountIn, quoteAsset, hook, ramsesHopIdx, deadline);
            if (!ok) {
                (ok, out) = _tryFablesSell(ballastToken, amountIn, quoteAsset, hook, fablesHopIdx, deadline);
                usedFables = ok;
            }
        }
        if (!ok) revert AllVenuesFailed();
        if (out < minOut) revert InsufficientOutput();

        _locker = address(0);
        _sweepAndAssertClean(ballastToken);
        uint256 dust = address(this).balance;
        if (dust != 0) {
            (bool sent,) = msg.sender.call{value: dust}("");
            require(sent, "eth dust refund failed");
        }
    }

    function _tryFablesSell(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata fablesHopIdx,
        uint256 deadline
    ) private returns (bool ok, uint256 out) {
        if (fablesHopIdx.length == 0) return (false, 0);
        try this.attemptFablesSell(ballastToken, amountIn, quoteAsset, hook, fablesHopIdx, deadline) returns (
            uint256 o
        ) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    function _tryRamsesSell(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata ramsesHopIdx,
        uint256 deadline
    ) private returns (bool ok, uint256 out) {
        if (ramsesHopIdx.length == 0) return (false, 0);
        try this.attemptRamsesSell(ballastToken, amountIn, quoteAsset, hook, ramsesHopIdx, deadline) returns (
            uint256 o
        ) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Self-call only. ballastToken -> quoteAsset (our hook) -> (Fables multi-hop
    ///         reverse) -> native ETH, all in one unlock. ETH lands on `msgSender()`
    ///         directly via TAKE_ALL (PoolManager pays native currency with a raw call).
    function attemptFablesSell(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata fablesHopIdx,
        uint256 deadline
    ) external onlySelf returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address locker = msgSender();
        // `fablesHopIdx` is stored in BUY order (ETH -> ... -> quoteAsset); selling
        // walks the exact same hops in reverse (quoteAsset -> ... -> ETH).
        PathKey[] memory path =
            _buildFablesPath(_reverseIdx(fablesHopIdx), Currency.wrap(quoteAsset), Currency.wrap(address(0)));

        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE),
            uint8(Actions.SWAP_EXACT_IN),
            uint8(Actions.SETTLE),
            uint8(Actions.TAKE)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(_ourPoolExactInSingle(ballastToken, quoteAsset, hook, uint128(amountIn)));
        params[1] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: Currency.wrap(quoteAsset),
                path: path,
                minHopPriceX36: new uint256[](0),
                // OPEN_DELTA (0): the real input is whatever our-pool leg (params[0]) just
                // credited in quoteAsset, not `amountIn` (that's the ballastToken amount,
                // a different currency entirely) — _swapExactInput resolves this via
                // _getFullCredit(currencyIn) when amountIn == OPEN_DELTA.
                amountIn: ActionConstants.OPEN_DELTA,
                amountOutMinimum: 0
            })
        );
        // SETTLE payerIsUser=false: the ballastToken being spent was pulled from the
        // seller into THIS contract already, at the top of `sellToETH`.
        params[2] = abi.encode(Currency.wrap(ballastToken), amountIn, false);
        params[3] = abi.encode(Currency.wrap(address(0)), locker, ActionConstants.OPEN_DELTA);

        uint256 before = locker.balance;
        poolManager.unlock(abi.encode(actions, params));
        out = locker.balance - before;
    }

    function _reverseIdx(uint256[] calldata idx) private pure returns (uint256[] memory r) {
        r = new uint256[](idx.length);
        for (uint256 i = 0; i < idx.length; i++) {
            r[i] = idx[idx.length - 1 - i];
        }
    }

    /// @notice Self-call only. ballastToken -> quoteAsset (our hook, own unlock), then
    ///         quoteAsset -> WETH via 1-2 Ramses hops, then unwrap -> native ETH to
    ///         `msgSender()`.
    function attemptRamsesSell(
        address ballastToken,
        uint256 amountIn,
        address quoteAsset,
        address hook,
        uint256[] calldata ramsesHopIdx,
        uint256 deadline
    ) external onlySelf returns (uint256 out) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address locker = msgSender();

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(_ourPoolExactInSingle(ballastToken, quoteAsset, hook, uint128(amountIn)));
        params[1] = abi.encode(Currency.wrap(ballastToken), amountIn, false);
        // Explicit recipient = address(this): there's a second, Ramses-v3 leg still to
        // run on this quoteAsset before anything goes to the real caller.
        params[2] = abi.encode(Currency.wrap(quoteAsset), address(this), ActionConstants.OPEN_DELTA);

        uint256 beforeQuote = IERC20(quoteAsset).balanceOf(address(this));
        poolManager.unlock(abi.encode(actions, params));
        uint256 quoteAmount = IERC20(quoteAsset).balanceOf(address(this)) - beforeQuote;

        // `ramsesHopIdx` is stored in BUY order (WETH -> ... -> quoteAsset); selling
        // walks the exact same routes in reverse (quoteAsset -> ... -> WETH) — the
        // same reversal attemptFablesSell applies to its own hop list.
        uint256 wethOut = _runRamsesChain(_reverseIdx(ramsesHopIdx), quoteAsset, weth, quoteAmount);
        IWETH9(weth).withdraw(wethOut);
        (bool sent,) = locker.call{value: wethOut}("");
        require(sent, "eth send failed");
        out = wethOut;
    }

    // ===================================================================== //
    //  Exact-output proof: one Fables hop, exact-out semantics              //
    // ===================================================================== //

    /// @notice Spend at most `amountInMaximum` of this hop's input currency (native ETH if
    ///         the hop's currency0 is address(0), else an ERC20 the caller must have
    ///         approved) for EXACTLY `amountOut` of the hop's output currency, through a
    ///         single fixed Fables pool. Proves exact-output works through a Fables hook
    ///         (phase-1 finding: nothing in beforeSwap branches on amountSpecified's sign,
    ///         only on zeroForOne) — not wired into buy/sell, which are exact-input only.
    function swapExactOutputSingleFables(uint256 hopIdx, bool zeroForOne, uint256 amountOut, uint256 amountInMaximum, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 amountIn)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        FablesHop memory h = fablesHops[hopIdx];
        _locker = msg.sender;

        Currency inputCurrency = Currency.wrap(zeroForOne ? h.currency0 : h.currency1);
        Currency outputCurrency = Currency.wrap(zeroForOne ? h.currency1 : h.currency0);
        bool inputIsNative = Currency.unwrap(inputCurrency) == address(0);
        if (!inputIsNative) {
            IERC20(Currency.unwrap(inputCurrency)).safeTransferFrom(msg.sender, address(this), amountInMaximum);
        }

        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactOutputSingleParams({
                poolKey: PoolKey({
                    currency0: Currency.wrap(h.currency0),
                    currency1: Currency.wrap(h.currency1),
                    fee: h.fee,
                    tickSpacing: h.tickSpacing,
                    hooks: IHooks(h.hooks)
                }),
                zeroForOne: zeroForOne,
                amountOut: uint128(amountOut),
                amountInMaximum: uint128(amountInMaximum),
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(inputCurrency, amountInMaximum);
        params[2] = abi.encode(outputCurrency, amountOut);

        // `address(this).balance` already includes `msg.value` here (credited before
        // the function body runs) — this IS the pre-swap balance, not pre-msg.value.
        uint256 before = inputIsNative ? address(this).balance : IERC20(Currency.unwrap(inputCurrency)).balanceOf(address(this));
        poolManager.unlock(abi.encode(actions, params));
        uint256 afterBal = inputIsNative ? address(this).balance : IERC20(Currency.unwrap(inputCurrency)).balanceOf(address(this));
        amountIn = before - afterBal;

        _locker = address(0);
        // Refund unspent input to the caller (native dust, or the unspent ERC20 pull).
        if (inputIsNative) {
            uint256 dust = address(this).balance;
            if (dust != 0) {
                (bool sent,) = msg.sender.call{value: dust}("");
                require(sent, "eth dust refund failed");
            }
        } else {
            _sweepAndAssertClean(Currency.unwrap(inputCurrency));
        }
    }

    // ===================================================================== //
    //  Shared helpers                                                       //
    // ===================================================================== //

    /// @dev Builds a PathKey[] by walking `fablesHops[idx]` in order, tracking the running
    ///      "current currency" and requiring each hop to actually connect to it. Reverts
    ///      (BadHopChain) if the first hop doesn't start at `entryCurrency` or the chain
    ///      doesn't end at `exitCurrency` — this is what makes "caller selects fixed
    ///      indices" as safe as "caller selects a fixed target": a wrong index either
    ///      doesn't chain (revert here) or chains to the wrong final currency (revert here).
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
            path[i] = PathKey({intermediateCurrency: next, fee: h.fee, tickSpacing: h.tickSpacing, hooks: IHooks(h.hooks), hookData: bytes("")});
            cur = next;
        }
        if (Currency.unwrap(cur) != Currency.unwrap(exitCurrency)) revert BadHopChain();
    }

    function _ourPoolExactInSingle(address tokenIn, address tokenOut, address hook, uint128 amountIn)
        private
        pure
        returns (IV4Router.ExactInputSingleParams memory)
    {
        bool zeroForOne = tokenIn < tokenOut;
        return IV4Router.ExactInputSingleParams({
            poolKey: PoolKey({
                currency0: Currency.wrap(zeroForOne ? tokenIn : tokenOut),
                currency1: Currency.wrap(zeroForOne ? tokenOut : tokenIn),
                fee: 0,
                tickSpacing: 60,
                hooks: IHooks(hook)
            }),
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: bytes("")
        });
    }

    /// @dev Runs 1 or 2 fixed Ramses-style v3 callback swaps in sequence, tokenIn ->
    ///      [intermediate] -> tokenOut, using `routeIdx` as ordered indices into
    ///      `ramsesRoutes`. Each hop's swap pays the pool from `address(this)`'s own
    ///      balance (this contract always holds the leg's input by the time this runs —
    ///      either from `weth.deposit` or from the previous hop's output).
    function _runRamsesChain(uint256[] memory routeIdx, address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 amountOut)
    {
        if (routeIdx.length == 0) revert NoRamsesRoute();
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

    function _sweepAndAssertClean(address token) private {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) IERC20(token).safeTransfer(msg.sender, bal);
        if (IERC20(token).balanceOf(address(this)) != 0) revert DirtyBalance(token, IERC20(token).balanceOf(address(this)));
    }
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}
