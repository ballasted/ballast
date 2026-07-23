// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {IAssetRegistry, MarketHours} from "./interfaces/IAssetRegistry.sol";

/// @title AssetRegistry
/// @notice Global, conservatively managed allowlist of assets that may back a
///         BALLAST project treasury. One registry serves every treasury.
/// @dev Only assets with an official Chainlink feed on this chain should be
///      allowed. Allowlisting is by canonical contract address, never by ticker
///      or name — a token with a matching ticker but a different address is an
///      impostor and a single fake asset discredits every backing figure on the
///      platform (docs/robinhood-chain-research.md §2).
///
///      This registry deliberately holds NO funds and takes NO fee. It only
///      answers "is this asset acceptable, and how do we price it".
contract AssetRegistry is Ownable2Step, IAssetRegistry {
    struct Asset {
        bool allowed;
        address feed; // Chainlink AggregatorV3Interface proxy (STANDARD, never SVR)
        uint256 staleAfter; // seconds; absolute outer bound, per-asset
        uint256 minDeposit; // in asset decimals
        MarketHours marketHours; // drives off-chain RESTING-vs-STALE classification
    }

    mapping(address asset => Asset) private _assets;
    address[] private _allowedList;
    mapping(address asset => uint256 indexPlusOne) private _listIndex;

    event AssetAllowed(address indexed asset, address indexed feed, uint256 staleAfter, uint256 minDeposit);
    event AssetUpdated(address indexed asset, address indexed feed, uint256 staleAfter, uint256 minDeposit);
    event AssetRemoved(address indexed asset);

    error ZeroAddress();
    error NotAllowed(address asset);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Add or update an asset (market-hours class defaults to Unknown).
    function setAsset(address asset, address feed, uint256 staleAfter_, uint256 minDeposit_) external onlyOwner {
        _setAsset(asset, feed, staleAfter_, minDeposit_, MarketHours.Unknown);
    }

    /// @notice Add or update an asset with its market-hours class. Requires a feed
    ///         (the STANDARD proxy) and a positive staleness bound so no allowed
    ///         asset can ever be unpriceable.
    function setAsset(
        address asset,
        address feed,
        uint256 staleAfter_,
        uint256 minDeposit_,
        MarketHours marketHours_
    ) external onlyOwner {
        _setAsset(asset, feed, staleAfter_, minDeposit_, marketHours_);
    }

    function _setAsset(
        address asset,
        address feed,
        uint256 staleAfter_,
        uint256 minDeposit_,
        MarketHours marketHours_
    ) internal {
        if (asset == address(0) || feed == address(0)) revert ZeroAddress();
        require(staleAfter_ > 0, "staleAfter=0");
        require(minDeposit_ > 0, "minDeposit=0");

        bool isNew = !_assets[asset].allowed;
        _assets[asset] = Asset({
            allowed: true,
            feed: feed,
            staleAfter: staleAfter_,
            minDeposit: minDeposit_,
            marketHours: marketHours_
        });

        if (isNew) {
            _allowedList.push(asset);
            _listIndex[asset] = _allowedList.length; // index + 1
            emit AssetAllowed(asset, feed, staleAfter_, minDeposit_);
        } else {
            emit AssetUpdated(asset, feed, staleAfter_, minDeposit_);
        }
    }

    /// @notice Remove an asset from the allowlist. Does not affect assets already
    ///         held by any treasury — deposits are validated at deposit time only.
    function removeAsset(address asset) external onlyOwner {
        if (!_assets[asset].allowed) revert NotAllowed(asset);

        uint256 idx = _listIndex[asset]; // 1-based
        uint256 last = _allowedList.length;
        if (idx != last) {
            address moved = _allowedList[last - 1];
            _allowedList[idx - 1] = moved;
            _listIndex[moved] = idx;
        }
        _allowedList.pop();
        delete _listIndex[asset];
        delete _assets[asset];

        emit AssetRemoved(asset);
    }

    /// @inheritdoc IAssetRegistry
    function isAllowed(address asset) external view returns (bool) {
        return _assets[asset].allowed;
    }

    /// @inheritdoc IAssetRegistry
    function minDeposit(address asset) external view returns (uint256) {
        return _assets[asset].minDeposit;
    }

    /// @inheritdoc IAssetRegistry
    function feedOf(address asset) external view returns (address) {
        return _assets[asset].feed;
    }

    /// @inheritdoc IAssetRegistry
    function staleAfter(address asset) external view returns (uint256) {
        return _assets[asset].staleAfter;
    }

    /// @inheritdoc IAssetRegistry
    function marketHoursOf(address asset) external view returns (MarketHours) {
        return _assets[asset].marketHours;
    }

    /// @notice Full config for an asset in one read.
    function assetConfig(address asset)
        external
        view
        returns (bool allowed, address feed, uint256 staleAfter_, uint256 minDeposit_, MarketHours marketHours_)
    {
        Asset storage a = _assets[asset];
        return (a.allowed, a.feed, a.staleAfter, a.minDeposit, a.marketHours);
    }

    /// @notice Enumerate the allowlist (for the Create asset picker via the Lens).
    function allowedAssets() external view returns (address[] memory) {
        return _allowedList;
    }

    function allowedCount() external view returns (uint256) {
        return _allowedList.length;
    }
}
