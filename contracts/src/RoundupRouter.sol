// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

interface IRoundupRegistry {
    function isAllowed(address asset) external view returns (bool);
}

/// @notice A thin ETH->stock buyer that delivers the bought stock to `recipient`.
///         Supplied at construction. The production adapter wraps the same
///         Fables/Ramses routing BasketZap/BallastRouterV2 use (read-only reuse of
///         their hop config) — RoundupRouter never reimplements routing itself.
interface IStockBuyer {
    /// @dev Must deliver the stock to `recipient` and refund any unspent ETH to it.
    ///      Reverts on failure so RoundupRouter can try/catch + refund.
    function buyStockWithETH(address stock, address recipient, uint256 minStockOut, bytes calldata route)
        external
        payable
        returns (uint256 stockOut);
}

/// @notice The trader's main Ballast swap. Supplied at construction (the forked
///         UniversalRouter wrapper, or a dedicated adapter). For a BUY it spends
///         `msg.value` ETH and delivers the token to `trader`; for a SELL it pulls
///         `amountIn` of `token` from `trader` (approval/Permit2) and returns ETH to
///         this contract, which forwards it to `trader`.
interface IMainSwapRouter {
    function buy(address token, address trader, uint256 minOut, bytes calldata route)
        external
        payable
        returns (uint256 out);
    function sell(address token, address trader, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        returns (uint256 ethOut);
}

/// @title RoundupRouter
/// @notice One transaction = the trader's normal Ballast swap (the hook fee applies
///         exactly as today) + an optional "round-up" leg that buys a small amount of
///         a stock token and sends it to the trader's OWN wallet. The stock never
///         touches a Ballast contract or treasury. Ballast takes 0% of round-ups.
/// @dev    No owner, no admin. CEI + reentrancy guard. The round-up leg is try/catch:
///         if it fails, its ETH is refunded to the trader and the main swap still
///         goes through. Every path refunds leftover ETH/dust — the contract holds
///         nothing between calls.
///
///         SECURITY STATUS: the orchestration logic here (cap, split, try/catch
///         refund, no-stuck-funds, events) is unit-tested deterministically against
///         mocks. The injected adapters (IMainSwapRouter, IStockBuyer) wrap live
///         UniversalRouter / Fables-Ramses routing and MUST be fork-tested + audited
///         before mainnet. See docs/security/roundups.md.
contract RoundupRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ROUNDUP_BPS = 500; // hard 5% cap
    uint256 public constant BPS = 10_000;

    IRoundupRegistry public immutable registry;
    IMainSwapRouter public immutable mainRouter;
    IStockBuyer public immutable stockBuyer;

    event RoundupExecuted(
        address indexed trader,
        address indexed token,
        address indexed stock,
        uint256 ethIn,
        uint256 stockOut,
        bool isBuy
    );
    event RoundupFailed(address indexed trader, address stock, uint256 ethRefunded);

    error ZeroAddress();
    error RoundupBpsTooHigh(uint256 bps);
    error StockNotAllowed(address stock);
    error ZeroEthIn();
    error RefundFailed();

    constructor(address registry_, address mainRouter_, address stockBuyer_) {
        if (registry_ == address(0) || mainRouter_ == address(0) || stockBuyer_ == address(0)) revert ZeroAddress();
        registry = IRoundupRegistry(registry_);
        mainRouter = IMainSwapRouter(mainRouter_);
        stockBuyer = IStockBuyer(stockBuyer_);
    }

    /// @notice BUY `token` with ETH, optionally rounding up into `stock`.
    /// @param token        the Ballast token to buy
    /// @param minOut       slippage floor for the main buy
    /// @param roundupBps   0 = off, else 1..500 (extra ETH on top of the swap amount)
    /// @param stock        the stock to round up into (ignored when roundupBps == 0)
    /// @param minStockOut  slippage floor for the round-up leg
    /// @dev msg.value = mainEthIn + roundupEthIn, where roundupEthIn = mainEthIn*bps/1e4.
    function buyWithRoundup(
        address token,
        uint256 minOut,
        uint256 roundupBps,
        address stock,
        uint256 minStockOut,
        bytes calldata mainRoute,
        bytes calldata stockRoute
    ) external payable nonReentrant returns (uint256 tokenOut) {
        if (msg.value == 0) revert ZeroEthIn();
        // BUY: the round-up is EXTRA ETH on top of the swap amount, so of the total
        // sent, roundupEth = total * bps / (BPS + bps) and the rest funds the main buy.
        uint256 roundupEth = _roundupOnTop(msg.value, roundupBps);
        uint256 mainEth = msg.value - roundupEth;

        // Round-up leg FIRST (try/catch) so a failure refunds and the main swap still
        // runs. The stock is delivered straight to the trader.
        if (roundupEth > 0) {
            _doRoundup(stock, roundupEth, minStockOut, stockRoute, true);
        }

        // Main swap: ETH -> token, delivered to the trader by the adapter.
        tokenOut = mainRouter.buy{value: mainEth}(token, msg.sender, minOut, mainRoute);

        _sweepDust();
    }

    /// @notice SELL `token` for ETH, optionally rounding up a share of the ETH out
    ///         into `stock` for the trader.
    /// @param roundupBps  0 = off, else 1..500 (share of the ETH proceeds)
    function sellWithRoundup(
        address token,
        uint256 amountIn,
        uint256 minOut,
        uint256 roundupBps,
        address stock,
        uint256 minStockOut,
        bytes calldata mainRoute,
        bytes calldata stockRoute
    ) external nonReentrant returns (uint256 ethOut) {
        if (amountIn == 0) revert ZeroEthIn();
        if (roundupBps > MAX_ROUNDUP_BPS) revert RoundupBpsTooHigh(roundupBps);

        // Pull the token from the trader and sell it; ETH comes back to this contract.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).forceApprove(address(mainRouter), amountIn);
        ethOut = mainRouter.sell(token, address(this), amountIn, minOut, mainRoute);
        IERC20(token).forceApprove(address(mainRouter), 0);

        uint256 roundupEth = _roundupShareOfInput(ethOut, roundupBps);
        uint256 toTrader = ethOut - roundupEth;

        // Round-up leg (try/catch): a failure folds its ETH back into the trader's payout.
        if (roundupEth > 0) {
            bool ok = _doRoundup(stock, roundupEth, minStockOut, stockRoute, false);
            if (!ok) toTrader += roundupEth; // refunded into the main payout
        }

        _sendEth(msg.sender, toTrader);
        _sweepDust();
    }

    // ── internals ──

    /// @dev SELL round-up = a share of the ETH out: output * bps / 1e4. 0 bps -> 0.
    function _roundupShareOfInput(uint256 input, uint256 bps) internal pure returns (uint256) {
        if (bps == 0) return 0;
        if (bps > MAX_ROUNDUP_BPS) revert RoundupBpsTooHigh(bps);
        return (input * bps) / BPS;
    }

    /// @dev BUY round-up = extra on top: of `total` sent, the round-up share is
    ///      total * bps / (BPS + bps), leaving total/(1+bps/BPS) for the main buy.
    function _roundupOnTop(uint256 total, uint256 bps) internal pure returns (uint256) {
        if (bps == 0) return 0;
        if (bps > MAX_ROUNDUP_BPS) revert RoundupBpsTooHigh(bps);
        return (total * bps) / (BPS + bps);
    }

    /// @dev Execute the round-up leg; on ANY failure, refund its ETH to the trader
    ///      (buy path) or signal the caller to fold it back (sell path). Returns true
    ///      when the stock was bought. Reverts only if the stock isn't allowlisted —
    ///      a misconfigured call should fail loudly, a routing failure should refund.
    function _doRoundup(address stock, uint256 ethIn, uint256 minStockOut, bytes calldata route, bool refundOnFail)
        internal
        returns (bool)
    {
        if (!registry.isAllowed(stock)) revert StockNotAllowed(stock);
        try stockBuyer.buyStockWithETH{value: ethIn}(stock, msg.sender, minStockOut, route) returns (uint256 stockOut) {
            emit RoundupExecuted(msg.sender, address(0), stock, ethIn, stockOut, true);
            return true;
        } catch {
            if (refundOnFail) {
                _sendEth(msg.sender, ethIn);
                emit RoundupFailed(msg.sender, stock, ethIn);
            } else {
                emit RoundupFailed(msg.sender, stock, ethIn);
            }
            return false;
        }
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev Return any residual ETH to the trader — the contract must hold nothing.
    function _sweepDust() internal {
        uint256 bal = address(this).balance;
        if (bal > 0) _sendEth(msg.sender, bal);
    }

    /// @dev Accept ETH refunds from the adapters (unspent round-up/main ETH).
    receive() external payable {}
}
