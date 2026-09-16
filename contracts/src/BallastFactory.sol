// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BallastToken} from "./BallastToken.sol";
import {ProjectTreasury} from "./ProjectTreasury.sol";
import {BallastSeeder} from "./BallastSeeder.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BackingMath} from "./libraries/BackingMath.sol";

/// @title BallastFactory
/// @notice Launch entry point + registry. Atomically deploys a project token and
///         its ProjectTreasury and wires them so the treasury pointer is permanent
///         and self-backing is impossible.
///
/// @dev PHASE 1 (this file): token + treasury deploy/wire/register only. The
///      bonding curve, graduation into the Uniswap v4 token/WETH pool, LP lock, and
///      the CREATE2-mined fee hook are deliberately NOT here yet — they are the
///      next phase and are being designed against the treasury-linked curve math
///      (docs/BALLAST-build-spec.md / research §5). For now the full fixed supply
///      is minted to the factory; distribution to the curve/pool comes with that
///      phase. No per-launch address is hardcoded anywhere — callers resolve
///      token/treasury from the launch registry or the Launched event.
contract BallastFactory {
    /// @notice Fixed supply for every launch: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Global asset allowlist every launched treasury reads from.
    address public immutable registry;

    /// @notice WETH — still the only supported quoteAsset_ (QuoteAssetNotSupportedYet
    ///         otherwise) and the ETH/USD-feed identity used by _quotePrice. No
    ///         longer an address the token is mined against — see the ordering
    ///         note on OrderingLib below.
    address public immutable weth;

    /// @notice One-sided liquidity seeder (shared singleton).
    BallastSeeder public immutable seeder;

    /// @notice Chainlink ETH/USD feed — converts USD backing to the pool's WETH/token P0.
    address public immutable ethUsdFeed;

    /// @notice Absolute outer freshness bound for the ETH/USD leg at graduation, in
    ///         seconds. This is a COARSE on-chain backstop — its only job is to stop a
    ///         backed launch pricing P0 against a truly dead feed permanently. The
    ///         fine RESTING-vs-STALE, market-hours-aware gate lives off-chain
    ///         (web/lib/marketHours.ts + the create flow); it must never live here,
    ///         because an on-chain calendar that reverts would brick launches exactly
    ///         the way a reverting stale-check bricks valuation (CLAUDE.md rule 6).
    ///         Treasury feeds take their per-asset bound from AssetRegistry.staleAfter;
    ///         ETH/USD isn't in the registry, so it gets this immutable arg. 24h given
    ///         observed gaps up to ~2.8h on this chain.
    uint256 public immutable ethUsdStaleWindow;

    int24 public constant TICK_SPACING = 60;
    /// @notice Constant opening tick for UNBACKED launches (no oracle dependency).
    ///         ~1e-9 WETH/token; tunable product parameter. Multiple of TICK_SPACING.
    int24 public constant UNBACKED_TICK = -207240;

    mapping(address token => bool) public graduated;

    struct Launch {
        address token;
        address treasury;
        address creator;
        /// @notice The asset this launch's pool is (or will be) paired against.
        ///         Restricted to `weth` for now — see QuoteAssetNotSupportedYet.
        ///         Appended last so existing tuple-destructuring readers of
        ///         `launches(id)` (web/lib/abis.ts callers reading only the first
        ///         three fields) keep working unchanged.
        address quoteAsset;
    }

    Launch[] public launches;
    /// @notice token => id+1 (0 means unknown).
    mapping(address token => uint256 idPlusOne) public launchIdOf;

    event Launched(
        uint256 indexed id,
        address indexed creator,
        address indexed token,
        address treasury,
        uint256 noticePeriod,
        string metadataURI
    );

    event Graduated(address indexed token, address treasury, int24 tickLower, uint256 backingUsd1e18);

    error BadNoticePeriod();
    error ZeroAddress();
    error NotLaunchToken();
    error AlreadyGraduated();
    /// @notice A backed launch's feed was stale beyond its outer bound at graduation
    ///         (treasury asset: past AssetRegistry.staleAfter; the quote asset
    ///         itself, WETH or otherwise: past ethUsdStaleWindow for WETH, or its
    ///         own AssetRegistry.staleAfter for anything else), so P0 would be set
    ///         from a dead price permanently. This is the coarse backstop — the
    ///         off-chain create flow additionally gates on market hours, so in
    ///         practice this only trips on a genuinely broken feed, not on an
    ///         expected weekend/holiday rest.
    error FeedStaleAtLaunch(address asset);
    /// @notice quoteAsset_ must be `weth` for now. Pairing against USDC or a
    ///         stock/ETF asset needs the ordering helper + one-sided-liquidity
    ///         support that BallastSeeder/BallastHook don't have yet (queued as
    ///         separate work) — accepting the choice here before those land would
    ///         let a launch claim a pairing that graduation can't actually honor.
    error QuoteAssetNotSupportedYet();

    constructor(
        address registry_,
        address weth_,
        BallastSeeder seeder_,
        address ethUsdFeed_,
        uint256 ethUsdStaleWindow_
    ) {
        if (registry_ == address(0) || weth_ == address(0) || address(seeder_) == address(0) || ethUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        if (ethUsdStaleWindow_ == 0) revert ZeroAddress();
        registry = registry_;
        weth = weth_;
        seeder = seeder_;
        ethUsdFeed = ethUsdFeed_;
        ethUsdStaleWindow = ethUsdStaleWindow_;
    }

    /// @notice Seed the token/WETH pool at P0 and lock LP. Backed launches derive P0
    ///         from live backing (each treasury feed must be within its own outer
    ///         staleness bound — see FeedStaleAtLaunch); unbacked launches use a
    ///         constant P0.
    function graduate(address token) external {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        if (graduated[token]) revert AlreadyGraduated();
        graduated[token] = true;

        Launch memory l = launches[idPlus1 - 1];
        (int24 tickLower, uint256 backingUsd) = _p0Tick(l.treasury, l.quoteAsset);

        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(address(seeder), supply);
        seeder.seed(token, tickLower);

        emit Graduated(token, l.treasury, tickLower, backingUsd);
    }

    /// @dev The quote asset's own USD price + decimals, for P0 conversion. WETH
    ///      isn't in AssetRegistry (it's not a treasury asset), so it keeps using
    ///      the immutable ethUsdFeed/ethUsdStaleWindow exactly as before; any other
    ///      quote asset resolves through AssetRegistry — the SAME feed + staleAfter
    ///      already trusted for treasury valuation of that asset. Reverts (never
    ///      returns a price from a dead feed) if the quote asset's feed is stale
    ///      beyond its outer bound — a stale price at seed time would set a wrong
    ///      opening price PERMANENTLY, and that's unrecoverable.
    function _quotePrice(address quoteAsset) internal view returns (uint256 price1e18, uint8 decimals) {
        if (quoteAsset == weth) {
            (, int256 e,, uint256 eUpd,) = AggregatorV3Interface(ethUsdFeed).latestRoundData();
            require(e > 0, "invalid quote price");
            if (block.timestamp - eUpd > ethUsdStaleWindow) revert FeedStaleAtLaunch(quoteAsset);
            price1e18 = FullMath.mulDiv(uint256(e), 1e18, 10 ** AggregatorV3Interface(ethUsdFeed).decimals());
            decimals = 18;
            return (price1e18, decimals);
        }
        address feed = IAssetRegistry(registry).feedOf(quoteAsset);
        (, int256 ans,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        require(ans > 0, "invalid quote price");
        if (block.timestamp - updatedAt > IAssetRegistry(registry).staleAfter(quoteAsset)) {
            revert FeedStaleAtLaunch(quoteAsset);
        }
        price1e18 = FullMath.mulDiv(uint256(ans), 1e18, 10 ** AggregatorV3Interface(feed).decimals());
        decimals = IERC20Metadata(quoteAsset).decimals();
    }

    /// @dev P0 tick + backing USD. Reverts if any held treasury feed, or the quote
    ///      asset's own feed, is stale beyond its outer bound (see _quotePrice).
    ///      Age is NOT a proxy for inaccuracy on a deviation-threshold feed — a
    ///      quiet-but-recent SGOV price is correct — so this bound is the asset's
    ///      real cadence (e.g. 120h SGOV / 96h equities), not a blunt trading-hours
    ///      window.
    function _p0Tick(address treasury, address quoteAsset)
        internal
        view
        returns (int24 tickLower, uint256 backingUsd1e18)
    {
        address[] memory assets = ProjectTreasury(treasury).assets();
        bool backed;
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 held = ProjectTreasury(treasury).heldBalance(assets[i]);
            if (held == 0) continue;
            backed = true;
            address feed = IAssetRegistry(registry).feedOf(assets[i]);
            (, int256 ans,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
            require(ans > 0, "invalid price");
            if (block.timestamp - updatedAt > IAssetRegistry(registry).staleAfter(assets[i])) {
                revert FeedStaleAtLaunch(assets[i]);
            }
            uint256 usd = FullMath.mulDiv(held, uint256(ans), 10 ** AggregatorV3Interface(feed).decimals());
            backingUsd1e18 += FullMath.mulDiv(usd, 1e18, 10 ** IERC20Metadata(assets[i]).decimals());
        }
        if (!backed) return (UNBACKED_TICK, 0);

        (uint256 quotePrice1e18, uint8 quoteDecimals) = _quotePrice(quoteAsset);
        // Permanent-effect P0 math, isolated + fuzzed in BackingMath.
        tickLower = BackingMath.p0Tick(backingUsd1e18, TOTAL_SUPPLY, quotePrice1e18, quoteDecimals, TICK_SPACING);
    }

    /// @notice Launch a project: deploy the token + treasury, wire them, register.
    /// @param noticePeriod Withdrawal notice, restricted to the offered set
    ///        (7 / 30 / 90 days) and immutable on the treasury once set.
    /// @param metadataURI ipfs://CID of the pinned project metadata JSON (name,
    ///        description, category, logo, website, x). Stored on the token as the
    ///        permanent launch identity + the initial (updatable) current URI.
    /// @param quoteAsset_ The asset this launch's pool will be paired against at
    ///        graduation. Must be `weth` for now (see QuoteAssetNotSupportedYet) —
    ///        exposed as a real parameter already, rather than added later, so this
    ///        function's signature doesn't need to change again once USDC/stock
    ///        quote assets are actually supported.
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint256 noticePeriod,
        string calldata metadataURI,
        address quoteAsset_
    ) external returns (uint256 id, address token, address treasury) {
        if (!(noticePeriod == 7 days || noticePeriod == 30 days || noticePeriod == 90 days)) {
            revert BadNoticePeriod();
        }
        if (quoteAsset_ != weth) revert QuoteAssetNotSupportedYet();

        // 1. Token — plain CREATE, no mining. Its address relative to weth is now
        //    unconstrained (could sort either side) — see OrderingLib and the
        //    ordering note on graduate()/BallastSeeder: the seeder only supports
        //    token-as-currency0 pools today, so a token whose nonce-based address
        //    happens to sort above its quote asset can launch fine (nothing here
        //    depends on ordering) but will revert at graduate() until the seeder's
        //    mirrored one-sided-liquidity math ships (queued as separate work).
        //    Full supply minted to the factory for one-sided pool seeding.
        BallastToken t = new BallastToken(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this), metadataURI);

        // 2. Treasury — projectToken is immutable here, so self-backing is impossible.
        ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);

        // 3. Wire the token -> treasury pointer, permanently (write-once).
        t.initTreasury(address(tr));

        // 4. Register.
        token = address(t);
        treasury = address(tr);
        launches.push(Launch({token: token, treasury: treasury, creator: msg.sender, quoteAsset: quoteAsset_}));
        id = launches.length - 1;
        launchIdOf[token] = id + 1;

        emit Launched(id, msg.sender, token, treasury, noticePeriod, metadataURI);
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }
}
