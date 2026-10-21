// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BurnVote} from "../src/BurnVote.sol";
import {RoundupRouter} from "../src/RoundupRouter.sol";

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

    /// @dev Current BallastFactory (launchIdOf). Identical to DeployBasketZap's.
    address public constant FACTORY = 0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67;

    /// @dev HUMAN: append any PRIOR BallastFactory addresses whose launched tokens
    ///      should also be votable before broadcasting. The set is IMMUTABLE after
    ///      construction. A factory predating launchIdOf reverts the probe and is
    ///      skipped at runtime, so including an older one is safe.
    function buildFactories() public pure returns (address[] memory factories) {
        factories = new address[](1);
        factories[0] = FACTORY;
    }

    function run() external returns (BurnVote bv, RoundupRouter rr) {
        vm.startBroadcast();

        bv = new BurnVote(REGISTRY, buildFactories());
        console2.log("BurnVote deployed:", address(bv));

        // RoundupRouter only when both adapters are supplied (0 = skip).
        address mainRouter = vm.envOr("ROUNDUP_MAIN_ROUTER", address(0));
        address stockBuyer = vm.envOr("ROUNDUP_STOCK_BUYER", address(0));
        if (mainRouter != address(0) && stockBuyer != address(0)) {
            rr = new RoundupRouter(REGISTRY, mainRouter, stockBuyer);
            console2.log("RoundupRouter deployed:", address(rr));
        } else {
            console2.log("RoundupRouter SKIPPED: set ROUNDUP_MAIN_ROUTER + ROUNDUP_STOCK_BUYER");
            console2.log("(adapters must be fork-tested + audited first; see docs/security/roundups.md)");
        }

        vm.stopBroadcast();

        console2.log("VERIFY: forge verify-contract <addr> src/BurnVote.sol:BurnVote");
        console2.log("  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663");
        console2.log(
            "SET IN VERCEL: NEXT_PUBLIC_BURN_VOTE=<BurnVote>  NEXT_PUBLIC_ROUNDUP_ROUTER=<RoundupRouter|empty>"
        );
    }
}
