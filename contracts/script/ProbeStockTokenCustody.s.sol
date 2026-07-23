// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {ProbeVault} from "./probe/ProbeVault.sol";

/// @title Session 0 probe — can a contract custody a Robinhood Stock Token?
///
/// @notice BALLAST's entire mechanism assumes a smart contract can receive, hold,
///         and transfer out a tokenized-equity Stock Token. This script answers it
///         against a LIVE token and prints a YES / PARTIAL / NO verdict, with the
///         PUSH and PULL paths reported separately.
///
///         No try/catch, no fallback, no retries. If a custody step reverts, the
///         whole script reverts and Foundry prints the exact reason (-vvvv).
///
/// Flow (single cycle, so step 3 confirms BOTH landed = 2×amount):
///   1. PUSH   — EOA calls token.transfer(vault, amount)
///   2. PULL   — EOA approves vault, then vault.pull(token, eoa, amount) (transferFrom)
///   3. READ   — vault balance should equal 2×amount
///   4. SWEEP  — vault.sweep(token, eoa) moves the full balance out (re-callable)
///   5. BACK   — EOA balance restored to its starting value
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY  — funded EOA that ALREADY HOLDS >= 2×PROBE_AMOUNT of the token
///   PROBE_STOCK_TOKEN     — the stock token address
///   PROBE_AMOUNT          — raw amount (18 dec) to move per path; needs balance >= 2×
/// Optional env:
///   PROBE_FEED            — Chainlink feed proxy for the token; if set, prints
///                           latestRoundData (price, decimals, updatedAt, age)
///
/// Run:
///   forge script script/ProbeStockTokenCustody.s.sol:ProbeStockTokenCustody \
///     --rpc-url robinhood_mainnet --broadcast -vvvv
contract ProbeStockTokenCustody is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address token = vm.envAddress("PROBE_STOCK_TOKEN");
        uint256 amount = vm.envUint("PROBE_AMOUNT");
        address feed = vm.envOr("PROBE_FEED", address(0));
        address eoa = vm.addr(pk);

        require(token != address(0), "PROBE_STOCK_TOKEN unset");
        require(amount > 0, "PROBE_AMOUNT unset");

        uint256 startBal = IERC20(token).balanceOf(eoa);

        console2.log("=== Session 0 custody probe ===");
        console2.log("EOA:            ", eoa);
        console2.log("Token:          ", token);
        console2.log("Amount / path:  ", amount);
        console2.log("EOA balance:    ", startBal);
        require(startBal >= 2 * amount, "EOA needs >= 2x PROBE_AMOUNT (push + pull)");

        _printDiagnostics(token, feed, eoa);

        vm.startBroadcast(pk);

        // --- deploy a contract to act as custodian --------------------------
        ProbeVault vault = new ProbeVault();
        console2.log("ProbeVault:     ", address(vault));

        // --- STEP 1: PUSH — EOA transfers the token INTO the contract -------
        console2.log("STEP 1 PUSH: token.transfer(vault, amount) ...");
        bool pushOk = IERC20(token).transfer(address(vault), amount);
        console2.log("STEP 1 PUSH: SUCCESS, returned:", pushOk);

        // --- STEP 2: PULL — approve, then contract-initiated transferFrom ----
        console2.log("STEP 2 PULL: token.approve(vault, amount) ...");
        bool approveOk = IERC20(token).approve(address(vault), amount);
        console2.log("STEP 2 PULL: approve returned:", approveOk);
        console2.log("STEP 2 PULL: vault.pull(token, eoa, amount) [transferFrom] ...");
        bool pullOk = vault.pull(token, eoa, amount);
        console2.log("STEP 2 PULL: SUCCESS, returned:", pullOk);

        // --- STEP 3: READ vault balance (expect 2x amount) ------------------
        uint256 held = vault.heldBalance(token);
        console2.log("STEP 3 READ: vault balance:", held);
        require(held == 2 * amount, "vault balance != 2x amount");

        // --- STEP 4: SWEEP the full balance back out ------------------------
        console2.log("STEP 4 SWEEP: vault.sweep(token, eoa) ...");
        (uint256 swept, bool sweepOk) = vault.sweep(token, eoa);
        console2.log("STEP 4 SWEEP: SUCCESS, swept:", swept);
        console2.log("STEP 4 SWEEP: returned:", sweepOk);

        vm.stopBroadcast();

        // --- STEP 5: EOA balance restored -----------------------------------
        uint256 endBal = IERC20(token).balanceOf(eoa);
        uint256 endHeld = vault.heldBalance(token);
        console2.log("STEP 5 BACK: EOA balance:", endBal);
        console2.log("STEP 5 BACK: vault residual:", endHeld);

        bool pushWorked = pushOk;
        bool pullWorked = pullOk && approveOk;
        bool sweptOut = sweepOk && endHeld == 0 && endBal == startBal;

        console2.log("========================================");
        console2.log("PUSH path:", pushWorked ? "YES" : "NO");
        console2.log("PULL path (real deposit path):", pullWorked ? "YES" : "NO");
        console2.log("SWEEP out + full restore:", sweptOut ? "YES" : "NO");
        if (pushWorked && pullWorked && sweptOut) {
            console2.log("VERDICT: YES - a contract can receive (push+pull), hold, and transfer out this token.");
        } else if ((pushWorked || pullWorked) && !sweptOut) {
            console2.log("VERDICT: PARTIAL - can receive but NOT fully transfer out. Treasury withdrawals would brick.");
        } else {
            console2.log("VERDICT: PARTIAL/NO - see per-path lines above.");
        }
        console2.log("========================================");
    }

    /// @dev Read-only diagnostics. Read directly (no try/catch) so a missing method
    ///      surfaces as a revert rather than being silently swallowed.
    function _printDiagnostics(address token, address feed, address eoa) internal view {
        console2.log("--- stock-token (ERC-8056) diagnostics ---");
        console2.log("uiMultiplier():   ", IStockToken(token).uiMultiplier());
        console2.log("oraclePaused():   ", IStockToken(token).oraclePaused());
        console2.log("balanceOf(eoa):   ", IERC20(token).balanceOf(eoa));
        console2.log("balanceOfUI(eoa): ", IStockToken(token).balanceOfUI(eoa));
        console2.log("totalSupply():    ", IERC20(token).totalSupply());
        console2.log("totalSupplyUI():  ", IStockToken(token).totalSupplyUI());

        if (feed != address(0)) {
            console2.log("--- Chainlink feed ---");
            AggregatorV3Interface f = AggregatorV3Interface(feed);
            uint8 dec = f.decimals();
            (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
            console2.log("feed:           ", feed);
            console2.log("decimals:       ", dec);
            console2.log("answer (price): ", answer);
            console2.log("updatedAt:      ", updatedAt);
            console2.log("age (s):        ", block.timestamp - updatedAt);
        } else {
            console2.log("PROBE_FEED not set - skipping Chainlink read (report it as UNAVAILABLE, not zero).");
        }
    }
}
