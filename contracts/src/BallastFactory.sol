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
import {OrderingLib} from "./libraries/OrderingLib.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

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
    using PoolIdLibrary for PoolKey;

    /// @notice Fixed supply for every launch: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Upper bound on how many quote-asset pools one launch can request.
    ///         PERMANENT once this factory is deployed — a constant, not owner-
    ///         settable, same immutability class as ProjectTreasury.noticePeriod.
    ///         Deliberately 2, not 4: this is an economic parameter after all,
    ///         not just a gas ceiling — every additional quote asset is a FULL
    ///         extra pool carved out of the SAME fixed token supply (graduate()'s
    ///         even split), with no on-chain floor stopping a creator from
    ///         picking several and ending up with N thin books instead of one
    ///         usable one (see docs/GO_LIVE.md's "one launch, multiple quote
    ///         assets" section — this was a live footgun in the create flow at
    ///         MAX=4, not a hypothetical). At 2, the only choices are: one pool
    ///         (undiluted depth), or two (one liquid quote for reach + one
    ///         stock quote for the thesis, each at half depth, deliberately and
    ///         visibly, not four-way fragmentation with no warning.
    uint256 public constant MAX_QUOTE_ASSETS = 2;

    /// @notice Global asset allowlist every launched treasury reads from.
    address public immutable registry;

    /// @notice WETH — always a supported quoteAsset_, and the ETH/USD-feed identity
    ///         used by _quotePrice. No longer an address the token is mined
    ///         against — see the ordering note on OrderingLib below.
    address public immutable weth;

    /// @notice The ONLY other quoteAsset_ values launch() accepts, beyond weth.
    ///         Fixed at deploy from docs/exit-liquidity-table.md's GREEN
    ///         classification (external DEX liquidity deep enough that a holder
    ///         can actually exit to WETH without excessive slippage) — NOT
    ///         owner-settable, because promoting an asset here is re-running that
    ///         external liquidity judgment, not a quick admin toggle. Anything
    ///         AMBER/RED on that table (or added to AssetRegistry after this
    ///         deploy) stays rejected until the next factory deploy re-evaluates.
    mapping(address => bool) public isGreenQuoteAsset;

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
    /// @notice Constant opening tick for every WETH-quoted pool, backed or not
    ///         (see the "combination package" — every launch opens at exactly
    ///         1 ETH fully-diluted, independent of treasury size). ~1e-9
    ///         WETH/token for the 1B supply; multiple of TICK_SPACING.
    ///         Kept under its original name (rather than renamed to reflect
    ///         its now-universal role) to avoid an unrelated frontend rename —
    ///         see web/hooks/useOpeningFdv.ts, which already reads this getter
    ///         and already only ever meant "today's fixed opening tick."
    int24 public constant UNBACKED_TICK = -207240;

    mapping(address token => bool) public graduated;

    struct Launch {
        address token;
        address treasury;
        address creator;
        /// @notice The asset(s) this launch's pool(s) are (or will be) paired
        ///         against — 1 to MAX_QUOTE_ASSETS, each `weth` or GREEN (see
        ///         QuoteAssetNotSupportedYet). Solidity's auto-generated getter
        ///         for a public array-of-structs omits dynamic-array MEMBERS from
        ///         the returned tuple, so `launches(id)` still returns exactly
        ///         (token, treasury, creator) — existing tuple-destructuring
        ///         readers (web/lib/abis.ts) keep working unchanged. Use
        ///         `quoteAssetsOf(token)` for this field.
        address[] quoteAssets;
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

    /// @notice One per graduate() call — the treasury's USD backing at that
    ///         moment, quote-asset-independent (same for every pool this
    ///         graduation seeds; see PoolSeeded for the per-pool tick/amount).
    event Graduated(address indexed token, address treasury, uint256 backingUsd1e18);
    /// @notice Emitted once per quote asset a graduation seeds a pool for. v4 has
    ///         no canonical "all pools for this token" lookup (PoolManager is a
    ///         singleton keyed by the full PoolKey), so this event stream is how
    ///         the frontend/indexer enumerates a token's pools.
    event PoolSeeded(address indexed token, address indexed quoteAsset, bytes32 poolId, int24 openTick, uint256 amount);

    error BadNoticePeriod();
    error ZeroAddress();
    error NotLaunchToken();
    error AlreadyGraduated();
    /// @notice launch() was called with an empty quoteAssets_ array.
    error NoQuoteAssets();
    /// @notice launch() was called with more than MAX_QUOTE_ASSETS entries.
    error TooManyQuoteAssets();
    /// @notice The same quote asset appeared twice in one launch's quoteAssets_.
    error DuplicateQuoteAsset();
    /// @notice A STOCK-quoted pool's opening price depends on a feed that's
    ///         stale beyond its outer bound at graduation (the ETH/USD feed,
    ///         past ethUsdStaleWindow, or the quote asset's own feed, past its
    ///         AssetRegistry.staleAfter) — opening would set an immutable price
    ///         from a dead read permanently. WETH-quoted pools never trigger
    ///         this: their tick is a fixed constant with no feed dependency
    ///         (see UNBACKED_TICK). The treasury's OWN asset feeds never
    ///         trigger this either — the treasury no longer has any influence
    ///         on opening price (see _p0Tick), so a stale treasury feed only
    ///         affects the Graduated event's informational figure, which
    ///         degrades gracefully instead of reverting (see
    ///         _informationalBackingUsd). The off-chain create flow additionally
    ///         gates on market hours, so in practice this only trips on a
    ///         genuinely broken feed, not an expected weekend/holiday rest.
    error FeedStaleAtLaunch(address asset);
    /// @notice quoteAsset_ must be `weth` or one of the GREEN assets fixed at
    ///         deploy (isGreenQuoteAsset). Seeder and Hook both handle any
    ///         ordering/currency now, so this is purely an external-liquidity
    ///         gate, not a capability gap — see docs/exit-liquidity-table.md.
    error QuoteAssetNotSupportedYet();

    constructor(
        address registry_,
        address weth_,
        BallastSeeder seeder_,
        address ethUsdFeed_,
        uint256 ethUsdStaleWindow_,
        address[] memory greenQuoteAssets_
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
        for (uint256 i = 0; i < greenQuoteAssets_.length; i++) {
            if (greenQuoteAssets_[i] == address(0)) revert ZeroAddress();
            isGreenQuoteAsset[greenQuoteAssets_[i]] = true;
        }
    }

    /// @notice Seed one pool per this launch's quoteAssets and lock LP in each.
    ///         Every pool opens at the SAME fixed target: 1 ETH fully-diluted
    ///         valuation, converted through that pool's own quote-asset price
    ///         (see _p0Tick) — never the treasury's live backing, regardless of
    ///         deposit size. The full token supply splits EVENLY across the N
    ///         pools (remainder from integer division goes to the first pool,
    ///         so nothing is dust-lost) — a single atomic call, single
    ///         graduated[] flip: either every pool seeds or the whole call
    ///         reverts, no partial-graduation state to reason about.
    function graduate(address token) external {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        if (graduated[token]) revert AlreadyGraduated();
        graduated[token] = true;

        Launch storage l = launches[idPlus1 - 1];
        address treasury = l.treasury;
        uint256 n = l.quoteAssets.length;

        uint256 supply = IERC20(token).balanceOf(address(this));
        uint256 share = supply / n;
        // Informational only (see _informationalBackingUsd) — has zero effect
        // on any openTick/amount below. Computed once: it doesn't vary by
        // quote asset, unlike openTick.
        uint256 backingUsdForEvent = _informationalBackingUsd(treasury);

        for (uint256 i = 0; i < n; i++) {
            address quoteAsset = l.quoteAssets[i];
            int24 openTick = _p0Tick(token, quoteAsset);

            uint256 amount = i == 0 ? supply - share * (n - 1) : share;
            IERC20(token).transfer(address(seeder), amount);
            PoolKey memory key = seeder.seed(token, quoteAsset, openTick, amount);

            emit PoolSeeded(token, quoteAsset, PoolId.unwrap(key.toId()), openTick, amount);
        }

        emit Graduated(token, treasury, backingUsdForEvent);
    }

    /// @notice The quote assets this launch's pool(s) are/will be paired against.
    ///         Separate from `launches(id)`'s auto-generated getter, which omits
    ///         dynamic-array struct members (see the Launch struct's natspec).
    function quoteAssetsOf(address token) external view returns (address[] memory) {
        uint256 idPlus1 = launchIdOf[token];
        if (idPlus1 == 0) revert NotLaunchToken();
        return launches[idPlus1 - 1].quoteAssets;
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

    /// @dev Opening tick — ALWAYS exactly 1 ETH fully-diluted valuation, split
    ///      evenly across every pool this launch has (graduate()'s loop), never
    ///      the treasury's live backing. The treasury is not a parameter here on
    ///      purpose: there is no code path by which a deposit of any size can
    ///      reach this function, which is the literal enforcement of "the
    ///      treasury deposit must never influence opening price."
    ///
    ///      WETH-quoted pool: target FDV (1 ETH's USD value) divided by the
    ///      ETH/USD price is identically 1 for ANY ETH/USD price — the feed
    ///      cancels out algebraically. So this case reads no feed at all and
    ///      can never revert on staleness: it is exactly UNBACKED_TICK, always.
    ///      UNBACKED_TICK is defined in token-as-currency0 terms (real price =
    ///      raw tick directly); when the token sorts as currency1, the same
    ///      real price is the tick's exact negation (currency1/currency0 =
    ///      1/(currency0/currency1), exact for a reciprocal ratio) — still
    ///      tickSpacing-aligned since UNBACKED_TICK already is.
    ///
    ///      Stock-quoted pool: reverts (FeedStaleAtLaunch) if the ETH/USD feed
    ///      or the quote asset's own feed is stale beyond its outer bound —
    ///      this is the one case where a feed genuinely sets an immutable
    ///      price, so refusing to open on a dead feed is correct here (unlike
    ///      a passive valuation read, which must never revert — rule 6 is about
    ///      reads, not a one-time price-setting action).
    function _p0Tick(address token, address quoteAsset) internal view returns (int24 openTick) {
        bool tokenIsCurrency0 = OrderingLib.tokenIsCurrency0(token, quoteAsset);
        if (quoteAsset == weth) {
            return tokenIsCurrency0 ? UNBACKED_TICK : -UNBACKED_TICK;
        }

        (uint256 oneEthUsd1e18,) = _quotePrice(weth);
        (uint256 quotePrice1e18, uint8 quoteDecimals) = _quotePrice(quoteAsset);
        // Permanent-effect P0 math, isolated + fuzzed in BackingMath. Feeding
        // "USD value of 1 ETH" as the numerator (instead of treasury backing)
        // is the entire mechanism — the library itself is untouched.
        openTick =
            BackingMath.p0Tick(oneEthUsd1e18, TOTAL_SUPPLY, quotePrice1e18, quoteDecimals, TICK_SPACING, tokenIsCurrency0);
    }

    /// @dev Best-effort, informational-only USD value of everything the
    ///      treasury holds right now — feeds ONLY the Graduated event's display
    ///      figure. Deliberately non-reverting (rule 6): since opening price no
    ///      longer reads the treasury at all (see _p0Tick), a stale treasury
    ///      feed has nothing left to protect by reverting — so a stale asset is
    ///      simply left out of the sum instead of blocking graduation over a
    ///      number nothing on-chain depends on.
    function _informationalBackingUsd(address treasury) internal view returns (uint256 backingUsd1e18) {
        address[] memory assets = ProjectTreasury(treasury).assets();
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 held = ProjectTreasury(treasury).heldBalance(assets[i]);
            if (held == 0) continue;
            address feed = IAssetRegistry(registry).feedOf(assets[i]);
            (, int256 ans,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
            if (ans <= 0) continue;
            if (block.timestamp - updatedAt > IAssetRegistry(registry).staleAfter(assets[i])) continue;
            uint256 usd = FullMath.mulDiv(held, uint256(ans), 10 ** AggregatorV3Interface(feed).decimals());
            backingUsd1e18 += FullMath.mulDiv(usd, 1e18, 10 ** IERC20Metadata(assets[i]).decimals());
        }
    }

    /// @notice Launch a project: deploy the token + treasury, wire them, register.
    /// @param noticePeriod Withdrawal notice, restricted to the offered set
    ///        (7 / 30 / 90 days) and immutable on the treasury once set.
    /// @param metadataURI ipfs://CID of the pinned project metadata JSON (name,
    ///        description, category, logo, website, x). Stored on the token as the
    ///        permanent launch identity + the initial (updatable) current URI.
    /// @param quoteAssets_ The asset(s) this launch's pool(s) will be paired
    ///        against at graduation — 1 to MAX_QUOTE_ASSETS entries, each `weth`
    ///        or one of the deploy-time GREEN assets (isGreenQuoteAsset), no
    ///        duplicates. Each pool gets an equal share of the token supply at
    ///        graduation — see QuoteAssetNotSupportedYet and
    ///        docs/exit-liquidity-table.md.
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint256 noticePeriod,
        string calldata metadataURI,
        address[] calldata quoteAssets_
    ) external returns (uint256 id, address token, address treasury) {
        if (!(noticePeriod == 7 days || noticePeriod == 30 days || noticePeriod == 90 days)) {
            revert BadNoticePeriod();
        }
        uint256 nq = quoteAssets_.length;
        if (nq == 0) revert NoQuoteAssets();
        if (nq > MAX_QUOTE_ASSETS) revert TooManyQuoteAssets();
        for (uint256 i = 0; i < nq; i++) {
            address qa = quoteAssets_[i];
            if (qa != weth && !isGreenQuoteAsset[qa]) revert QuoteAssetNotSupportedYet();
            for (uint256 j = i + 1; j < nq; j++) {
                if (quoteAssets_[j] == qa) revert DuplicateQuoteAsset();
            }
        }

        // 1. Token — plain CREATE, no mining. Its address relative to weth is
        //    unconstrained (could sort either side) — see OrderingLib. graduate()/
        //    BallastSeeder mirror the one-sided-liquidity math for whichever
        //    ordering this token's nonce-based address happens to land on, so
        //    nothing here (or at graduate() time) depends on the outcome.
        //    Full supply minted to the factory for one-sided pool seeding.
        BallastToken t = new BallastToken(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this), metadataURI);

        // 2. Treasury — projectToken is immutable here, so self-backing is impossible.
        ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);

        // 3. Wire the token -> treasury pointer, permanently (write-once).
        t.initTreasury(address(tr));

        // 4. Register.
        token = address(t);
        treasury = address(tr);
        launches.push(Launch({token: token, treasury: treasury, creator: msg.sender, quoteAssets: quoteAssets_}));
        id = launches.length - 1;
        launchIdOf[token] = id + 1;

        emit Launched(id, msg.sender, token, treasury, noticePeriod, metadataURI);
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }
}
