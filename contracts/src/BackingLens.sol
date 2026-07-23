// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {IAssetRegistry, MarketHours} from "./interfaces/IAssetRegistry.sol";
import {ProjectTreasury} from "./ProjectTreasury.sol";

/// @title BackingLens
/// @notice Lens-style batched read aggregator. One call powers a whole backing
///         panel, so the rate-limited public RPC isn't hit dozens of times per
///         screen (docs/robinhood-chain-research.md §1).
///
/// @dev Encodes the non-negotiable valuation rules:
///
///   1. NEVER revert on a stale price. Robinhood equity feeds have no heartbeat
///      off-hours; they hold the last published price. Staleness is a per-asset
///      flag, never a throw. The fine RESTING-vs-STALE distinction is computed
///      off-chain from `marketHours` + `updatedAt` (web/lib/marketHours.ts); the
///      on-chain `stale` flag is the coarse absolute outer bound.
///
///   2. NEVER apply `uiMultiplier()` to the feed price — it already includes it.
///
///   3. Read `decimals()` from each feed. Never hardcode.
///
///   4. The L2 sequencer uptime feed is OPTIONAL and configurable. Robinhood Chain
///      (4663) has no such feed published, and a hard dependency would brick the
///      product exactly like a reverting stale-check would — the same failure this
///      product forbids. When the feed is unset, valuation PROCEEDS and reports
///      `sequencerStatus = Unknown` so the UI can say "sequencer status
///      unverifiable" honestly. When a feed IS set, Down/GracePeriod mark prices
///      untrusted. Setting the address later turns the check on with no code change.
///
///   5. Reject zero/negative answers — a genuine oracle fault (priced=false), not
///      summed.
///
/// All USD values are returned in 1e18 fixed point.
contract BackingLens {
    /// @notice Chainlink L2 Sequencer Uptime Feed. `answer == 0` means up. May be
    ///         the zero address when the chain has no such feed (then status is
    ///         reported Unknown and prices are still valued).
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;
    uint256 private constant WAD = 1e18;

    enum SequencerStatus {
        Unknown, // no feed configured — cannot verify (prices still valued, flagged)
        Up,
        GracePeriod, // recently recovered; not yet trusted
        Down
    }

    struct AssetBacking {
        address asset;
        uint256 lockedBalance; // asset decimals
        uint256 withdrawableBalance; // asset decimals
        uint256 price; // feed decimals
        uint8 priceDecimals;
        uint8 assetDecimals;
        uint256 updatedAt; // raw feed timestamp — source of truth for freshness
        uint8 marketHours; // MarketHours enum; off-chain tiering input
        uint256 lockedValueUsd; // 1e18
        uint256 withdrawableValueUsd; // 1e18
        bool priced; // false => excluded from totals (fault / sequencer down)
        bool stale; // coarse: age exceeded the absolute outer bound (still counts)
        bool oraclePaused; // ERC-8056 advisory flag, if the token exposes it
    }

    struct Backing {
        SequencerStatus sequencerStatus;
        uint256 totalSupply; // 18 decimals
        uint256 lockedValueUsd; // 1e18
        uint256 withdrawableValueUsd; // 1e18
        uint256 totalValueUsd; // 1e18
        uint256 backingPerToken; // 1e18 USD per whole token
        uint256 lockedBackingPerToken; // 1e18 USD per whole token
        bool anyStale;
        bool anyUnpriced;
        AssetBacking[] assets;
    }

    /// @param sequencerUptimeFeed_ the L2 sequencer feed, or address(0) if the
    ///        chain has none (status will be reported Unknown).
    constructor(address sequencerUptimeFeed_) {
        sequencerUptimeFeed = AggregatorV3Interface(sequencerUptimeFeed_);
    }

    /// @notice Full backing breakdown for a treasury in a single call.
    function backingOf(address treasuryAddr) external view returns (Backing memory b) {
        ProjectTreasury treasury = ProjectTreasury(treasuryAddr);
        IAssetRegistry registry = treasury.registry();
        address projectToken = treasury.projectToken();

        SequencerStatus status = _sequencerState();
        b.sequencerStatus = status;
        b.totalSupply = IERC20Metadata(projectToken).totalSupply();

        // Trust prices when the sequencer is Up, or when we simply cannot check
        // (Unknown — no feed on this chain). Down / GracePeriod are NOT trusted.
        bool trustPrices = (status == SequencerStatus.Up || status == SequencerStatus.Unknown);

        address[] memory assetList = treasury.assets();
        b.assets = new AssetBacking[](assetList.length);

        for (uint256 i = 0; i < assetList.length; i++) {
            AssetBacking memory a = _valueAsset(treasury, registry, assetList[i], trustPrices);
            b.assets[i] = a;
            b.lockedValueUsd += a.lockedValueUsd;
            b.withdrawableValueUsd += a.withdrawableValueUsd;
            if (a.stale) b.anyStale = true;
            if (!a.priced) b.anyUnpriced = true;
        }

        b.totalValueUsd = b.lockedValueUsd + b.withdrawableValueUsd;
        if (b.totalSupply > 0) {
            b.backingPerToken = (b.totalValueUsd * WAD) / b.totalSupply;
            b.lockedBackingPerToken = (b.lockedValueUsd * WAD) / b.totalSupply;
        }
    }

    /// @notice Spec §5 `priceOf`: price + age + staleness, never reverts on a
    ///         resting off-hours price. Reverts only on an invalid answer.
    function priceOf(address registryAddr, address asset)
        external
        view
        returns (uint256 price, uint256 updatedAt, bool stale)
    {
        IAssetRegistry registry = IAssetRegistry(registryAddr);
        AggregatorV3Interface feed = AggregatorV3Interface(registry.feedOf(asset));
        (, int256 answer,, uint256 ts,) = feed.latestRoundData();
        require(answer > 0, "invalid price");
        price = uint256(answer);
        updatedAt = ts;
        stale = (block.timestamp - ts) > registry.staleAfter(asset);
    }

    // --------------------------------------------------------------------- //
    //  Internal                                                             //
    // --------------------------------------------------------------------- //

    function _valueAsset(ProjectTreasury treasury, IAssetRegistry registry, address asset, bool trustPrices)
        internal
        view
        returns (AssetBacking memory a)
    {
        a.asset = asset;
        a.lockedBalance = treasury.lockedBalance(asset);
        a.withdrawableBalance = treasury.creatorWithdrawable(asset);
        a.assetDecimals = _tryDecimals(asset);
        a.oraclePaused = _tryOraclePaused(asset);
        a.marketHours = uint8(registry.marketHoursOf(asset));

        address feedAddr = registry.feedOf(asset);
        if (feedAddr == address(0)) return a; // de-listed after deposit; unpriced

        (bool ok, uint256 price, uint8 priceDec, uint256 updatedAt) = _tryReadFeed(feedAddr);
        a.price = price;
        a.priceDecimals = priceDec;
        a.updatedAt = updatedAt;
        if (!ok) return a; // zero/negative answer or reverting feed: unpriced

        a.stale = (block.timestamp - updatedAt) > registry.staleAfter(asset);

        if (!trustPrices) return a; // sequencer down/grace: priced stays false

        a.priced = true;
        a.lockedValueUsd = _toUsd(a.lockedBalance, a.assetDecimals, price, priceDec);
        a.withdrawableValueUsd = _toUsd(a.withdrawableBalance, a.assetDecimals, price, priceDec);
    }

    /// @dev value_1e18 = balance * price * 1e18 / (10^assetDec * 10^priceDec)
    function _toUsd(uint256 balance, uint8 assetDec, uint256 price, uint8 priceDec)
        internal
        pure
        returns (uint256)
    {
        if (balance == 0 || price == 0) return 0;
        return (balance * price * WAD) / (10 ** assetDec * 10 ** priceDec);
    }

    function _sequencerState() internal view returns (SequencerStatus) {
        if (address(sequencerUptimeFeed) == address(0)) return SequencerStatus.Unknown;
        // A configured-but-broken feed must not brick valuation: treat a revert as
        // Down (conservative — prices not trusted) rather than throwing.
        try sequencerUptimeFeed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            if (answer != 0) return SequencerStatus.Down;
            if (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) return SequencerStatus.GracePeriod;
            return SequencerStatus.Up;
        } catch {
            return SequencerStatus.Down;
        }
    }

    function _tryReadFeed(address feedAddr)
        internal
        view
        returns (bool ok, uint256 price, uint8 priceDec, uint256 updatedAt)
    {
        AggregatorV3Interface feed = AggregatorV3Interface(feedAddr);
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 ts, uint80) {
            updatedAt = ts;
            if (answer > 0) {
                price = uint256(answer);
                try feed.decimals() returns (uint8 d) {
                    priceDec = d;
                    ok = true;
                } catch {
                    ok = false;
                }
            }
        } catch {
            ok = false;
        }
    }

    function _tryDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    function _tryOraclePaused(address token) internal view returns (bool) {
        try IStockToken(token).oraclePaused() returns (bool paused) {
            return paused;
        } catch {
            return false;
        }
    }
}
