// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {ProjectTreasury} from "./ProjectTreasury.sol";

/// @title BackingLens
/// @notice Lens-style batched read aggregator. One call powers a whole backing
///         panel, so the rate-limited public RPC isn't hit dozens of times per
///         screen (docs/robinhood-chain-research.md §1).
///
/// @dev Encodes the non-negotiable valuation rules:
///
///   1. NEVER revert on a stale price. Robinhood equity feeds have no heartbeat
///      off-hours; they hold the last published price over weekends and holidays.
///      A reverting valuation is bricked two days out of every seven. Staleness is
///      returned as a flag, per asset, never thrown.
///
///   2. NEVER apply `uiMultiplier()` to the feed price. `latestRoundData()`
///      already returns the full multiplier-adjusted per-token price.
///
///   3. Read `decimals()` from each feed. Never hardcode.
///
///   4. Check the L2 sequencer uptime feed before trusting any price. During an
///      outage feeds go stale while contracts still respond. Rather than brick the
///      whole view, the sequencer state is surfaced as flags and, when down or in
///      the post-recovery grace window, every asset is marked unpriced so the UI
///      can say "prices unavailable" instead of showing wrong numbers.
///
///   5. Reject zero/negative answers — a genuine oracle fault, distinct from a
///      valid-but-resting off-hours price. Marked `priced = false`, not summed.
///
/// All USD values are returned in 1e18 fixed point.
contract BackingLens {
    /// @notice Chainlink L2 Sequencer Uptime Feed. `answer == 0` means up.
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    /// @notice Grace period after sequencer recovery during which prices are not
    ///         yet trusted.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    uint256 private constant WAD = 1e18;

    struct AssetBacking {
        address asset;
        uint256 lockedBalance; // asset decimals
        uint256 withdrawableBalance; // asset decimals
        uint256 price; // feed decimals
        uint8 priceDecimals;
        uint8 assetDecimals;
        uint256 updatedAt;
        uint256 lockedValueUsd; // 1e18
        uint256 withdrawableValueUsd; // 1e18
        bool priced; // false => excluded from totals (fault / sequencer down)
        bool stale; // price age exceeded per-asset staleAfter (still valid)
        bool oraclePaused; // ERC-8056 advisory flag, if the token exposes it
    }

    struct Backing {
        bool sequencerUp;
        bool sequencerGraceActive;
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

    constructor(address sequencerUptimeFeed_) {
        require(sequencerUptimeFeed_ != address(0), "zero feed");
        sequencerUptimeFeed = AggregatorV3Interface(sequencerUptimeFeed_);
    }

    /// @notice Full backing breakdown for a treasury in a single call.
    function backingOf(address treasuryAddr) external view returns (Backing memory b) {
        ProjectTreasury treasury = ProjectTreasury(treasuryAddr);
        IAssetRegistry registry = treasury.registry();
        address projectToken = treasury.projectToken();

        (bool seqUp, bool graceActive) = _sequencerState();
        b.sequencerUp = seqUp;
        b.sequencerGraceActive = graceActive;
        b.totalSupply = IERC20Metadata(projectToken).totalSupply();

        bool trustPrices = seqUp && !graceActive;

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

    /// @notice Spec §5 `priceOf`: returns price + age + staleness, never reverts on
    ///         a resting off-hours price. Reverts only on a genuinely invalid
    ///         (zero/negative) answer.
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

        address feedAddr = registry.feedOf(asset);
        if (feedAddr == address(0)) {
            // Asset was de-listed after deposit; balances still shown, unpriced.
            return a;
        }

        (bool ok, uint256 price, uint8 priceDec, uint256 updatedAt) = _tryReadFeed(feedAddr);
        a.price = price;
        a.priceDecimals = priceDec;
        a.updatedAt = updatedAt;

        if (!ok) {
            // Zero/negative answer or a reverting feed: fault, not summed.
            return a;
        }

        // Staleness is informational — the price is still used. NEVER dropped just
        // for being off-hours; that is the whole point.
        a.stale = (block.timestamp - updatedAt) > registry.staleAfter(asset);

        // Only exclude from totals if the sequencer is untrusted.
        if (!trustPrices) {
            return a; // priced stays false
        }

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

    function _sequencerState() internal view returns (bool up, bool graceActive) {
        (, int256 status, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
        up = (status == 0);
        // After recovery, `startedAt` resets; wait out the grace window.
        graceActive = up && (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD);
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
