// SPDX-License-Identifier: MIT
// Pinned to 0.8.26 for the SAME reason as BasketZap.sol / BallastRouterV2.sol:
// it inherits v4-periphery's V4Router (pinned to exactly 0.8.26). One import
// graph, one compiler version.
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {V4Router} from "v4-periphery/src/V4Router.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "v4-periphery/src/libraries/ActionConstants.sol";

interface IWETH9StockBuyer {
    function deposit() external payable;
}

interface IUniswapV3PoolSwapStock {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title BasketStockBuyer
/// @notice The RoundupRouter `IStockBuyer` adapter: buys ONE AssetRegistry-listed
///         stock with ETH and delivers it straight to the trader (`recipient`). It
///         is a single-asset extraction of BasketZap's EXACT Fables/Ramses routing
///         — same V4Router base, same path builder, same Ramses v3 callback, same
///         hop/route tables (passed verbatim at construction, verified the same way
///         BasketZap's were). BasketZap itself is UNMODIFIED; its per-leg functions
///         are `onlySelf`, so its routing can't be reused by an external call — this
///         contract reuses the CONFIG (the tables) and the MECHANISM (the code),
///         re-pointed from `creator` to an arbitrary `recipient`.
/// @dev    No owner, no admin, holds no funds between calls. Reverts on any failure
///         so RoundupRouter's try/catch refunds the trader; refunds ETH dust to the
///         recipient.
///
///         ⚠️ SECURITY STATUS: this routes user funds through live v4 / Ramses
///         pools and has NOT been fork-tested on chain 4663 (the paid RPC was not
///         available in the build environment) nor externally audited. Both are
///         REQUIRED before it is set as RoundupRouter's stockBuyer and the
///         NEXT_PUBLIC_ROUNDUP_ROUTER flag is turned on. See docs/security/roundups.md.
contract BasketStockBuyer is V4Router, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct FablesHop {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct RamsesRoute {
        address pool;
        address tokenA;
        address tokenB;
    }

    IAssetRegistry public immutable registry;
    address public immutable weth;
    FablesHop[] public fablesHops;
    RamsesRoute[] public ramsesRoutes;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    event StockBought(
        address indexed stock, address indexed recipient, uint256 ethIn, uint256 stockOut, bool usedFables
    );

    error ZeroAddress();
    error ZeroEthIn();
    error StockNotAllowed(address stock);
    error MinOutTooLow();
    error InsufficientOutput(address stock, uint256 out, uint256 minOut);
    error AllVenuesFailed(address stock);
    error NoRamsesRoute();
    error BadHopChain();
    error NotSelf();
    error DeadlinePassed();

    constructor(
        address registry_,
        IPoolManager poolManager_,
        address weth_,
        FablesHop[] memory fablesHops_,
        RamsesRoute[] memory ramsesRoutes_
    ) V4Router(poolManager_) {
        if (registry_ == address(0) || weth_ == address(0) || address(poolManager_) == address(0)) revert ZeroAddress();
        registry = IAssetRegistry(registry_);
        weth = weth_;
        for (uint256 i = 0; i < fablesHops_.length; i++) {
            fablesHops.push(fablesHops_[i]);
        }
        for (uint256 i = 0; i < ramsesRoutes_.length; i++) {
            ramsesRoutes.push(ramsesRoutes_[i]);
        }
    }

    receive() external payable {}

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    // V4Router abstract requirement — never consulted (every leg's TAKE names an
    // explicit recipient and every SETTLE is native currency). Mirrors BasketZap.
    function msgSender() public view override returns (address) {
        return address(this);
    }

    function fablesHopsLength() external view returns (uint256) {
        return fablesHops.length;
    }

    function ramsesRoutesLength() external view returns (uint256) {
        return ramsesRoutes.length;
    }

    /// @notice RoundupRouter calls this with the round-up ETH. Buys `stock` and
    ///         delivers it to `recipient`; enforces `minStockOut`; refunds ETH dust.
    /// @param route abi.encode(uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool preferFables, uint256 deadline)
    function buyStockWithETH(address stock, address recipient, uint256 minStockOut, bytes calldata route)
        external
        payable
        nonReentrant
        returns (uint256 stockOut)
    {
        if (msg.value == 0) revert ZeroEthIn();
        if (recipient == address(0) || stock == address(0)) revert ZeroAddress();
        if (minStockOut == 0) revert MinOutTooLow();
        if (!registry.isAllowed(stock)) revert StockNotAllowed(stock);

        (uint256[] memory fablesHopIdx, uint256[] memory ramsesHopIdx, bool preferFables, uint256 deadline) =
            abi.decode(route, (uint256[], uint256[], bool, uint256));
        if (block.timestamp > deadline) revert DeadlinePassed();

        bool ok;
        bool usedFables;
        if (preferFables) {
            (ok, stockOut) = _tryFables(stock, fablesHopIdx, msg.value, recipient, deadline);
            usedFables = ok;
            if (!ok) (ok, stockOut) = _tryRamses(stock, ramsesHopIdx, msg.value, recipient, deadline);
        } else {
            (ok, stockOut) = _tryRamses(stock, ramsesHopIdx, msg.value, recipient, deadline);
            if (!ok) {
                (ok, stockOut) = _tryFables(stock, fablesHopIdx, msg.value, recipient, deadline);
                usedFables = ok;
            }
        }
        if (!ok) revert AllVenuesFailed(stock);
        if (stockOut < minStockOut) revert InsufficientOutput(stock, stockOut, minStockOut);

        // No ETH should remain (exact-input chains consume it), but never strand any.
        uint256 dust = address(this).balance;
        if (dust != 0) {
            (bool sent,) = recipient.call{value: dust}("");
            require(sent, "eth dust refund failed");
        }
        emit StockBought(stock, recipient, msg.value, stockOut, usedFables);
    }

    // ── venue selection + fallback (mirrors BasketZap/_swapLegToCreator) ──

    function _tryFables(address asset, uint256[] memory hopIdx, uint256 amountIn, address recipient, uint256 deadline)
        private
        returns (bool ok, uint256 out)
    {
        if (hopIdx.length == 0) return (false, 0);
        try this.attemptFablesLeg{value: amountIn}(asset, hopIdx, recipient, deadline) returns (uint256 o) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    function _tryRamses(address asset, uint256[] memory hopIdx, uint256 amountIn, address recipient, uint256 deadline)
        private
        returns (bool ok, uint256 out)
    {
        if (hopIdx.length == 0) return (false, 0);
        try this.attemptRamsesLeg{value: amountIn}(asset, hopIdx, recipient, deadline) returns (uint256 o) {
            return (true, o);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Self-call only. ETH -> (Fables multi-hop) -> `asset` in ONE unlock,
    ///         TAKEn straight to `recipient`.
    function attemptFablesLeg(address asset, uint256[] calldata hopIdx, address recipient, uint256 deadline)
        external
        payable
        onlySelf
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
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
                amountOutMinimum: 0 // enforced once in buyStockWithETH against the real output
            })
        );
        params[1] = abi.encode(Currency.wrap(address(0)), ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(Currency.wrap(asset), recipient, ActionConstants.OPEN_DELTA);

        uint256 before = IERC20(asset).balanceOf(recipient);
        poolManager.unlock(abi.encode(actions, params));
        out = IERC20(asset).balanceOf(recipient) - before;
    }

    /// @notice Self-call only. ETH -> WETH -> (1-2 Ramses hops) -> `asset`, then
    ///         transferred to `recipient`.
    function attemptRamsesLeg(address asset, uint256[] calldata hopIdx, address recipient, uint256 deadline)
        external
        payable
        onlySelf
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (hopIdx.length == 0) revert NoRamsesRoute();
        IWETH9StockBuyer(weth).deposit{value: msg.value}();
        out = _runRamsesChain(hopIdx, weth, asset, msg.value);
        IERC20(asset).safeTransfer(recipient, out);
    }

    function _pay(Currency token, address payer, uint256 amount) internal override {
        address asset = Currency.unwrap(token);
        if (payer == address(this)) {
            IERC20(asset).safeTransfer(address(poolManager), amount);
        } else {
            IERC20(asset).safeTransferFrom(payer, address(poolManager), amount);
        }
    }

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

    function _swapRamsesDirect(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        private
        returns (uint256 received)
    {
        bool zeroForOne = tokenIn < tokenOut;
        uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3PoolSwapStock(pool)
            .swap(address(this), zeroForOne, int256(amountIn), sqrtPriceLimitX96, abi.encode(tokenIn));
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

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
