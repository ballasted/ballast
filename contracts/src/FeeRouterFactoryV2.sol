// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FeeRouterV2} from "./FeeRouterV2.sol";

/// @title FeeRouterFactoryV2 — deploys one FeeRouterV2 per token, with the creator's
///        chosen split ACTIVE from block one and an optional family parent
///
/// @notice Same stateless, ownerless deployer as v1 (no registry; every router is
///         discoverable from the Launched/FeeRouterCreated events). Differences from
///         v1: createAndLaunch takes (a) the initial 5-bucket split, set in the
///         FeeRouterV2 constructor so a non-default split is live from the launch tx —
///         no 7-day wait for the first split — and (b) an optional `parent` token for
///         the parentBurn bucket. Brand-new; does NOT touch the deployed v1
///         FeeRouterFactory, existing routers, or any live contract.
contract FeeRouterFactoryV2 {
    event FeeRouterCreated(address indexed router, address indexed realCreator);

    /// @notice The one BasketZap every FeeRouterV2 this factory deploys is wired to
    ///         (for runBasket). Fixed at construction — no owner, no setter.
    address public immutable basketZap;

    constructor(address basketZap_) {
        basketZap = basketZap_;
    }

    /// @notice Deploy a FeeRouterV2 and immediately launch a token through it, so the
    ///         router is the on-chain creator. The initial split (creator/treasury/
    ///         buyback/parentBurn/staking bps) is validated and set in the constructor
    ///         — ACTIVE from this very tx. `parent` is the optional family parent for
    ///         the parentBurn bucket (address(0) for a standalone launch).
    ///         `msg.sender` becomes `realCreator`.
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
        address[] calldata quoteAssets_,
        address parent,
        uint16 initialCreatorBps,
        uint16 initialTreasuryBps,
        uint16 initialBuybackBps,
        uint16 initialParentBurnBps,
        uint16 initialRewardsBps
    ) external returns (FeeRouterV2 router, address token, address treasury) {
        router = new FeeRouterV2(
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
            disclosureVersion,
            basketZap,
            parent,
            initialCreatorBps,
            initialTreasuryBps,
            initialBuybackBps,
            initialParentBurnBps,
            initialRewardsBps
        );
        emit FeeRouterCreated(address(router), msg.sender);
        (token, treasury) = router.launchNew(name_, symbol_, noticePeriod, metadataURI, quoteAssets_);
    }

    /// @notice Deploy a bare FeeRouterV2 for the adopt() path (existing EOA-creator
    ///         token). The initial split is forced to 100% creator and no parent here
    ///         — the adopt path never makes the router the on-chain creator, so a
    ///         custom launch split or family parent has no meaning; the creator uses
    ///         scheduleSplit afterwards.
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
    ) external returns (FeeRouterV2 router) {
        router = new FeeRouterV2(
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
            disclosureVersion,
            basketZap,
            address(0), // no family parent on the adopt path
            10000,
            0,
            0,
            0,
            0
        );
        emit FeeRouterCreated(address(router), realCreator);
    }
}
