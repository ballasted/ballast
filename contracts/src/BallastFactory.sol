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

    /// @notice WETH — the token is CREATE2-mined to sort BELOW it (currency0) so
    ///         the pool price is WETH/token directly (price up = tick up), which
    ///         keeps the one-sided seeded range intuitive and kills a tick-sign trap.
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

    /// @notice Target fully-diluted valuation, in WETH, at which an UNBACKED launch's
    ///         pool opens. NO oracle: it is a WETH-denominated ratio, so the USD figure
    ///         moves with ETH — deliberately, because the token/WETH pool's
    ///         ETH-denominated depth is what governs slippage, so a WETH peg keeps
    ///         manipulation-cost consistent across launches regardless of where ETH
    ///         trades. Set once at deploy (immutable); retuning is a redeploy.
    ///
    ///         Chosen = 5 ETH. By the one-sided depth relation (√k−1)·FDV, ~2 ETH of
    ///         net buying doubles an unbacked token and ~11 ETH takes it 10×. The
    ///         earlier value (1 ETH) let ~0.4 ETH (a few hundred dollars) double a
    ///         price the Discover board publishes with confidence — cheap enough to
    ///         make the whole board's numbers manipulable, not just one token's. 5 ETH
    ///         puts manipulation in the thousands, which is the point.
    uint256 public immutable unbackedOpenFdvWeth;

    /// @notice Opening tick for UNBACKED launches, DERIVED from `unbackedOpenFdvWeth`
    ///         at deploy via the same floor-aligned math as backed P0 (BackingMath) —
    ///         no magic number. Immutable; a multiple of TICK_SPACING.
    int24 public immutable UNBACKED_TICK;

    mapping(address token => bool) public graduated;

    struct Launch {
        address token;
        address treasury;
        address creator;
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
    error CouldNotMineCurrency0();
    error WrongOrdering();
    error NotLaunchToken();
    error AlreadyGraduated();
    /// @notice A backed launch's feed was stale beyond its outer bound at graduation
    ///         (treasury feed: past AssetRegistry.staleAfter; ETH/USD: past
    ///         ethUsdStaleWindow), so P0 would be set from a dead price permanently.
    ///         This is the coarse backstop — the off-chain create flow additionally
    ///         gates on market hours, so in practice this only trips on a genuinely
    ///         broken feed, not on an expected weekend/holiday rest.
    error FeedStaleAtLaunch(address asset);

    constructor(
        address registry_,
        address weth_,
        BallastSeeder seeder_,
        address ethUsdFeed_,
        uint256 ethUsdStaleWindow_,
        uint256 unbackedOpenFdvWeth_
    ) {
        if (registry_ == address(0) || weth_ == address(0) || address(seeder_) == address(0) || ethUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        if (ethUsdStaleWindow_ == 0) revert ZeroAddress();
        if (unbackedOpenFdvWeth_ == 0) revert ZeroAddress();
        registry = registry_;
        weth = weth_;
        seeder = seeder_;
        ethUsdFeed = ethUsdFeed_;
        ethUsdStaleWindow = ethUsdStaleWindow_;
        unbackedOpenFdvWeth = unbackedOpenFdvWeth_;
        // Derive the opening tick once, from the FDV, using the same floor-aligned
        // math as backed P0 — so -191160 (at 5 ETH) is never a hand-entered constant.
        UNBACKED_TICK = BackingMath.unbackedTick(unbackedOpenFdvWeth_, TOTAL_SUPPLY, TICK_SPACING);
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

        address treasury = launches[idPlus1 - 1].treasury;
        (int24 tickLower, uint256 backingUsd) = _p0Tick(treasury);

        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(address(seeder), supply);
        seeder.seed(token, tickLower);

        emit Graduated(token, treasury, tickLower, backingUsd);
    }

    /// @dev P0 tick + backing USD. Reverts if any held treasury feed is stale beyond
    ///      its per-asset outer bound (AssetRegistry.staleAfter), or the ETH/USD leg
    ///      beyond ethUsdStaleWindow. Age is NOT a proxy for inaccuracy on a
    ///      deviation-threshold feed — a quiet-but-recent SGOV price is correct — so
    ///      this bound is the asset's real cadence (e.g. 120h SGOV / 96h equities),
    ///      not a blunt trading-hours window.
    function _p0Tick(address treasury) internal view returns (int24 tickLower, uint256 backingUsd1e18) {
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

        (, int256 e,, uint256 eUpd,) = AggregatorV3Interface(ethUsdFeed).latestRoundData();
        require(e > 0, "invalid eth price");
        if (block.timestamp - eUpd > ethUsdStaleWindow) revert FeedStaleAtLaunch(ethUsdFeed);
        uint256 ethUsd = FullMath.mulDiv(uint256(e), 1e18, 10 ** AggregatorV3Interface(ethUsdFeed).decimals());
        // Permanent-effect P0 math, isolated + fuzzed in BackingMath.
        tickLower = BackingMath.p0Tick(backingUsd1e18, TOTAL_SUPPLY, ethUsd, TICK_SPACING);
    }

    /// @dev CREATE2 address of `initHash` deployed by this factory with `salt`.
    function _create2(bytes32 salt, bytes32 initHash) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @dev Mine a salt whose CREATE2 address sorts BELOW weth (currency0) and is
    ///      unused. Extracted from launch() to keep that frame within the stack
    ///      limit. Reverts if none found in the search window.
    function _mineCurrency0Salt(bytes32 initHash) internal view returns (bytes32) {
        for (uint256 s = 0; s < 4000; s++) {
            address predicted = _create2(bytes32(s), initHash);
            if (predicted < weth && predicted.code.length == 0) return bytes32(s);
        }
        revert CouldNotMineCurrency0();
    }

    /// @notice Launch a project: deploy the token + treasury, wire them, register.
    /// @param noticePeriod Withdrawal notice, restricted to the offered set
    ///        (7 / 30 / 90 days) and immutable on the treasury once set.
    /// @param metadataURI ipfs://CID of the pinned project metadata JSON (name,
    ///        description, category, logo, website, x). Stored on the token as the
    ///        permanent launch identity + the initial (updatable) current URI.
    function launch(string calldata name_, string calldata symbol_, uint256 noticePeriod, string calldata metadataURI)
        external
        returns (uint256 id, address token, address treasury)
    {
        if (!(noticePeriod == 7 days || noticePeriod == 30 days || noticePeriod == 90 days)) {
            revert BadNoticePeriod();
        }

        // 1. Token — CREATE2-mined so its address sorts BELOW weth (currency0).
        //    Full supply minted to the factory for one-sided pool seeding. Mining is
        //    factored out to keep this frame under the stack limit.
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(BallastToken).creationCode,
                abi.encode(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this), metadataURI)
            )
        );
        BallastToken t =
            new BallastToken{salt: _mineCurrency0Salt(initHash)}(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this), metadataURI);
        // On-chain guard — never trust the mined salt; verify the actual ordering.
        if (address(t) >= weth) revert WrongOrdering();

        // 2. Treasury — projectToken is immutable here, so self-backing is impossible.
        ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);

        // 3. Wire the token -> treasury pointer, permanently (write-once).
        t.initTreasury(address(tr));

        // 4. Register.
        token = address(t);
        treasury = address(tr);
        launches.push(Launch({token: token, treasury: treasury, creator: msg.sender}));
        id = launches.length - 1;
        launchIdOf[token] = id + 1;

        emit Launched(id, msg.sender, token, treasury, noticePeriod, metadataURI);
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }
}
