// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BallastToken} from "../BallastToken.sol";
import {OrderingLib} from "../libraries/OrderingLib.sol";
import {FeeRouterV5} from "./FeeRouterV5.sol";
import {BallastSeederV5} from "./BallastSeederV5.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

/// @title BallastFactoryV5 — gen-5 launch entry point + registry (Elysium)
///
/// @notice Launches a project token on Elysium with gen-5 mechanics:
///         - a CREATOR-PICKED swap fee (1%–10%), fixed at launch, stored once on the
///           hook at graduation and never changeable;
///         - a per-token FeeRouterV5 that is the token's on-chain creator (so the
///           hook's 80% creator-side accrues to it), running the v2 split rules;
///         - 100% of supply seeded into ONE WHYPE pool at a fixed opening valuation
///           (the per-chain `openingTickWhype`), LP locked permanently;
///         - NO treasury on Elysium (treasuryEnabled=false — no price feeds exist).
///
///         Opening valuation is a CONSTRUCTOR parameter per chain (`openingTickWhype`),
///         defined in token-as-currency0 terms and negated automatically when the
///         token sorts as currency1 — exactly gen-4's UNBACKED_TICK convention.
///
/// @dev Mirrors the gen-4 BallastFactory launch/graduate lifecycle but is a wholly new
///      contract: nothing here touches gen-1..4 core on Robinhood Chain. Single quote
///      asset per launch for now (WHYPE); multi-quote returns when feeds + real stock
///      tokens exist on Elysium.
contract BallastFactoryV5 is Ownable2Step {
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 60;

    address public immutable hook;
    BallastSeederV5 public immutable seeder;
    address public immutable whype;
    address public immutable poolManager;

    /// @notice Opening tick for a WHYPE pool (token=currency0 convention), spacing-
    ///         aligned. Encodes this chain's opening fully-diluted valuation in HYPE.
    int24 public immutable openingTickWhype;

    uint16 public immutable minFeeBps;
    uint16 public immutable maxFeeBps;

    /// @notice FeeRouterV5 construction params (shared across every launch).
    uint16 public immutable routerMaxSlippageBps;
    uint256 public immutable routerMaxRoutePerCall;
    uint256 public immutable routerRouteCooldown;

    /// @notice Treasury is OFF on Elysium (no feeds). Kept as a flag so the SAME
    ///         factory code can enable it on a chain that has feeds later.
    bool public immutable treasuryEnabled;

    /// @notice Only WHYPE is an accepted quote asset until feeds + real stock tokens
    ///         exist. Set at deploy, not owner-mutable.
    mapping(address => bool) public isGreenQuoteAsset;

    struct Launch {
        address token;
        address feeRouter;
        address creator;
        address quoteAsset;
        uint16 swapFeeBps;
    }

    Launch[] public launches;
    mapping(address token => uint256 idPlusOne) public launchIdOf;
    mapping(address token => bool) public graduated;

    event Launched(
        uint256 indexed id,
        address indexed creator,
        address indexed token,
        address feeRouter,
        address quoteAsset,
        uint16 swapFeeBps,
        string metadataURI
    );
    event Graduated(address indexed token, address quoteAsset, bytes32 poolId, int24 openTick, uint256 amount);

    error ZeroAddress();
    error FeeOutOfRange();
    error QuoteAssetNotSupported();
    error NotLaunchToken();
    error AlreadyGraduated();
    error TreasuryNotSupportedOnThisChain();
    error BadSplit();

    constructor(
        address hook_,
        BallastSeederV5 seeder_,
        address whype_,
        address poolManager_,
        int24 openingTickWhype_,
        uint16 minFeeBps_,
        uint16 maxFeeBps_,
        bool treasuryEnabled_,
        uint16 routerMaxSlippageBps_,
        uint256 routerMaxRoutePerCall_,
        uint256 routerRouteCooldown_,
        address owner_
    ) Ownable(owner_) {
        if (hook_ == address(0) || address(seeder_) == address(0) || whype_ == address(0) || poolManager_ == address(0)) {
            revert ZeroAddress();
        }
        if (minFeeBps_ == 0 || minFeeBps_ > maxFeeBps_ || maxFeeBps_ >= 10_000) revert FeeOutOfRange();
        if (openingTickWhype_ % TICK_SPACING != 0) revert FeeOutOfRange();
        if (treasuryEnabled_) revert TreasuryNotSupportedOnThisChain(); // Elysium: must be false
        hook = hook_;
        seeder = seeder_;
        whype = whype_;
        poolManager = poolManager_;
        openingTickWhype = openingTickWhype_;
        minFeeBps = minFeeBps_;
        maxFeeBps = maxFeeBps_;
        treasuryEnabled = treasuryEnabled_;
        routerMaxSlippageBps = routerMaxSlippageBps_;
        routerMaxRoutePerCall = routerMaxRoutePerCall_;
        routerRouteCooldown = routerRouteCooldown_;
        isGreenQuoteAsset[whype_] = true;
    }

    /// @notice Launch a gen-5 project.
    /// @param swapFeeBps creator-picked swap fee, 1%–10% (minFeeBps..maxFeeBps). Fixed.
    /// @param quoteAsset the pool's quote asset (WHYPE on Elysium).
    /// @param initialCreatorBps/initialBuybackBps/initialRewardsBps the FeeRouterV5
    ///        launch split (must sum to 10000), active from block one.
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint16 swapFeeBps,
        string calldata metadataURI,
        address quoteAsset,
        uint16 initialCreatorBps,
        uint16 initialBuybackBps,
        uint16 initialRewardsBps
    ) external returns (uint256 id, address token, address feeRouter) {
        if (swapFeeBps < minFeeBps || swapFeeBps > maxFeeBps) revert FeeOutOfRange();
        if (!isGreenQuoteAsset[quoteAsset]) revert QuoteAssetNotSupported();
        if (uint256(initialCreatorBps) + initialBuybackBps + initialRewardsBps != 10_000) revert BadSplit();

        // 1. FeeRouterV5 first — it must be the token's on-chain creator.
        FeeRouterV5 router = new FeeRouterV5(
            msg.sender,
            address(this),
            hook,
            whype,
            poolManager,
            routerMaxSlippageBps,
            routerMaxRoutePerCall,
            routerRouteCooldown,
            initialCreatorBps,
            initialBuybackBps,
            initialRewardsBps
        );

        // 2. Token with creator = the router. Full supply minted to the factory for
        //    one-sided seeding at graduation.
        BallastToken t = new BallastToken(name_, symbol_, TOTAL_SUPPLY, address(router), address(this), metadataURI);

        // 3. Wire the router to the token (sets staking vault; verifies creator link).
        router.initToken(address(t));

        // 4. Register.
        token = address(t);
        feeRouter = address(router);
        launches.push(
            Launch({token: token, feeRouter: feeRouter, creator: msg.sender, quoteAsset: quoteAsset, swapFeeBps: swapFeeBps})
        );
        id = launches.length - 1;
        launchIdOf[token] = id + 1;

        emit Launched(id, msg.sender, token, feeRouter, quoteAsset, swapFeeBps, metadataURI);
    }

    /// @notice Seed the token's WHYPE pool with 100% of supply and lock LP. Opens at
    ///         the fixed per-chain valuation (openingTickWhype), negated if the token
    ///         sorts as currency1. Sets the pool's creator fee on the hook (via seeder).
    function graduate(address token) external {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        if (graduated[token]) revert AlreadyGraduated();
        graduated[token] = true;

        Launch storage l = launches[idPlus1 - 1];
        address quoteAsset = l.quoteAsset;

        int24 openTick =
            OrderingLib.tokenIsCurrency0(token, quoteAsset) ? openingTickWhype : -openingTickWhype;

        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(address(seeder), amount);
        PoolKey memory key = seeder.seed(token, quoteAsset, openTick, amount, l.swapFeeBps);

        emit Graduated(token, quoteAsset, PoolId.unwrap(key.toId()), openTick, amount);
    }

    /// @notice Owner knob reserved for when real stock tokens + price feeds exist on
    ///         Elysium. On testnet this stays unused — WHYPE is green from construction
    ///         regardless. Ownership transfers (Ownable2Step) to a Safe on mainnet.
    ///         NOTE: a non-WHYPE green asset also needs opening-price support in
    ///         graduate(); until that ships, keep this to WHYPE only.
    function setGreenQuoteAsset(address asset, bool green) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        isGreenQuoteAsset[asset] = green;
    }

    function quoteAssetOf(address token) external view returns (address) {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        return launches[idPlus1 - 1].quoteAsset;
    }

    function swapFeeBpsOf(address token) external view returns (uint16) {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        return launches[idPlus1 - 1].swapFeeBps;
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }
}
