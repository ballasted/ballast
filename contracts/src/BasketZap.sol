// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IRobinhoodV4Router, RobinhoodV4} from "./interfaces/IRobinhoodV4Router.sol";
import {IAllowanceTransfer} from "./interfaces/IPermit2.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

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
/// @dev WHY THIS CONTRACT CANNOT ALSO CALL `ProjectTreasury.deposit()` FOR THE
///      CREATOR (see docs/DECISIONS.md §1 for the full writeup): `deposit()` is
///      `onlyCreator`, checking `msg.sender == creator` directly — a fixed EOA
///      address set at launch. If BasketZap called it, the treasury would see
///      BasketZap's own address as the caller, never the creator's, and revert.
///      No amount of contract cleverness changes that without modifying
///      ProjectTreasury, which is forbidden. So this contract does exactly one
///      job — wrap ETH, swap it into the requested stock tokens with real
///      on-chain safety checks, and forward every output straight to the
///      launch's creator — and stops there. The creator still has to call
///      `approve` + `deposit` on their treasury themselves, once per asset,
///      exactly as if they'd sourced the tokens anywhere else.
///
///      Each leg is executed as its OWN `UniversalRouter.execute()` call (the
///      exact single-hop SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL shape
///      `BallastV1Claim` already proved against a live mainnet pool), looped
///      inside one `swapBasket` transaction — never a single batched multi-action
///      router call. That shape is reachable on this fork (v4's flash-accounting
///      allows multiple swap/settle/take actions in one `execute()`), but it has
///      never been proven against this router, and untested code in the
///      swap-execution path is exactly the attack surface CLAUDE.md warns about
///      re: multi-hop. N independent, already-proven single-leg calls inside one
///      user-signed transaction is the conservative choice and costs the caller
///      nothing extra — it is still exactly one signature.
///
///      Routes are NOT hardcoded: unlike Ballast's own gen-4 hook pools,
///      stock-token/WETH liquidity is third-party (Uniswap + Pleiades LPs,
///      docs/robinhood-chain-research.md §2) with no fixed fee/tickSpacing/hook,
///      and no canonical on-chain "get me the pool for this pair" lookup exists
///      in v4. The caller supplies the full `PoolKey` per leg, exactly like
///      `BallastRouterV2` already takes `hook` as a parameter rather than a
///      constant. This cannot be abused to hurt anyone but the caller: funds are
///      always the caller's own ETH, converted for their own benefit, forwarded
///      only to the resolved creator address (never an arbitrary address), and
///      `minOut` is the caller's own slippage protection — a bad PoolKey just
///      means the swap reverts or fills at a worse price the caller chose to
///      accept.
contract BasketZap is ReentrancyGuard {
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
    address public immutable universalRouter;
    address public immutable permit2;

    /// @notice This contract's own last-seen price per asset, for the deviation
    ///         breaker — scoped to BasketZap globally (every launch, every
    ///         caller), same as OpenTreasuryVault's equivalent mapping.
    mapping(address asset => uint256) public lastPrice;
    mapping(address asset => uint256) public lastPriceAt;

    struct Leg {
        address asset;
        uint16 weightBps;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint256 minOut;
    }

    event BasketSwapped(
        address indexed launchToken,
        address indexed creator,
        uint256 ethIn,
        uint256 ethRefunded,
        address[] assets,
        uint256[] amountsOut
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

    constructor(address factory_, address registry_, address weth_, address universalRouter_, address permit2_) {
        if (
            factory_ == address(0) || registry_ == address(0) || weth_ == address(0) || universalRouter_ == address(0)
                || permit2_ == address(0)
        ) revert ZeroAddress();
        factory = IBallastFactoryBasket(factory_);
        registry = IAssetRegistry(registry_);
        weth = weth_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
    }

    /// @notice Swap `msg.value` ETH across `legs` (weights in bps, summing to
    ///         10000) into up to 6 AssetRegistry-listed stock tokens, and send
    ///         every output straight to `launchToken`'s creator. All-or-nothing:
    ///         any leg failing its own checks (unlisted asset, stale/deviated
    ///         feed, minOut not met) reverts the ENTIRE call, including legs that
    ///         already succeeded earlier in the loop. Unused ETH left over from
    ///         integer-division weight rounding is refunded to the creator as
    ///         WETH in the same transaction (never left in this contract).
    /// @param launchToken The Ballast launch token whose creator receives every
    ///        leg's output. Resolved against the factory, not trusted as a raw
    ///        parameter — see IBallastFactoryBasket above.
    /// @param swapDeadline A timestamp deadline for every leg (this chain has
    ///        ~100ms blocks — use time, never a block number).
    function swapBasket(address launchToken, Leg[] calldata legs, uint256 swapDeadline)
        external
        payable
        nonReentrant
        returns (uint256[] memory amountsOut)
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

        IWETH9Basket(weth).deposit{value: msg.value}();

        amountsOut = new uint256[](n);
        address[] memory assetsOut = new address[](n);
        uint256 spent;

        for (uint256 i = 0; i < n; i++) {
            Leg calldata leg = legs[i];
            assetsOut[i] = leg.asset;

            if (!registry.isAllowed(leg.asset)) revert AssetNotAllowed(leg.asset);
            if (leg.minOut == 0) revert MinOutTooLow();
            _checkFreshPrice(leg.asset);

            uint256 amountIn = (msg.value * leg.weightBps) / BPS;
            if (amountIn == 0) continue;
            spent += amountIn;

            uint256 out = _swapLeg(leg, amountIn, swapDeadline);
            amountsOut[i] = out;
            IERC20(leg.asset).safeTransfer(creator, out);
        }

        uint256 refund = msg.value - spent;
        if (refund > 0) {
            IERC20(weth).safeTransfer(creator, refund);
        }

        emit BasketSwapped(launchToken, creator, msg.value, refund, assetsOut, amountsOut);
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

    /// @dev One single-hop swap, the identical SWAP_EXACT_IN_SINGLE + SETTLE_ALL
    ///      + TAKE_ALL shape `BallastV1Claim._swapEthForBallastV2` already proved
    ///      on a live mainnet pool, generalized to a caller-supplied PoolKey
    ///      instead of a fixed one. Exact-approval hygiene: Permit2 and the
    ///      router-as-spender allowances are reset to zero immediately after
    ///      use, every leg, no standing allowance ever survives this call.
    function _swapLeg(Leg calldata leg, uint256 amountIn, uint256 swapDeadline) internal returns (uint256 out) {
        bool wethIsCurrency0 = weth < leg.asset;
        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: wethIsCurrency0 ? weth : leg.asset,
            currency1: wethIsCurrency0 ? leg.asset : weth,
            fee: leg.fee,
            tickSpacing: leg.tickSpacing,
            hooks: leg.hooks
        });

        RobinhoodV4.ExactInputSingleParams memory params = RobinhoodV4.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: wethIsCurrency0,
            amountIn: uint128(amountIn),
            amountOutMinimum: 0, // minOut is enforced below against the real balance delta
            minHopPriceX36: 0,
            hookData: ""
        });

        IERC20(weth).forceApprove(permit2, amountIn);
        IAllowanceTransfer(permit2).approve(weth, universalRouter, uint160(amountIn), uint48(swapDeadline));

        bytes memory actions = abi.encodePacked(
            RobinhoodV4.ACT_SWAP_EXACT_IN_SINGLE, RobinhoodV4.ACT_SETTLE_ALL, RobinhoodV4.ACT_TAKE_ALL
        );
        bytes[] memory v4Params = new bytes[](3);
        v4Params[0] = abi.encode(params);
        v4Params[1] = abi.encode(weth, amountIn);
        v4Params[2] = abi.encode(leg.asset, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, v4Params);
        bytes memory commands = abi.encodePacked(RobinhoodV4.CMD_V4_SWAP);

        uint256 before = IERC20(leg.asset).balanceOf(address(this));
        IRobinhoodV4Router(universalRouter).execute(commands, inputs, swapDeadline);
        out = IERC20(leg.asset).balanceOf(address(this)) - before;

        IAllowanceTransfer(permit2).approve(weth, universalRouter, 0, 0);
        IERC20(weth).forceApprove(permit2, 0);

        if (out < leg.minOut) revert InsufficientOutput(leg.asset, out, leg.minOut);
    }
}
