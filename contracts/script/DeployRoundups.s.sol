// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BurnVote} from "../src/BurnVote.sol";
import {RoundupRouter} from "../src/RoundupRouter.sol";
import {RoundupMainAdapter} from "../src/RoundupMainAdapter.sol";

/// @title DeployRoundups — deploys BurnVote (now) and, when its routing adapters
///        are supplied, RoundupRouter. DRY-RUN ONLY — no broadcast is signed here.
///
/// @notice Sign with `--account <new-keystore> --sender <addr>` and type the
///         password at the interactive prompt. No --password-file, no -k, no
///         private keys. Never the compromised deployer. Same pattern as
///         DeployBasketZap.s.sol / DeployBuybackV2.s.sol.
///
///         BurnVote is self-contained and deployable today (registry + factory,
///         both live). RoundupRouter needs its IMainSwapRouter + IStockBuyer
///         adapters, which must be built, fork-tested and audited first — so it is
///         only constructed when ROUNDUP_MAIN_ROUTER and ROUNDUP_STOCK_BUYER are
///         set in env. See docs/security/roundups.md.
contract DeployRoundups is Script {
    /// @dev AssetRegistry — the round-up stock allowlist (isAllowed). Identical
    ///      constant to DeployBasketZap.s.sol's REGISTRY.
    address public constant REGISTRY = 0x427764d0d19aB765c35A41A5aa4771580307dA81;

    /// @dev ALL four BallastFactory generations, so a token launched by ANY of them
    ///      is votable — gen-1..4, newest first. Verified on chain 4663 (this review):
    ///      each implements launchIdOf (returns 0 for a non-launch, never reverts) and
    ///      each has live launches. FeeRouter v1/v2 and Safe launches all go THROUGH
    ///      one of these factories (the router/Safe calls BallastFactory.launch), so
    ///      their tokens carry a launchIdOf here and need no separate entry. The set
    ///      is IMMUTABLE after construction; a factory predating launchIdOf would just
    ///      be skipped by the try/catch, so an extra entry is always safe.
    address public constant FACTORY_GEN4 = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;
    address public constant FACTORY_GEN3 = 0x3Eb5532e982931caD40d0416AdbD7930A57965aE;
    address public constant FACTORY_GEN2 = 0x05aaA5c50e8c3067c3321dF07686Ac52be8F2ED1;
    address public constant FACTORY_GEN1 = 0x069974136c78Cf0F2162463B95321E59F56523D8;

    function buildFactories() public pure returns (address[] memory factories) {
        factories = new address[](4);
        factories[0] = FACTORY_GEN4;
        factories[1] = FACTORY_GEN3;
        factories[2] = FACTORY_GEN2;
        factories[3] = FACTORY_GEN1;
    }

    function run() external returns (BurnVote bv, RoundupRouter rr) {
        vm.startBroadcast();

        bv = new BurnVote(REGISTRY, buildFactories());
        console2.log("BurnVote deployed:", address(bv));

        // RoundupRouter needs both adapters. The stock buyer (BasketStockBuyer, 0.8.26
        // V4Router) is deployed separately by DeployBasketStockBuyer.s.sol and passed
        // in via ROUNDUP_STOCK_BUYER. The main adapter (RoundupMainAdapter, 0.8.28) is
        // deployed HERE over the live BallastRouterV2 when BALLAST_ROUTER_V2 is set.
        // All of it stays GATED until the adapters are fork-tested + audited — do not
        // set NEXT_PUBLIC_ROUNDUP_ROUTER until then (docs/security/roundups.md).
        address stockBuyer = vm.envOr("ROUNDUP_STOCK_BUYER", address(0));
        address routerV2 = vm.envOr("BALLAST_ROUTER_V2", address(0)); // 0xa0Aba92d…747E0
        if (stockBuyer != address(0) && routerV2 != address(0)) {
            RoundupMainAdapter mainAdapter = new RoundupMainAdapter(routerV2);
            console2.log("RoundupMainAdapter deployed:", address(mainAdapter));
            rr = new RoundupRouter(REGISTRY, address(mainAdapter), stockBuyer);
            console2.log("RoundupRouter deployed:", address(rr));
        } else {
            console2.log("RoundupRouter SKIPPED: set ROUNDUP_STOCK_BUYER (from DeployBasketStockBuyer)");
            console2.log("and BALLAST_ROUTER_V2. Adapters must be fork-tested + audited first.");
        }

        vm.stopBroadcast();

        console2.log("VERIFY: forge verify-contract <addr> src/BurnVote.sol:BurnVote");
        console2.log("  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
        console2.log(
            "SET IN VERCEL: NEXT_PUBLIC_BURN_VOTE=<BurnVote>  NEXT_PUBLIC_ROUNDUP_ROUTER=<RoundupRouter|empty>"
        );
    }
}
