// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {BallastToken} from "../BallastToken.sol";

// The exact flag bits a gen-5 hook address must carry. File-level so HookMiner /
// deploy scripts can read it before any instance exists (see gen-4's
// BALLAST_HOOK_FLAGS note). Six permissions: both swap callbacks + their return-
// delta flags (fee skim), afterInitialize (seed the fill cursor), and
// beforeRemoveLiquidity (seeder LP lock).
uint160 constant BALLAST_HOOK_V5_FLAGS = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;

/// @title BallastHookV5 — gen-5 singleton v4 hook (Elysium)
///
/// @notice Everything gen-4's BallastHook does — skim a fee on the QUOTE-asset leg of
///         every swap, lock the seeder's LP — PLUS two gen-5 additions:
///
///         (1) CREATOR-PICKED FEE. Each pool's swap fee is chosen by the creator at
///             launch, 1%–10% (100–1000 bps), written ONCE by the seeder at seed time
///             and never changeable — there is no setter anywhere. Out-of-range values
///             are rejected. Split 80% creator-side (accrued to the token's
///             FeeRouter — i.e. BallastToken.creator()) / 20% protocol (accrued to the
///             immutable ProtocolFeeVault). No referrer bucket.
///
///         (2) RANGE-ORDER LIMIT ORDERS, fully on-chain, no keepers. A user places
///             single-sided liquidity in one tickSpacing-wide range at their target
///             price (`place`); as swaps move price across that range the order fills;
///             `afterSwap` detects crossings and converts filled orders to the output
///             asset, held by the hook for the owner to `withdraw`; `cancel` returns
///             unfilled (or partially-filled) liquidity. Fill accounting is epoch-based
///             and pro-rata, so many users can share one tick.
///
/// @dev GAS BOUND ON afterSwap. The fill loop steps tick-by-tick (by tickSpacing) from
///      the last-seen aligned tick toward the post-swap tick, capped at MAX_FILL_STEPS
///      iterations per call. If a single swap moves price more than
///      MAX_FILL_STEPS * tickSpacing ticks (≈ e^(300*60*1e-4) ≈ 6× price move), the
///      remaining ticks are filled by the NEXT swap, or immediately by anyone calling
///      the permissionless `poke(key)` — fills are never lost, only possibly deferred
///      one step. The cursor (`tickLowerLasts`) chases the current tick monotonically
///      in the direction of travel, so no order is skipped. Empty ticks cost one SLOAD;
///      only ticks that actually hold orders pay for a liquidity removal.
///
///      Direct-vs-unlock duality (same as Uniswap's canonical limit-order hook):
///      `place`/`cancel` run OUTSIDE a swap, so they open their own lock
///      (`poolManager.unlock`); fills run INSIDE the swap's lock in `afterSwap`, so they
///      call `modifyLiquidity`/`take` directly. Both resolve their own deltas to zero.
contract BallastHookV5 is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;
    using CurrencyLibrary for Currency;

    uint16 internal constant BPS = 10_000;
    /// @notice Max ticks scanned for fills per afterSwap/poke call (gas bound).
    uint256 public constant MAX_FILL_STEPS = 300;

    IPoolManager public immutable poolManager;
    /// @notice Protocol share of every fee, in bps (2000 = 20%). Immutable per chain.
    uint16 public immutable protocolFeeBps;
    /// @notice Lower/upper bounds on a creator-picked swap fee, in bps (100 / 1000).
    uint16 public immutable minFeeBps;
    uint16 public immutable maxFeeBps;
    /// @notice The ownerless ProtocolFeeVault that receives the protocol 20%. Wired
    ///         once at deploy (setProtocolVault) — the vault needs THIS hook's address
    ///         in its own constructor, so the hook must exist first (same bootstrap
    ///         shape as setSeeder). Until set, the protocol cut rolls into the
    ///         creator side (never lost, never reverts) — but it is always wired
    ///         before any pool exists.
    address public protocolVault;
    bool private _vaultSet;

    /// @notice Deployer (tx.origin at construction) — may call setSeeder /
    ///         setProtocolVault exactly once each.
    address private immutable _deployer;
    /// @notice The only address allowed to call initPool, and the only LP that
    ///         beforeRemoveLiquidity blocks. Wired once after the seeder deploys.
    address public seeder;
    bool private _seederSet;

    uint160 public constant FLAGS = BALLAST_HOOK_V5_FLAGS;

    // ---- per-pool creator fee (write-once) ---------------------------------
    mapping(bytes32 poolId => uint16) public poolFeeBps;
    mapping(bytes32 poolId => bool) public poolFeeSet;

    // ---- fee ledger: owed[recipient][currency], pull via claim(currency) ----
    mapping(address => mapping(address => uint256)) public owed;

    struct PoolInfo {
        address token;
        address quoteAsset;
    }

    mapping(bytes32 => PoolInfo) internal _pools;

    // ---- limit orders ------------------------------------------------------
    struct EpochInfo {
        bool filled;
        Currency currency0;
        Currency currency1;
        uint256 token0Total; // output owed, pro-rata by liquidity, once filled
        uint256 token1Total;
        uint128 liquidityTotal;
        mapping(address => uint128) liquidity;
    }

    /// @notice (poolId, tickLower, zeroForOne) -> active epoch id (0 = none).
    mapping(bytes32 => uint256) public epochOf;
    mapping(uint256 => EpochInfo) internal _epochInfos;
    uint256 public epochNext = 1;

    /// @notice Last aligned tick the fill cursor reached, per pool.
    mapping(bytes32 => int24) public tickLowerLasts;

    // ---- events ------------------------------------------------------------
    event FeeTaken(
        address indexed token,
        address indexed quoteAsset,
        uint256 fee,
        address creatorSide,
        uint256 creatorCut,
        address protocol,
        uint256 protocolCut
    );
    event Claimed(address indexed recipient, address indexed currency, uint256 amount);
    event PoolFeeSet(bytes32 indexed poolId, uint16 feeBps);
    event Place(
        address indexed owner, uint256 indexed epoch, bytes32 indexed poolId, int24 tickLower, bool zeroForOne, uint128 liquidity
    );
    event Cancel(address indexed owner, uint256 indexed epoch, bytes32 indexed poolId, uint128 liquidity);
    event Fill(uint256 indexed epoch, bytes32 indexed poolId, int24 tickLower, bool zeroForOne, uint256 token0, uint256 token1);
    event Withdraw(address indexed owner, uint256 indexed epoch, uint256 amount0, uint256 amount1);

    // ---- errors ------------------------------------------------------------
    error NotPoolManager();
    error NotDeployer();
    error NotSeeder();
    error AlreadySet();
    error ZeroAddress();
    error FeeOutOfRange();
    error SellExactOutNotSupported();
    error AmbiguousPool();
    error SeederLiquidityLocked();
    error ZeroLiquidity();
    error TickMisaligned();
    error NotSingleSided();
    error NoEpoch();
    error OrderFilled();
    error OrderNotFilled();
    error NothingToClaim();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, uint16 protocolFeeBps_, uint16 minFeeBps_, uint16 maxFeeBps_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ == 0 || protocolFeeBps_ >= BPS) revert FeeOutOfRange();
        if (minFeeBps_ == 0 || minFeeBps_ > maxFeeBps_ || maxFeeBps_ >= BPS) revert FeeOutOfRange();
        poolManager = poolManager_;
        protocolFeeBps = protocolFeeBps_;
        minFeeBps = minFeeBps_;
        maxFeeBps = maxFeeBps_;
        _deployer = tx.origin;
    }

    // --------------------------------------------------------------------- //
    //  One-time wiring + per-pool fee (write-once)                          //
    // --------------------------------------------------------------------- //
    function setSeeder(address seeder_) external {
        if (tx.origin != _deployer) revert NotDeployer();
        if (_seederSet) revert AlreadySet();
        if (seeder_ == address(0)) revert ZeroAddress();
        seeder = seeder_;
        _seederSet = true;
    }

    /// @notice Wire the ProtocolFeeVault once, immediately after it deploys.
    function setProtocolVault(address vault_) external {
        if (tx.origin != _deployer) revert NotDeployer();
        if (_vaultSet) revert AlreadySet();
        if (vault_ == address(0)) revert ZeroAddress();
        protocolVault = vault_;
        _vaultSet = true;
    }

    /// @notice Record this pool's creator-picked fee. Callable ONLY by the seeder,
    ///         ONLY once per pool. 1%–10%. There is no setter to change it afterward.
    function initPool(PoolKey calldata key, uint16 feeBps) external {
        if (msg.sender != seeder) revert NotSeeder();
        bytes32 id = PoolId.unwrap(key.toId());
        if (poolFeeSet[id]) revert AlreadySet();
        if (feeBps < minFeeBps || feeBps > maxFeeBps) revert FeeOutOfRange();
        poolFeeBps[id] = feeBps;
        poolFeeSet[id] = true;
        emit PoolFeeSet(id, feeBps);
    }

    function getHookPermissions() external pure returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
        p.beforeRemoveLiquidity = true;
    }

    // --------------------------------------------------------------------- //
    //  Pool lifecycle hooks                                                 //
    // --------------------------------------------------------------------- //
    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        tickLowerLasts[PoolId.unwrap(key.toId())] = _alignTick(tick, key.tickSpacing);
        return IHooks.afterInitialize.selector;
    }

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
    //  Swap fee skim (same four-case logic as gen-4) + limit-order fills    //
    // --------------------------------------------------------------------- //
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint256 fee = _beforeFee(key, params);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function _beforeFee(PoolKey calldata key, IPoolManager.SwapParams calldata params) internal returns (uint256 fee) {
        (address token, address quoteAsset) = _resolvePool(key);
        bool exactIn = params.amountSpecified < 0;
        if (Currency.unwrap(_specified(key, params.zeroForOne, exactIn)) != quoteAsset) return 0;
        if (!exactIn) revert SellExactOutNotSupported();
        fee = _feeOn(PoolId.unwrap(key.toId()), uint256(-params.amountSpecified));
        if (fee == 0) return 0;
        // Collect the fee as ERC-6909 claims (balance-free: no real transfer needed,
        // so a brand-new one-sided pool whose manager holds no quote asset yet does
        // NOT revert on the first swap). Redeemed to real ERC-20 at claim() time,
        // backed by the quote the swapper settles into the manager.
        poolManager.mint(address(this), Currency.wrap(quoteAsset).toId(), fee);
        _distribute(token, quoteAsset, fee);
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        uint256 fee = _afterFee(key, params, delta);
        // Fills resolve their OWN deltas (modifyLiquidity + take) within this lock;
        // independent of the fee return delta below.
        _fillCrossed(key);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _afterFee(PoolKey calldata key, IPoolManager.SwapParams calldata params, BalanceDelta delta)
        internal
        returns (uint256 fee)
    {
        (address token, address quoteAsset) = _resolvePool(key);
        bool exactIn = params.amountSpecified < 0;
        if (Currency.unwrap(_specified(key, params.zeroForOne, exactIn)) == quoteAsset) return 0;
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quoteAsset;
        int128 quoteDelta = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        uint256 amt = uint256(int256(quoteDelta < 0 ? -quoteDelta : quoteDelta));
        fee = _feeOn(PoolId.unwrap(key.toId()), amt);
        if (fee == 0) return 0;
        // Collect the fee as ERC-6909 claims (balance-free: no real transfer needed,
        // so a brand-new one-sided pool whose manager holds no quote asset yet does
        // NOT revert on the first swap). Redeemed to real ERC-20 at claim() time,
        // backed by the quote the swapper settles into the manager.
        poolManager.mint(address(this), Currency.wrap(quoteAsset).toId(), fee);
        _distribute(token, quoteAsset, fee);
    }

    function _feeOn(bytes32 id, uint256 amt) internal view returns (uint256) {
        return (amt * poolFeeBps[id]) / BPS;
    }

    function _distribute(address token, address quoteAsset, uint256 fee) internal {
        address creatorSide = BallastToken(token).creator(); // the token's FeeRouter
        address pv = protocolVault;
        if (pv == address(0)) {
            // Pre-wiring window only (never reached in practice — the vault is wired
            // before any pool exists). Roll the whole fee to the creator side so no
            // value is ever lost to address(0) and no swap ever reverts.
            owed[creatorSide][quoteAsset] += fee;
            emit FeeTaken(token, quoteAsset, fee, creatorSide, fee, address(0), 0);
            return;
        }
        uint256 protocolCut = (fee * protocolFeeBps) / BPS;
        uint256 creatorCut = fee - protocolCut; // remainder-safe, 80%
        owed[creatorSide][quoteAsset] += creatorCut;
        owed[pv][quoteAsset] += protocolCut;
        emit FeeTaken(token, quoteAsset, fee, creatorSide, creatorCut, pv, protocolCut);
    }

    /// @notice Pull `currency` owed to the caller (fee split + nothing else). Redeems
    ///         the hook's ERC-6909 fee claims into real ERC-20 inside an unlock.
    function claim(address currency) external nonReentrant returns (uint256 amount) {
        amount = owed[msg.sender][currency];
        if (amount == 0) return 0;
        owed[msg.sender][currency] = 0;
        poolManager.unlock(abi.encode(_ACTION_CLAIM, abi.encode(currency, msg.sender, amount)));
        emit Claimed(msg.sender, currency, amount);
    }

    // --------------------------------------------------------------------- //
    //  Pool resolution — which side is the token                            //
    // --------------------------------------------------------------------- //
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
    //  Limit orders — place / cancel / withdraw                             //
    // --------------------------------------------------------------------- //
    uint8 private constant _ACTION_PLACE = 1;
    uint8 private constant _ACTION_CANCEL = 2;
    uint8 private constant _ACTION_POKE = 3;
    uint8 private constant _ACTION_CLAIM = 4;

    /// @notice Place a single-sided range order of `liquidity` at [tickLower,
    ///         tickLower+tickSpacing]. `zeroForOne` = provides currency0 (fills on an
    ///         up-move); `!zeroForOne` = provides currency1 (fills on a down-move). The
    ///         range must sit entirely on the correct side of the current price —
    ///         otherwise the add is not single-sided and reverts. Caller must have
    ///         approved this hook for the input currency.
    function place(PoolKey calldata key, int24 tickLower, bool zeroForOne, uint128 liquidity)
        external
        nonReentrant
        returns (uint256 epoch)
    {
        if (liquidity == 0) revert ZeroLiquidity();
        if (tickLower % key.tickSpacing != 0) revert TickMisaligned();

        poolManager.unlock(abi.encode(_ACTION_PLACE, abi.encode(key, tickLower, zeroForOne, liquidity, msg.sender)));

        bytes32 slot = _orderSlot(key, tickLower, zeroForOne);
        epoch = epochOf[slot];
        if (epoch == 0) {
            epoch = epochNext++;
            epochOf[slot] = epoch;
            EpochInfo storage fresh = _epochInfos[epoch];
            fresh.currency0 = key.currency0;
            fresh.currency1 = key.currency1;
        }
        EpochInfo storage info = _epochInfos[epoch];
        info.liquidityTotal += liquidity;
        info.liquidity[msg.sender] += liquidity;
        emit Place(msg.sender, epoch, PoolId.unwrap(key.toId()), tickLower, zeroForOne, liquidity);
    }

    /// @notice Cancel the caller's unfilled (or partially-filled) order at this slot,
    ///         returning its current liquidity to `to` (a mix of both currencies if
    ///         price is mid-range). A fully-filled order must use `withdraw` instead.
    function cancel(PoolKey calldata key, int24 tickLower, bool zeroForOne, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        bytes32 slot = _orderSlot(key, tickLower, zeroForOne);
        uint256 epoch = epochOf[slot];
        if (epoch == 0) revert NoEpoch();
        EpochInfo storage info = _epochInfos[epoch];
        if (info.filled) revert OrderFilled();
        uint128 liq = info.liquidity[msg.sender];
        if (liq == 0) revert ZeroLiquidity();

        info.liquidity[msg.sender] = 0;
        info.liquidityTotal -= liq;

        bytes memory ret = poolManager.unlock(abi.encode(_ACTION_CANCEL, abi.encode(key, tickLower, liq, to)));
        (amount0, amount1) = abi.decode(ret, (uint256, uint256));
        emit Cancel(msg.sender, epoch, PoolId.unwrap(key.toId()), liq);
    }

    /// @notice Withdraw the caller's pro-rata output from a FILLED order.
    function withdraw(uint256 epoch, address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        EpochInfo storage info = _epochInfos[epoch];
        if (!info.filled) revert OrderNotFilled();
        uint128 liq = info.liquidity[msg.sender];
        if (liq == 0) revert ZeroLiquidity();
        uint128 liqTotal = info.liquidityTotal;

        amount0 = FullMath.mulDiv(info.token0Total, liq, liqTotal);
        amount1 = FullMath.mulDiv(info.token1Total, liq, liqTotal);

        info.liquidity[msg.sender] = 0;
        info.liquidityTotal = liqTotal - liq;
        info.token0Total -= amount0;
        info.token1Total -= amount1;

        if (amount0 == 0 && amount1 == 0) revert NothingToClaim();
        if (amount0 != 0) IERC20(Currency.unwrap(info.currency0)).safeTransfer(to, amount0);
        if (amount1 != 0) IERC20(Currency.unwrap(info.currency1)).safeTransfer(to, amount1);
        emit Withdraw(msg.sender, epoch, amount0, amount1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == _ACTION_POKE) {
            PoolKey memory key = abi.decode(payload, (PoolKey));
            _fillCrossed(key);
            return "";
        }

        if (action == _ACTION_CLAIM) {
            // Redeem the hook's ERC-6909 fee claims for `currency` into real ERC-20,
            // paid to the claimant. Backed by quote the swappers already settled in.
            (address currency, address to, uint256 amount) = abi.decode(payload, (address, address, uint256));
            poolManager.burn(address(this), Currency.wrap(currency).toId(), amount);
            Currency.wrap(currency).take(poolManager, to, amount, false);
            return "";
        }

        if (action == _ACTION_PLACE) {
            (PoolKey memory key, int24 tickLower, bool zeroForOne, uint128 liquidity, address who) =
                abi.decode(payload, (PoolKey, int24, bool, uint128, address));
            (BalanceDelta placeDelta,) = poolManager.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickLower + key.tickSpacing,
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: 0
                }),
                ""
            );
            // Enforce single-sided: only the provided currency may be owed.
            if (zeroForOne) {
                if (placeDelta.amount1() != 0) revert NotSingleSided();
                key.currency0.settle(poolManager, who, uint256(uint128(-placeDelta.amount0())), false);
            } else {
                if (placeDelta.amount0() != 0) revert NotSingleSided();
                key.currency1.settle(poolManager, who, uint256(uint128(-placeDelta.amount1())), false);
            }
            return "";
        }

        // _ACTION_CANCEL
        (PoolKey memory cKey, int24 cTickLower, uint128 cLiquidity, address cWho) =
            abi.decode(payload, (PoolKey, int24, uint128, address));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            cKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: cTickLower,
                tickUpper: cTickLower + cKey.tickSpacing,
                liquidityDelta: -int256(uint256(cLiquidity)),
                salt: 0
            }),
            ""
        );
        uint256 amount0 = delta.amount0() > 0 ? uint256(uint128(delta.amount0())) : 0;
        uint256 amount1 = delta.amount1() > 0 ? uint256(uint128(delta.amount1())) : 0;
        if (amount0 != 0) cKey.currency0.take(poolManager, cWho, amount0, false);
        if (amount1 != 0) cKey.currency1.take(poolManager, cWho, amount1, false);
        return abi.encode(amount0, amount1);
    }

    // --------------------------------------------------------------------- //
    //  Fill engine — gas-bounded, keeper-free                               //
    // --------------------------------------------------------------------- //
    /// @notice Permissionless: advance the fill cursor to the current tick, filling any
    ///         orders crossed since the last swap/poke. Use after a swap that moved
    ///         price more than MAX_FILL_STEPS*tickSpacing ticks left orders deferred.
    function poke(PoolKey calldata key) external nonReentrant {
        poolManager.unlock(abi.encode(_ACTION_POKE, abi.encode(key)));
    }

    function _fillCrossed(PoolKey memory key) internal {
        bytes32 id = PoolId.unwrap(key.toId());
        int24 spacing = key.tickSpacing;
        (, int24 tickNow,,) = poolManager.getSlot0(key.toId());
        int24 currentLower = _alignTick(tickNow, spacing);
        int24 last = tickLowerLasts[id];
        if (currentLower == last) return;

        uint256 steps;
        int24 cursor = last;
        if (currentLower > last) {
            // price up -> fill currency0 (zeroForOne) orders at [last, currentLower-spacing]
            while (cursor <= currentLower - spacing && steps < MAX_FILL_STEPS) {
                _fillEpoch(key, id, cursor, true);
                cursor += spacing;
                unchecked { steps++; }
            }
            tickLowerLasts[id] = (cursor > currentLower - spacing) ? currentLower : cursor;
        } else {
            // price down -> fill currency1 (!zeroForOne) orders at [currentLower+spacing, last]
            while (cursor >= currentLower + spacing && steps < MAX_FILL_STEPS) {
                _fillEpoch(key, id, cursor, false);
                cursor -= spacing;
                unchecked { steps++; }
            }
            tickLowerLasts[id] = (cursor < currentLower + spacing) ? currentLower : cursor;
        }
    }

    function _fillEpoch(PoolKey memory key, bytes32 id, int24 tickLower, bool zeroForOne) internal {
        bytes32 slot = keccak256(abi.encodePacked(id, tickLower, zeroForOne));
        uint256 epoch = epochOf[slot];
        if (epoch == 0) return; // no orders at this tick/direction
        EpochInfo storage info = _epochInfos[epoch];
        uint128 liq = info.liquidityTotal;
        if (liq == 0) {
            epochOf[slot] = 0;
            return;
        }

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickLower + key.tickSpacing,
                liquidityDelta: -int256(uint256(liq)),
                salt: 0
            }),
            ""
        );
        uint256 amount0 = delta.amount0() > 0 ? uint256(uint128(delta.amount0())) : 0;
        uint256 amount1 = delta.amount1() > 0 ? uint256(uint128(delta.amount1())) : 0;
        if (amount0 != 0) key.currency0.take(poolManager, address(this), amount0, false);
        if (amount1 != 0) key.currency1.take(poolManager, address(this), amount1, false);

        info.filled = true;
        info.token0Total = amount0;
        info.token1Total = amount1;
        epochOf[slot] = 0; // detach — a new epoch can form at this slot again
        emit Fill(epoch, id, tickLower, zeroForOne, amount0, amount1);
    }

    // --------------------------------------------------------------------- //
    //  Views + helpers                                                      //
    // --------------------------------------------------------------------- //
    function epochLiquidity(uint256 epoch, address owner) external view returns (uint128) {
        return _epochInfos[epoch].liquidity[owner];
    }

    function epochInfo(uint256 epoch)
        external
        view
        returns (bool filled, uint256 token0Total, uint256 token1Total, uint128 liquidityTotal)
    {
        EpochInfo storage info = _epochInfos[epoch];
        return (info.filled, info.token0Total, info.token1Total, info.liquidityTotal);
    }

    function _orderSlot(PoolKey calldata key, int24 tickLower, bool zeroForOne) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PoolId.unwrap(key.toId()), tickLower, zeroForOne));
    }

    function _alignTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }

    function _specified(PoolKey calldata key, bool zeroForOne, bool exactIn) internal pure returns (Currency) {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        return exactIn ? input : output;
    }
}
