// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";

/// @title OpenTreasuryVault — anyone deposits a listed asset, earns a variable
///        pro-rata share of the token's real trading fees, withdraws their own
///        principal whenever they want (after a short holding period)
///
/// @notice One clone per token (see OpenTreasuryVaultFactory). This is a DIFFERENT
///         product from ProjectTreasury: ProjectTreasury's third-party bucket locks
///         deposits permanently and pays nothing. This vault never locks principal
///         (withdrawable by the depositor, always, after `minHoldTime`) and funds
///         rewards only from real trading-fee WETH pulled in via `notifyReward`/
///         `sync` — nothing is ever minted, and rewards never come from principal
///         or new deposits.
///
/// @dev No owner, no admin, no pause, no upgradeability, no rescue function. The
///      only function that ever moves principal out is `withdraw`, only to the
///      depositor who owns it, only up to what they themselves deposited. See
///      docs/OPEN_TREASURY_DESIGN.md for the full design and threat model.
///
///      Deployed as an EIP-1167 minimal proxy clone with config set once via
///      `initialize()` instead of a constructor (clones share bytecode, so
///      Solidity's `immutable` keyword cannot hold per-clone values).
contract OpenTreasuryVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @notice Per-asset circuit breaker: a newly read price may not move more than
    ///         this many bps from the last price THIS CONTRACT itself observed for
    ///         that asset. Mirrors FeeRouter/BuybackBurnerV2's existing
    ///         MAX_SLIPPAGE_BPS = 2_000 ceiling — reusing an already-precedented
    ///         magnitude rather than inventing a new one. No second price source
    ///         exists on this chain to cross-check against; this bounds the blast
    ///         radius of a single bad round, nothing more.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 2_000;

    // --------------------------------------------------------------------- //
    //  Config — set once in initialize(); no setter exists for any of it    //
    // --------------------------------------------------------------------- //

    address public token;
    address public factory; // informational only — no call is ever gated to it
    address public registry;
    address public rewardAsset;
    uint256 public minHoldTime;
    uint256 public rewardsDuration;
    bool public initialized;

    // --------------------------------------------------------------------- //
    //  Principal accounting                                                 //
    // --------------------------------------------------------------------- //

    mapping(address asset => uint256) public totalPrincipal;
    mapping(address asset => uint256) public lastPrice; // last observed feed price, this asset

    mapping(address depositor => mapping(address asset => uint256)) public principal;
    mapping(address depositor => mapping(address asset => uint256)) public assetWeight; // USD, 1e18
    mapping(address depositor => mapping(address asset => uint256)) public lastDepositAt;
    mapping(address depositor => uint256) public weightOf;
    uint256 public totalWeight;

    address[] private _assets;
    mapping(address asset => bool) private _assetKnown;
    mapping(address depositor => address[]) private _depositorAssets;
    mapping(address depositor => mapping(address asset => bool)) private _depositorAssetKnown;

    // --------------------------------------------------------------------- //
    //  Reward accumulator — linear stream over rewardsDuration               //
    // --------------------------------------------------------------------- //

    uint256 public periodFinish;
    uint256 public rewardRate; // rewardAsset units per second
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    mapping(address depositor => uint256) public userRewardPerWeightPaid;
    mapping(address depositor => uint256) public rewards;
    /// @notice Reward received while totalWeight == 0, carried to the stream once
    ///         weight first becomes non-zero. Never lost, never capturable by
    ///         whoever happens to deposit first (deposit updates reward state
    ///         using each account's OWN pre-deposit weight before adding any).
    uint256 public pendingReward;

    uint256 public totalRewardDeposited;
    uint256 public totalRewardClaimed;

    // --------------------------------------------------------------------- //
    //  Events                                                               //
    // --------------------------------------------------------------------- //

    event VaultInitialized(address indexed token, address indexed factory, address registry, address rewardAsset, uint256 minHoldTime, uint256 rewardsDuration);
    event Deposited(address indexed depositor, address indexed asset, uint256 amount, uint256 weight);
    event Withdrawn(address indexed depositor, address indexed asset, uint256 amount, uint256 weightRemoved);
    event Claimed(address indexed depositor, uint256 amount);
    event RewardAdded(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event RewardHeld(uint256 amount, uint256 totalPending);
    event Synced(uint256 added);

    // --------------------------------------------------------------------- //
    //  Errors                                                               //
    // --------------------------------------------------------------------- //

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error SelfBacking();
    error AssetNotAllowed(address asset);
    error BelowMinimum(uint256 amount, uint256 minimum);
    error InvalidPrice(address asset);
    error StalePrice(address asset, uint256 updatedAt);
    error PriceDeviationTooLarge(address asset, uint256 lastSeen, uint256 observed);
    error InsufficientBalance(uint256 requested, uint256 available);
    error StillLocked(uint256 unlockAt);

    constructor() {
        // Logic contract only ever runs via delegatecall from a clone; direct
        // initialize() on this instance is harmless (see design doc §3.1 — clones
        // have independent storage, nobody's real funds are ever sent here).
    }

    // --------------------------------------------------------------------- //
    //  Init — called once, by the factory, in the same tx as the clone      //
    // --------------------------------------------------------------------- //

    /// @notice One-shot config. Clones share bytecode, so this stands in for a
    ///         constructor — see contract-level note.
    function initialize(
        address token_,
        address factory_,
        address registry_,
        address rewardAsset_,
        uint256 minHoldTime_,
        uint256 rewardsDuration_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (token_ == address(0) || factory_ == address(0) || registry_ == address(0) || rewardAsset_ == address(0)) {
            revert ZeroAddress();
        }
        if (minHoldTime_ == 0 || rewardsDuration_ == 0) revert ZeroAmount();

        initialized = true;
        token = token_;
        factory = factory_;
        registry = registry_;
        rewardAsset = rewardAsset_;
        minHoldTime = minHoldTime_;
        rewardsDuration = rewardsDuration_;

        emit VaultInitialized(token_, factory_, registry_, rewardAsset_, minHoldTime_, rewardsDuration_);
    }

    // --------------------------------------------------------------------- //
    //  Deposit                                                               //
    // --------------------------------------------------------------------- //

    /// @notice Deposit `amount` of a listed asset. Credits the amount ACTUALLY
    ///         received (balance before/after — handles fee-on-transfer assets
    ///         correctly) at its USD value right now, priced through the same
    ///         registry feed BackingLens uses. Reverts on a stale, missing, or
    ///         wildly-deviated price — unlike BackingLens's read-only display path,
    ///         this mints weight against new money and must fail closed (see
    ///         docs/OPEN_TREASURY_DESIGN.md §1.2 for why this is a deliberate
    ///         divergence, not a violation, of "never revert on a stale price").
    function deposit(address asset, uint256 amount) external nonReentrant {
        if (asset == token) revert SelfBacking();
        if (amount == 0) revert ZeroAmount();
        if (!IAssetRegistry(registry).isAllowed(asset)) revert AssetNotAllowed(asset);
        uint256 min = IAssetRegistry(registry).minDeposit(asset);
        if (amount < min) revert BelowMinimum(amount, min);

        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        uint256 valueUsd = _priceAndValue(asset, received);

        _updateReward(msg.sender); // settle with the OLD weight before adding any

        principal[msg.sender][asset] += received;
        totalPrincipal[asset] += received;
        assetWeight[msg.sender][asset] += valueUsd;
        weightOf[msg.sender] += valueUsd;
        lastDepositAt[msg.sender][asset] = block.timestamp; // resets the hold clock for the WHOLE asset balance (D3 — conservative, no FIFO ledger)

        bool wasZero = totalWeight == 0;
        totalWeight += valueUsd;

        _track(asset);
        _trackDepositor(msg.sender, asset);

        if (wasZero && totalWeight > 0 && pendingReward > 0) {
            _addReward(0); // folds pendingReward into a fresh stream now that weight exists
        }

        emit Deposited(msg.sender, asset, received, valueUsd);
    }

    // --------------------------------------------------------------------- //
    //  Withdraw — principal only, depositor only, never blocked             //
    // --------------------------------------------------------------------- //

    /// @notice Withdraw up to `amount` of the caller's own principal in `asset`.
    ///         Never re-reads a price (weight is removed proportionally from what
    ///         was recorded at deposit time) and never checks the registry — works
    ///         for a delisted asset exactly as well as a listed one. Settles
    ///         rewards first (rule 15).
    function withdraw(address asset, uint256 amount) external nonReentrant {
        uint256 p = principal[msg.sender][asset];
        if (amount == 0) revert ZeroAmount();
        if (amount > p) revert InsufficientBalance(amount, p);
        uint256 unlockAt = lastDepositAt[msg.sender][asset] + minHoldTime;
        if (block.timestamp < unlockAt) revert StillLocked(unlockAt);

        _updateReward(msg.sender); // settle with the OLD weight before removing any

        uint256 w = assetWeight[msg.sender][asset];
        uint256 weightRemoved = (w * amount) / p; // floor; amount == p removes exactly w

        principal[msg.sender][asset] = p - amount;
        totalPrincipal[asset] -= amount;
        assetWeight[msg.sender][asset] = w - weightRemoved;
        weightOf[msg.sender] -= weightRemoved;
        totalWeight -= weightRemoved;

        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount, weightRemoved);
    }

    // --------------------------------------------------------------------- //
    //  Claim                                                                 //
    // --------------------------------------------------------------------- //

    /// @notice Claim the caller's own accrued rewards, any time, never forfeited.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = _claim(msg.sender);
    }

    /// @notice Claim on behalf of `depositor` — permissionless, but funds can only
    ///         ever go to `depositor`, never to the caller. Rule 15's explicit
    ///         "fine if it can only pay the depositor."
    function claimFor(address depositor) external nonReentrant returns (uint256 amount) {
        amount = _claim(depositor);
    }

    function _claim(address depositor) internal returns (uint256 amount) {
        _updateReward(depositor);
        amount = rewards[depositor];
        if (amount != 0) {
            rewards[depositor] = 0;
            totalRewardClaimed += amount;
            IERC20(rewardAsset).safeTransfer(depositor, amount);
        }
        emit Claimed(depositor, amount);
    }

    // --------------------------------------------------------------------- //
    //  Reward funding — both permissionless (rules 11, 12)                  //
    // --------------------------------------------------------------------- //

    /// @notice Pull `amount` of rewardAsset from the caller and add it to the
    ///         stream. Works today with no FeeRouter: a creator who `claim()`ed
    ///         WETH from the hook can fund it directly; so can anyone else.
    function notifyReward(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(rewardAsset).safeTransferFrom(msg.sender, address(this), amount);
        totalRewardDeposited += amount;
        _addReward(amount);
    }

    /// @notice Detects rewardAsset balance above what principal + the existing
    ///         reward liability account for, and streams the surplus. Lets a
    ///         future FeeRouter rewards bucket fund this vault with a plain
    ///         transfer, no call required. Cannot ever mistake deposited
    ///         principal for a reward — see docs/OPEN_TREASURY_DESIGN.md §4.4.
    function sync() external nonReentrant returns (uint256 added) {
        uint256 bal = IERC20(rewardAsset).balanceOf(address(this));
        uint256 accounted = totalPrincipal[rewardAsset] + (totalRewardDeposited - totalRewardClaimed);
        if (bal <= accounted) return 0;
        added = bal - accounted;
        totalRewardDeposited += added;
        _addReward(added);
        emit Synced(added);
    }

    function _addReward(uint256 amount) internal {
        _updateReward(address(0)); // roll the accumulator forward to "now" before changing rate
        if (totalWeight == 0) {
            if (amount == 0) return;
            pendingReward += amount;
            emit RewardHeld(amount, pendingReward);
            return;
        }
        uint256 totalForStream = amount + pendingReward;
        if (totalForStream == 0) return;
        pendingReward = 0;

        if (block.timestamp >= periodFinish) {
            rewardRate = totalForStream / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (totalForStream + leftover) / rewardsDuration;
        }
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(totalForStream, rewardRate, periodFinish);
    }

    // --------------------------------------------------------------------- //
    //  Reward accumulator internals (Synthetix-shape, linear stream)         //
    // --------------------------------------------------------------------- //

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerWeight() public view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * WAD) / totalWeight;
    }

    /// @notice Rewards accrued to `account` so far, claimable via claim()/claimFor().
    function earned(address account) public view returns (uint256) {
        return rewards[account] + (weightOf[account] * (rewardPerWeight() - userRewardPerWeightPaid[account])) / WAD;
    }

    function _updateReward(address account) internal {
        rewardPerWeightStored = rewardPerWeight();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerWeightPaid[account] = rewardPerWeightStored;
        }
    }

    // --------------------------------------------------------------------- //
    //  Pricing — same source BackingLens uses, deposit-time guard           //
    // --------------------------------------------------------------------- //

    /// @dev No try/catch here, unlike BackingLens's display-only reads — a revert
    ///      is the CORRECT outcome for a deposit (fail closed rather than silently
    ///      mis-weighting). decimals() is also read directly, not defensively
    ///      fallback-to-18'd: a registry-allowlisted asset is expected to answer
    ///      it reliably (the rest of the pricing pipeline, incl. BackingLens,
    ///      already depends on that being true), and silently mis-weighting a
    ///      deposit is worse than reverting loudly.
    function _priceAndValue(address asset, uint256 amount) internal returns (uint256 valueUsd) {
        address feedAddr = IAssetRegistry(registry).feedOf(asset);
        if (feedAddr == address(0)) revert AssetNotAllowed(asset); // delisted — rule 8: no NEW deposit
        AggregatorV3Interface feed = AggregatorV3Interface(feedAddr);

        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice(asset);
        uint256 price = uint256(answer);

        uint256 staleAfter = IAssetRegistry(registry).staleAfter(asset);
        if (block.timestamp - updatedAt > staleAfter) revert StalePrice(asset, updatedAt);

        uint256 last = lastPrice[asset];
        if (last != 0) {
            uint256 lo = (last * (BPS - MAX_PRICE_DEVIATION_BPS)) / BPS;
            uint256 hi = (last * (BPS + MAX_PRICE_DEVIATION_BPS)) / BPS;
            if (price < lo || price > hi) revert PriceDeviationTooLarge(asset, last, price);
        }
        lastPrice[asset] = price;

        uint8 priceDec = feed.decimals();
        uint8 assetDec = IERC20Metadata(asset).decimals();
        if (amount == 0 || price == 0) return 0;
        valueUsd = (amount * price * WAD) / (10 ** assetDec * 10 ** priceDec);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                 //
    // --------------------------------------------------------------------- //

    /// @notice Timestamp a depositor's CURRENT balance of `asset` becomes
    ///         withdrawable; 0 if they have never deposited it.
    function pendingWithdrawAt(address depositor, address asset) external view returns (uint256) {
        uint256 last = lastDepositAt[depositor][asset];
        return last == 0 ? 0 : last + minHoldTime;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function assetsOf(address depositor) external view returns (address[] memory) {
        return _depositorAssets[depositor];
    }

    // --------------------------------------------------------------------- //
    //  Internal tracking                                                    //
    // --------------------------------------------------------------------- //

    function _track(address asset) internal {
        if (!_assetKnown[asset]) {
            _assetKnown[asset] = true;
            _assets.push(asset);
        }
    }

    function _trackDepositor(address depositor, address asset) internal {
        if (!_depositorAssetKnown[depositor][asset]) {
            _depositorAssetKnown[depositor][asset] = true;
            _depositorAssets[depositor].push(asset);
        }
    }
}
