// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ManateeRenderer} from "../src/manatee/ManateeRenderer.sol";
import {BallastManatee} from "../src/manatee/BallastManatee.sol";

/// @notice Deploys the BALLAST manatee mint: the immutable on-chain SVG
///         generator, then the ERC-721 that points at it.
///
///         The deployer EOA becomes the collection owner (Ownable2Step) and the
///         EIP-2981 royalty receiver — the same key as the rest of BALLAST,
///         disclosed as such. No protocol contract is touched.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY — funded deployer (also becomes owner + royalty payee)
///
/// First load the repo-root .env into the shell (forge only auto-reads a .env in
/// the Foundry root, i.e. contracts/):  set -a; source ../.env; set +a
///
/// Dry run (simulate, show args + predicted addresses, NO broadcast):
///   forge script script/DeployManatee.s.sol:DeployManatee --rpc-url robinhood_mainnet
///
/// Broadcast + verify. Blockscout needs BOTH --verifier and --verifier-url — bare
/// `--verifier blockscout` errors with "No verifier URL specified":
///   forge script script/DeployManatee.s.sol:DeployManatee \
///     --rpc-url robinhood_mainnet --broadcast \
///     --verify --verifier blockscout \
///     --verifier-url https://robinhoodchain.blockscout.com/api/
///
/// If verification is skipped or fails at deploy time, verify the two contracts
/// after the fact (paths are relative to contracts/, so use src/... NOT
/// contracts/src/...):
///   forge verify-contract <RENDERER_ADDR> src/manatee/ManateeRenderer.sol:ManateeRenderer \
///     --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
///     --compiler-version 0.8.28 --watch
///   forge verify-contract <NFT_ADDR> src/manatee/BallastManatee.sol:BallastManatee \
///     --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ \
///     --compiler-version 0.8.28 --watch \
///     --constructor-args $(cast abi-encode "constructor(address)" <RENDERER_ADDR>)
contract DeployManatee is Script {
    function run() external returns (ManateeRenderer renderer, BallastManatee nft) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("Deployer / owner / royalty receiver:", deployer);
        console2.log("Royalty: 7.5% (750 / 10000), EIP-2981");

        vm.startBroadcast(pk);
        renderer = new ManateeRenderer();
        nft = new BallastManatee(address(renderer));
        vm.stopBroadcast();

        console2.log("ManateeRenderer:", address(renderer));
        console2.log("BallastManatee: ", address(nft));
        console2.log("MAX_SUPPLY:     ", nft.MAX_SUPPLY());

        // Sanity: the on-chain art must be reachable through the NFT for id 1
        // once minted. We can't mint in a pure deploy, but we can prove the
        // renderer link resolves and produces bytes.
        require(address(nft.renderer()) == address(renderer), "renderer link");
        require(bytes(renderer.svg(1)).length > 2000, "renderer svg empty");
    }
}
