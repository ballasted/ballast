// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeConfig} from "./FeeConfig.sol";
import {BallastToken} from "./BallastToken.sol";

// Flag bits BallastHook's mined address must carry (and only these). File-level
// (not just the BallastHook.FLAGS constant below) because HookMiner needs this
// value BEFORE any instance exists to read it from — `ContractName.CONSTANT`
// compile-time access works for libraries/enums, not for a contract's own state
// variables, so miners and deploy scripts import this directly instead.
uint160 constant BALLAST_HOOK_FLAGS = Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;

/// @title BallastHook — singleton v4 hook that takes a fee on the QUOTE-ASSET leg
///
/// @notice Charges `FeeConfig.feeBps` (1%) of the quote-asset side of every swap and
///         splits it creator/platform/referrer (read live). The fee is ALWAYS in that
///         POOL's quote asset — never the project token — so the platform never
///         becomes a holder of the tokens it reports on.
///
/// @dev PER-POOL quote-asset concept: every pool this hook is attached to pairs
///      exactly one launched BallastToken against exactly one quote asset — WETH
///      today (BallastFactory.QuoteAssetNotSupportedYet still blocks anything else),
///      but the hook itself no longer assumes WETH specifically. `_resolvePool`
///      identifies which side of a given PoolKey is the token by checking which
///      side answers `creator()` (the same call `_distribute` already trusted) —
///      the SAME discriminator BallastFactory-launched tokens always answer,
///      regardless of what they're paired against — and caches the result per pool
///      so repeat swaps only pay one mapping read, not a repeat external call.
///
///      The fee ledger is PER-CURRENCY: `owed` is the pre-existing WETH-only ledger
///      (kept byte-for-byte compatible — FeeSplitter and BuybackBurner call
///      `owed(address)`/`claim()` with those exact selectors and must never be
///      touched, see CLAUDE.md). `owedIn[recipient][currency]` is the new ledger for
///      every OTHER quote asset, pulled via `claimIn(currency)`. No non-WETH pool
///      exists yet (gated at the factory), so `owedIn` is inert infrastructure until
///      that gate lifts — this is the "land the general logic now, unlock it later"
///      pattern already used for the seeder's ordering support.
///
///      The fee is skimmed where the quote-asset leg is reachable, which depends on
///      whether it's the swap's SPECIFIED or UNSPECIFIED currency (a function of
///      direction AND exact-in/out — four cases, not two):
///        - quote specified   (buy exact-in, sell exact-out)  -> beforeSwap
///        - quote unspecified (buy exact-out, sell exact-in)  -> afterSwap
///      because `beforeSwap`'s BeforeSwapDelta can only move the SPECIFIED currency
///      and `afterSwap`'s return delta only the UNSPECIFIED one. Keying on direction
///      alone would skim the wrong leg or nothing, and it would leak SILENTLY.
///
///      Distribution is accrue-and-claim (pull, not push): a reverting/blocklisted
///      recipient can only fail its own claim(), never brick a swap.
///
///      LIQUIDITY LOCK, on its own merits: BallastSeeder's one-sided position is
///      already structurally unremovable (it has no function that calls
///      modifyLiquidity with a negative delta after the initial seed — see
///      BallastSeeder.sol), but that guarantee currently requires reading
///      Seeder's bytecode to confirm. `beforeRemoveLiquidity` makes the SAME
///      guarantee provable from this hook alone: it reverts if the caller
///      removing liquidity is the Seeder, full stop. It does NOT block anyone
///      else — a third party who adds their own liquidity to a Ballast pool
///      (explicitly possible; see the token page's "not a floor" disclosure)
///      stays free to remove it. This is not a scanner-facing substitute for
///      anything; it is a real, independently-checkable lock on the one
///      position that must never move.
contract BallastHook {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    FeeConfig public immutable feeConfig;
    /// @notice Kept for the legacy WETH-only ledger below — NOT used to identify
    ///         which side of a pool is the quote asset anymore (see _resolvePool).
    address public immutable weth;
    /// @notice Whoever deployed this hook — authorized ONLY to call setSeeder,
    ///         exactly once, immediately after BallastSeeder deploys. Not an
    ///         ongoing admin role; there is nothing else this address can do.
    ///         Recorded from tx.origin, not msg.sender: a salt-mined hook address
    ///         (required for v4's flag-encoded hook addresses) gets deployed via
    ///         the canonical deterministic-deployment proxy when broadcast through
    ///         Foundry's `new{salt}(...)`, so the constructor's real msg.sender is
    ///         that proxy, not the deploying EOA — tx.origin is the only value
    ///         that correctly survives the extra hop in both the real broadcast
    ///         and a direct (non-broadcast) test deployment. Fine for a one-shot
    ///         bootstrap check like this; not a pattern to reuse for anything
    ///         recurring (tx.origin's usual phishing/relayed-call risk applies
    ///         there, not here).
    address private immutable _deployer;

    /// @notice The one address beforeRemoveLiquidity ever blocks. Settable once
    ///         (setSeeder) because BallastSeeder's constructor needs THIS hook's
    ///         address, so the hook must exist first and can't know Seeder's
    ///         address at construction — a one-time wiring step, not a live
    ///         admin control. Until set, beforeRemoveLiquidity allows everyone
    ///         (harmless: no pool can be seeded before Seeder exists anyway).
    address public seeder;
    bool private _seederSet;

    /// @notice WETH owed to each recipient, claimable via claim(). Legacy ledger,
    ///         untouched selector/semantics — FeeSplitter and BuybackBurner sweep
    ///         this exact mapping and must keep working unmodified.
    mapping(address => uint256) public owed;
    /// @notice Non-WETH quote-asset fees owed to each recipient, per currency,
    ///         claimable via claimIn(currency). Empty until a non-WETH quote asset
    ///         is actually launchable (BallastFactory.QuoteAssetNotSupportedYet).
    mapping(address => mapping(address => uint256)) public owedIn;

    struct PoolInfo {
        address token;
        address quoteAsset;
    }

    /// @notice Resolved (token, quoteAsset) per pool, cached after the first swap so
    ///         later swaps pay one mapping read instead of a repeat external call.
    mapping(bytes32 => PoolInfo) internal _pools;

    event FeeTaken(
        address indexed token, address indexed quoteAsset, uint256 fee, address creator, address platform, address referrer
    );
    event Claimed(address indexed recipient, uint256 amount);
    event ClaimedIn(address indexed recipient, address indexed currency, uint256 amount);

    error NotPoolManager();
    /// @notice Sell-exact-out (quote asset specified as output) is rejected: the fee
    ///         would have to be skimmed in beforeSwap on the REQUESTED amount before
    ///         the fill is known, over-collecting on a partial fill, and afterSwap
    ///         cannot correct it (it only touches the unspecified currency). We
    ///         revert loudly instead of overcharging silently. Route sells as
    ///         exact-in. (Buy-exact-out is fine — the quote asset is unspecified
    ///         there, so the fee is charged on the actual fill in afterSwap.)
    error SellExactOutNotSupported();
    /// @notice Neither side of this PoolKey answers creator() (not a Ballast pool at
    ///         all — e.g. someone initialized an unrelated pair against this shared
    ///         hook) or BOTH sides do (a decoy token forged to look like one). We
    ///         refuse to guess rather than silently misattribute a fee.
    error AmbiguousPool();
    /// @notice claim() (no args) is the WETH-specific path; use claimIn(currency)
    ///         for anything else.
    error UseClaimForWeth();
    /// @notice setSeeder was called by anyone other than the deployer.
    error NotDeployer();
    /// @notice setSeeder was already called — one-time wiring, not retunable.
    error AlreadySet();
    error ZeroAddress();
    /// @notice The Seeder tried to remove liquidity. It never should (no code
    ///         path exists to), but this makes the lock provable from the hook
    ///         alone rather than from Seeder's absence of a removal function.
    error SeederLiquidityLocked();

    /// @notice Same value as the file-level BALLAST_HOOK_FLAGS — kept as an
    ///         instance-readable constant too (on-chain introspection, and for
    ///         any caller that already has a deployed instance in hand).
    uint160 public constant FLAGS = BALLAST_HOOK_FLAGS;

    constructor(IPoolManager poolManager_, FeeConfig feeConfig_, address weth_) {
        poolManager = poolManager_;
        feeConfig = feeConfig_;
        weth = weth_;
        _deployer = tx.origin;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice One-time wiring: the deployer calls this immediately after
    ///         BallastSeeder deploys (which needed THIS hook's address in ITS
    ///         OWN constructor, so the ordering can't be the other way around).
    function setSeeder(address seeder_) external {
        if (tx.origin != _deployer) revert NotDeployer();
        if (_seederSet) revert AlreadySet();
        if (seeder_ == address(0)) revert ZeroAddress();
        seeder = seeder_;
        _seederSet = true;
    }

    /// @notice For HookMiner / readability — the five permissions this hook needs.
    function getHookPermissions() external pure returns (Hooks.Permissions memory p) {
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
        p.beforeRemoveLiquidity = true;
    }

    // --------------------------------------------------------------------- //
    //  Liquidity lock — the Seeder's position can never be removed          //
    // --------------------------------------------------------------------- //
    function beforeRemoveLiquidity(address sender, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender == seeder) revert SeederLiquidityLocked();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    // --------------------------------------------------------------------- //
    //  beforeSwap — skim when the quote asset is the SPECIFIED currency     //
    // --------------------------------------------------------------------- //
    // Split into a thin external entrypoint + an internal worker (below) purely to
    // keep this function's own stack frame small — v4 hook callbacks are already
    // calldata-heavy, and adding the (token, quoteAsset) resolution on top of the
    // existing locals tips beforeSwap/afterSwap into "stack too deep" if it's all
    // inlined in one function.
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint256 fee = _beforeFee(key, params, hookData);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function _beforeFee(PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata hookData)
        internal
        returns (uint256 fee)
    {
        (address token, address quoteAsset) = _resolvePool(key);
        bool exactIn = params.amountSpecified < 0;
        if (Currency.unwrap(_specified(key, params.zeroForOne, exactIn)) != quoteAsset) {
            return 0; // Quote asset is unspecified here -> afterSwap handles it.
        }
        // Quote asset is specified. Exact-out here == sell-exact-out: reject it
        // rather than over-collect on a partial fill (see SellExactOutNotSupported).
        if (!exactIn) revert SellExactOutNotSupported();
        // Exact-in: the specified magnitude IS the quote-asset input leg.
        fee = _feeOn(uint256(-params.amountSpecified));
        if (fee == 0) return 0;

        poolManager.take(Currency.wrap(quoteAsset), address(this), fee);
        _distribute(token, quoteAsset, fee, hookData);
    }

    // --------------------------------------------------------------------- //
    //  afterSwap — skim when the quote asset is the UNSPECIFIED currency    //
    // --------------------------------------------------------------------- //
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        uint256 fee = _afterFee(key, params, delta, hookData);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _afterFee(
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal returns (uint256 fee) {
        (address token, address quoteAsset) = _resolvePool(key);
        bool exactIn = params.amountSpecified < 0;
        if (Currency.unwrap(_specified(key, params.zeroForOne, exactIn)) == quoteAsset) {
            return 0; // quote asset was specified -> beforeSwap handled it
        }
        // Quote asset is the unspecified currency; its moved amount is now known.
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quoteAsset;
        int128 quoteDelta = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        uint256 amt = uint256(int256(quoteDelta < 0 ? -quoteDelta : quoteDelta));
        fee = _feeOn(amt);
        if (fee == 0) return 0;

        poolManager.take(Currency.wrap(quoteAsset), address(this), fee);
        _distribute(token, quoteAsset, fee, hookData);
    }

    function _feeOn(uint256 amt) internal view returns (uint256) {
        return (amt * feeConfig.feeBps()) / feeConfig.BPS();
    }

    // --------------------------------------------------------------------- //
    //  Pool resolution — which side is the token, which is the quote asset  //
    // --------------------------------------------------------------------- //
    /// @dev Every real Ballast pool pairs a BallastFactory-launched token against
    ///      exactly one quote asset. The token side always answers `creator()`
    ///      truthfully (set immutably at construction); no real quote asset (WETH,
    ///      USDC, a registry-allowlisted stock/ETF token) implements it. Reverts
    ///      rather than guessing if neither or both sides do — see AmbiguousPool.
    function _resolvePool(PoolKey calldata key) internal returns (address token, address quoteAsset) {
        bytes32 id = PoolId.unwrap(key.toId());
        PoolInfo memory cached = _pools[id];
        if (cached.token != address(0)) return (cached.token, cached.quoteAsset);

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool c0IsToken = _hasCreator(c0);
        bool c1IsToken = _hasCreator(c1);
        if (c0IsToken == c1IsToken) revert AmbiguousPool();

        (token, quoteAsset) = c0IsToken ? (c0, c1) : (c1, c0);
        _pools[id] = PoolInfo(token, quoteAsset);
    }

    function _hasCreator(address candidate) internal view returns (bool) {
        (bool ok, bytes memory ret) = candidate.staticcall(abi.encodeWithSignature("creator()"));
        return ok && ret.length == 32 && abi.decode(ret, (address)) != address(0);
    }

    // --------------------------------------------------------------------- //
    //  Distribution + claim                                                 //
    // --------------------------------------------------------------------- //
    function _distribute(address token, address quoteAsset, uint256 fee, bytes calldata hookData) internal {
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

        if (quoteAsset == weth) {
            owed[creator] += creatorCut;
            owed[platformVault] += platformCut;
            if (referrerCut != 0) owed[referrer] += referrerCut;
        } else {
            owedIn[creator][quoteAsset] += creatorCut;
            owedIn[platformVault][quoteAsset] += platformCut;
            if (referrerCut != 0) owedIn[referrer][quoteAsset] += referrerCut;
        }

        emit FeeTaken(token, quoteAsset, fee, creator, platformVault, referrer);
    }

    /// @notice Pull WETH owed to the caller. Pull-not-push: a reverting recipient
    ///         can only fail its own claim, never a swap. Unchanged selector/
    ///         semantics — FeeSplitter and BuybackBurner depend on this exact call.
    function claim() external returns (uint256 amount) {
        amount = owed[msg.sender];
        owed[msg.sender] = 0;
        if (amount != 0) IERC20(weth).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Pull `currency` owed to the caller, for any non-WETH quote asset.
    function claimIn(address currency) external returns (uint256 amount) {
        if (currency == weth) revert UseClaimForWeth();
        amount = owedIn[msg.sender][currency];
        owedIn[msg.sender][currency] = 0;
        if (amount != 0) IERC20(currency).safeTransfer(msg.sender, amount);
        emit ClaimedIn(msg.sender, currency, amount);
    }

    function _specified(PoolKey calldata key, bool zeroForOne, bool exactIn) internal pure returns (Currency) {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        return exactIn ? input : output;
    }
}
