// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FeeRouter} from "./FeeRouter.sol";

/// @title FeeRouterFactory — deploys one FeeRouter per token, optionally in the same
///        transaction as launching that token
///
/// @notice Stateless deployer, no owner, no registry of its own (every FeeRouter is
///         independently discoverable from the Launched/Wired events it and the
///         underlying BallastFactory emit). Exists only so a creator who wants the
///         router to BE the on-chain creator of record (§2.1 of the design doc) can
///         do "deploy router + launch token" in one wallet transaction instead of two.
contract FeeRouterFactory {
    event FeeRouterCreated(address indexed router, address indexed realCreator);

    /// @notice Deploy a FeeRouter and immediately launch a new token through it, so
    ///         the router becomes that token's on-chain creator (full four-bucket
    ///         support, including the treasury bucket). `msg.sender` becomes
    ///         `realCreator` — the only address that can ever schedule this router's
    ///         split or use its creator/treasury passthroughs.
    function createAndLaunch(
        address hook,
        address weth,
        address poolManager,
        address treasuryAsset,
        PoolKey calldata treasuryPoolKey,
        address registry,
        uint16 maxSlippageBps,
        uint256 maxRoutePerCall,
        uint256 routeCooldown,
        bytes32 disclosureVersion,
        address factory,
        string calldata name_,
        string calldata symbol_,
        uint256 noticePeriod,
        string calldata metadataURI,
        address[] calldata quoteAssets_
    ) external returns (FeeRouter router, address token, address treasury) {
        router = new FeeRouter(
            msg.sender,
            factory,
            hook,
            weth,
            poolManager,
            treasuryAsset,
            treasuryPoolKey,
            registry,
            maxSlippageBps,
            maxRoutePerCall,
            routeCooldown,
            disclosureVersion
        );
        emit FeeRouterCreated(address(router), msg.sender);
        (token, treasury) = router.launchNew(name_, symbol_, noticePeriod, metadataURI, quoteAssets_);
    }

    /// @notice Deploy a bare FeeRouter for a creator who will call `adopt()`
    ///         themselves on an existing token (§1.4 — bucket-splitter-only path,
    ///         no treasury bucket, no on-chain-creator change).
    function createForExisting(
        address realCreator,
        address hook,
        address weth,
        address poolManager,
        address treasuryAsset,
        PoolKey calldata treasuryPoolKey,
        address registry,
        uint16 maxSlippageBps,
        uint256 maxRoutePerCall,
        uint256 routeCooldown,
        bytes32 disclosureVersion,
        address factory
    ) external returns (FeeRouter router) {
        router = new FeeRouter(
            realCreator,
            factory,
            hook,
            weth,
            poolManager,
            treasuryAsset,
            treasuryPoolKey,
            registry,
            maxSlippageBps,
            maxRoutePerCall,
            routeCooldown,
            disclosureVersion
        );
        emit FeeRouterCreated(address(router), realCreator);
    }
}
