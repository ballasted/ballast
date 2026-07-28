// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {MarketHours} from "../src/interfaces/IAssetRegistry.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IDescribed {
    function description() external view returns (string memory);
}

/// @title SetAssets — expand the BALLAST treasury asset allowlist.
///
/// @notice Adds the high-liquidity Robinhood stock/ETF tokens to AssetRegistry via
///         setAsset(...). This script is the human's tool to run ONCE, as the
///         registry owner, after they have pasted VERIFIED addresses into .env.
///
/// ── Why addresses come from env, not baked in ──────────────────────────────────
///   Two addresses per asset — the STOCK TOKEN and its CHAINLINK FEED — must be
///   verified by a human against their primary sources before any value reads them
///   (CLAUDE.md rules 14 & 15, research doc §7). Two traps this script CANNOT catch
///   for you, so you must get them right at the source:
///     • Impostor tokens: a matching ticker with a different contract address is NOT
///       a Robinhood Stock Token. Copy the token address from the on-chain asset
///       registry (docs.robinhood.com/chain/contracts), never from a blog.
///     • SVR vs Standard proxy: every Chainlink feed here exposes a Standard Proxy
///       (proxyAddress) AND an SVR Proxy (secondaryProxyAddress). They can look
///       identical on-chain today and diverge later, so no runtime check saves you.
///       Use the STANDARD proxy. SGOV example — Standard 0xa0DF…577A11, SVR
///       0xa7a18Ca3… (do NOT use the SVR one).
///
/// ── What this script DOES verify on-chain, per asset, before allowlisting ───────
///   1. The feed answers latestRoundData() with a positive price (a real feed).
///   2. feed.decimals() is READ, never assumed 8 (CLAUDE.md rule 9) — logged.
///   3. feed.description() CONTAINS the expected ticker and "USD" (rule 16 naming:
///      "Robinhood TICKER / USD" or "Robinhood TICKER-USD"). A mismatch aborts —
///      this is the on-chain confirmation the feed is the one you think it is.
///   4. token.symbol()/decimals() are logged so you can eyeball the token identity.
///   5. The implied USD value of minDeposit at the live price is logged, so you can
///      sanity-check the per-asset minimum before it goes live.
///   Any candidate whose TOKEN or FEED env var is unset (address(0)) is SKIPPED and
///   listed — that is how a token with NO official feed is reported (rule 17: only
///   ~35 of ~95 stock tokens have a feed; the allowlist is materially smaller than
///   the registry). It never freshness-gates: a resting weekend price is fine here
///   (this only writes config), and staleness must never revert (rule 6).
///
/// ── Required env ────────────────────────────────────────────────────────────────
///   ASSET_REGISTRY         deployed AssetRegistry (mainnet: see the deploy notes)
///   DEPLOYER_PRIVATE_KEY   the registry OWNER (setAsset is onlyOwner)
///   TOKEN_<TICKER>         canonical stock-token address (e.g. TOKEN_NVDA)
///   FEED_<TICKER>          Chainlink STANDARD proxy address (e.g. FEED_NVDA)
///   DRY_RUN (optional)     "true" = verify + log only, do NOT broadcast setAsset
///
/// ── Run ───────────────────────────────────────────────────────────────────────
///   Dry-run first (no --broadcast, no key needed to read):
///     DRY_RUN=true forge script script/SetAssets.s.sol:SetAssets --rpc-url robinhood_mainnet
///   Then, as the owner, for real:
///     forge script script/SetAssets.s.sol:SetAssets --rpc-url robinhood_mainnet --broadcast
contract SetAssets is Script {
    /// @dev A candidate asset. `token`/`feed` are pulled from env at run time; the
    ///      economic parameters below are protocol choices, reviewable here in git.
    struct Candidate {
        string ticker;
        uint256 staleAfter; // absolute OUTER bound (seconds); coarse `stale` flag only.
        uint256 minDeposit; // in TOKEN decimals (stock tokens are 18-dp). Dust floor.
        MarketHours marketHours;
    }

    // staleAfter is the outer absolute bound behind the on-chain `stale` flag AND the
    // coarse freshness backstop graduation now uses (BallastFactory._p0Tick reads
    // registry.staleAfter per asset — no separate FRESH_WINDOW). The fine
    // RESTING-vs-STALE tier the UI shows is still computed off-chain from marketHours +
    // updatedAt (web/lib/marketHours.ts). So these bounds just need to comfortably
    // clear a legitimate market closure:
    //   • Equities (us_equities_24/5): 96h clears a Fri/Mon-holiday 3-day weekend.
    //   • SGOV (T-bill ETF): 120h — an ultra-low-volatility instrument whose price
    //     resting across a long holiday break is entirely expected, so a looser outer
    //     bound avoids a coarse `stale` flag that would only cry wolf.
    uint256 constant EQUITY_STALE = 96 hours;
    uint256 constant SGOV_STALE = 120 hours;

    function run() external {
        AssetRegistry registry = AssetRegistry(vm.envAddress("ASSET_REGISTRY"));
        bool dryRun = vm.envOr("DRY_RUN", false);

        Candidate[10] memory candidates = [
            // The nine high-liquidity names requested, plus SGOV (already listed;
            // re-setting is idempotent and lets this script be the single source).
            Candidate("SGOV", SGOV_STALE, 1e18, MarketHours.UsEquities24_5), // ~$100/sh: 1 tok
            Candidate("NVDA", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("TSLA", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("GOOGL", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("AAPL", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("MSFT", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("AMZN", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("META", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("SPY", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5),
            Candidate("QQQ", EQUITY_STALE, 1e17, MarketHours.UsEquities24_5)
        ];

        uint256 pk;
        if (!dryRun) pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("=== SetAssets: expand allowlist ===");
        console2.log("registry:", address(registry));
        console2.log(dryRun ? "MODE: DRY-RUN (no writes)" : "MODE: BROADCAST");
        console2.log("");

        string memory skipped = "";
        uint256 toWrite;

        // First pass: resolve env, verify every resolvable candidate on-chain.
        address[10] memory tok;
        address[10] memory fd;
        for (uint256 i = 0; i < candidates.length; i++) {
            Candidate memory c = candidates[i];
            tok[i] = vm.envOr(string.concat("TOKEN_", c.ticker), address(0));
            fd[i] = vm.envOr(string.concat("FEED_", c.ticker), address(0));

            if (tok[i] == address(0) || fd[i] == address(0)) {
                // No verified feed and/or token → cannot be ballast. Report it.
                skipped = string.concat(skipped, bytes(skipped).length > 0 ? ", " : "", c.ticker);
                continue;
            }
            _verify(c, tok[i], fd[i]);
            toWrite++;
        }

        console2.log("");
        console2.log("SKIPPED (no verified TOKEN_/FEED_ env set - not added):");
        console2.log(bytes(skipped).length == 0 ? "  (none)" : string.concat("  ", skipped));
        console2.log("verified & ready to write:", toWrite);

        // Second pass: write. Verification already passed for every resolved entry,
        // so a revert here is a permissions problem (not owner), not bad data.
        if (!dryRun && toWrite > 0) {
            vm.startBroadcast(pk);
            for (uint256 i = 0; i < candidates.length; i++) {
                if (tok[i] == address(0) || fd[i] == address(0)) continue;
                Candidate memory c = candidates[i];
                registry.setAsset(tok[i], fd[i], c.staleAfter, c.minDeposit, c.marketHours);
                console2.log("setAsset:", c.ticker, tok[i]);
            }
            vm.stopBroadcast();
        }

        // Report the resulting allowlist (a plain view call — no broadcast needed).
        address[] memory allowed = registry.allowedAssets();
        console2.log("");
        console2.log("=== allowedAssets() now returns", allowed.length, "assets ===");
        for (uint256 i = 0; i < allowed.length; i++) {
            (, address feed,, uint256 minDep, MarketHours mh) = registry.assetConfig(allowed[i]);
            console2.log("  asset:", allowed[i]);
            console2.log("    feed:", feed, "  minDeposit:", minDep);
            console2.log("    marketHours(0=Unknown,1=Equities,2=Crypto):", uint256(mh));
        }
    }

    /// @dev Read-only on-chain checks. Reverts (aborting the whole run) on anything
    ///      that would put a wrong or unpriceable asset on the allowlist.
    function _verify(Candidate memory c, address token, address feed) internal view {
        console2.log("--- verify", c.ticker, "---");
        console2.log("  token:", token);
        console2.log("  feed :", feed);

        // Token identity (informational; the ADDRESS is the source of truth, rule 14).
        try IERC20Metadata(token).symbol() returns (string memory s) {
            console2.log("  token.symbol():", s);
        } catch {
            console2.log("  token.symbol(): <none>");
        }
        uint8 tokDec = 18;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            tokDec = d;
            console2.log("  token.decimals():", d);
        } catch {
            console2.log("  token.decimals(): <none> (assuming 18)");
        }

        // Feed identity: the description must name "Robinhood", the ticker, AND USD
        // (rule 16; feeds are "Robinhood TICKER / USD" or "Robinhood TICKER-USD").
        // Requiring "Robinhood" is the on-chain confirmation this is the Robinhood
        // Standard proxy for the ticker and not a look-alike feed. (Standard-vs-SVR
        // itself can't be told apart on-chain — the two proxies can be byte-identical
        // today and diverge later — so getting the STANDARD proxyAddress right at
        // input time remains the rule; see the env comments. rule 15.)
        string memory desc = "";
        try IDescribed(feed).description() returns (string memory d) {
            desc = d;
            console2.log("  feed.description():", d);
        } catch {
            revert(string.concat(c.ticker, ": feed has no description() - is this a Chainlink proxy?"));
        }
        require(_contains(desc, "Robinhood"), string.concat(c.ticker, ": feed description does not contain 'Robinhood'"));
        require(_contains(desc, c.ticker), string.concat(c.ticker, ": feed description does not contain ticker"));
        require(_contains(desc, "USD"), string.concat(c.ticker, ": feed description is not a USD feed"));

        // Feed decimals READ, never assumed (rule 9).
        uint8 feedDec = AggregatorV3Interface(feed).decimals();
        console2.log("  feed.decimals():", feedDec);

        // A real, positive price. We do NOT gate on freshness (a resting weekend
        // price is valid; staleness must never revert — rule 6).
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        require(answer > 0, string.concat(c.ticker, ": feed answer <= 0 (unpriceable)"));
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        console2.log("  price(raw):", uint256(answer), " age(s):", age);

        // Implied USD floor of minDeposit at the live price, so the human can judge
        // whether the per-asset minimum is sensible for this unit price (point 5).
        // impliedUsd_1e2 = minDeposit * price * 100 / (10^tokDec * 10^feedDec)
        uint256 impliedCents = (c.minDeposit * uint256(answer) * 100) / (10 ** tokDec * 10 ** feedDec);
        console2.log("  minDeposit:", c.minDeposit);
        console2.log("    ~= USD cents at live price:", impliedCents);
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return n.length == 0;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
