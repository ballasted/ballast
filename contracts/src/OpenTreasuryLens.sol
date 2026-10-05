// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {BackingLens} from "./BackingLens.sol";
import {OpenTreasuryVault} from "./OpenTreasuryVault.sol";
import {OpenTreasuryVaultFactory} from "./OpenTreasuryVaultFactory.sol";

interface IBallastTokenTreasury {
    function treasury() external view returns (address);
}

/// @title OpenTreasuryLens — batched read combining the existing (unmodified)
///        BackingLens with OpenTreasuryVault's community-deposit state
///
/// @notice Never calls or modifies BackingLens/AssetRegistry/ProjectTreasury —
///         pure composition, read-only. Rule 18: the three figures this returns
///         (creator-funded, community-withdrawable, combined) must be rendered as
///         three SEPARATE labelled figures, never merged into BackingLens's own
///         `backingPerToken`. See docs/OPEN_TREASURY_DESIGN.md §8.
///
/// @dev Pricing here follows BackingLens's OWN "never revert on a stale/missing
///      price" display convention (NOT OpenTreasuryVault.deposit's revert-closed
///      convention) — this is a read, not a state-changing mint of weight, so the
///      same reasoning as BackingLens applies unchanged. The small per-asset
///      feed-reading helpers below duplicate BackingLens's internal logic rather
///      than import it, because BackingLens's helpers are `internal` and
///      BackingLens itself must not be modified to expose them.
contract OpenTreasuryLens {
    uint256 private constant WAD = 1e18;

    BackingLens public immutable backingLens;

    struct CommunityAssetView {
        address asset;
        uint256 balance; // asset decimals
        uint256 price; // feed decimals
        uint8 priceDecimals;
        uint8 assetDecimals;
        uint256 updatedAt;
        uint256 valueUsd; // 1e18
        bool priced;
        bool stale;
    }

    struct CombinedBacking {
        address token;
        address treasury;
        address vault; // address(0) if no vault has been created for this token yet
        uint256 creatorFundedUsd; // == BackingLens.backingOf(treasury).totalValueUsd, passthrough
        bool creatorFundedOk; // false if the BackingLens call itself reverted
        bool creatorFundedAnyStale;
        uint256 communityWithdrawableUsd;
        bool communityAnyStale;
        bool communityAnyUnpriced;
        uint256 combinedTotalUsd; // informational only — never a backing-per-token denominator
        CommunityAssetView[] communityAssets;
    }

    constructor(address backingLens_) {
        backingLens = BackingLens(backingLens_);
    }

    /// @notice Full combined-backing breakdown for one token in a single call.
    function combinedBackingOf(address token, address vaultFactory) external view returns (CombinedBacking memory c) {
        c.token = token;
        address treasury = IBallastTokenTreasury(token).treasury();
        c.treasury = treasury;

        try backingLens.backingOf(treasury) returns (BackingLens.Backing memory b) {
            c.creatorFundedOk = true;
            c.creatorFundedUsd = b.totalValueUsd;
            c.creatorFundedAnyStale = b.anyStale;
        } catch {
            c.creatorFundedOk = false;
        }

        address vault = OpenTreasuryVaultFactory(vaultFactory).vaultOf(token);
        c.vault = vault;
        if (vault != address(0)) {
            OpenTreasuryVault v = OpenTreasuryVault(vault);
            address registry = v.registry();
            address[] memory assetList = v.assets();
            c.communityAssets = new CommunityAssetView[](assetList.length);
            for (uint256 i = 0; i < assetList.length; i++) {
                CommunityAssetView memory a = _valueAsset(registry, v, assetList[i]);
                c.communityAssets[i] = a;
                c.communityWithdrawableUsd += a.valueUsd;
                if (a.stale) c.communityAnyStale = true;
                if (!a.priced) c.communityAnyUnpriced = true;
            }
        }

        c.combinedTotalUsd = c.creatorFundedUsd + c.communityWithdrawableUsd;
    }

    // --------------------------------------------------------------------- //
    //  Internal — mirrors BackingLens._valueAsset exactly, duplicated        //
    //  because BackingLens's helpers are internal and BackingLens must not   //
    //  be modified (CLAUDE.md hard rule).                                   //
    // --------------------------------------------------------------------- //

    function _valueAsset(address registry, OpenTreasuryVault vault, address asset)
        internal
        view
        returns (CommunityAssetView memory a)
    {
        a.asset = asset;
        a.balance = vault.totalPrincipal(asset);
        a.assetDecimals = _tryDecimals(asset);

        address feedAddr = IAssetRegistry(registry).feedOf(asset);
        if (feedAddr == address(0)) return a; // delisted since deposit — unpriced, never reverts

        (bool ok, uint256 price, uint8 priceDec, uint256 updatedAt) = _tryReadFeed(feedAddr);
        a.price = price;
        a.priceDecimals = priceDec;
        a.updatedAt = updatedAt;
        if (!ok) return a;

        a.stale = (block.timestamp - updatedAt) > IAssetRegistry(registry).staleAfter(asset);
        a.priced = true;
        a.valueUsd = _toUsd(a.balance, a.assetDecimals, price, priceDec);
    }

    function _toUsd(uint256 balance, uint8 assetDec, uint256 price, uint8 priceDec) internal pure returns (uint256) {
        if (balance == 0 || price == 0) return 0;
        return (balance * price * WAD) / (10 ** assetDec * 10 ** priceDec);
    }

    function _tryReadFeed(address feedAddr) internal view returns (bool ok, uint256 price, uint8 priceDec, uint256 updatedAt) {
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

    function _tryDecimals(address asset) internal view returns (uint8) {
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }
}
