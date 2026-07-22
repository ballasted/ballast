// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {ProjectTreasury} from "../src/ProjectTreasury.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @title VerifyBackingMainnet — deploy a real treasury, deposit real SGOV, and
///        compute backing per token from the REAL Chainlink feed.
///
/// @notice Proves the one number the product rests on with real inputs. It does
///         NOT deploy BackingLens or call backingOf: that contract hard-requires
///         an L2 Sequencer Uptime Feed, and Chainlink publishes none for chain
///         4663 (verified 2026-07). Rather than pass a fake sequencer address,
///         this replicates BackingLens's EXACT valuation math inline. The math is
///         identical to backingOf minus the sequencer gate.
///
/// Required env: DEPLOYER_PRIVATE_KEY, PROBE_STOCK_TOKEN (SGOV),
///               SGOV_FEED (STANDARD proxy), PROBE_AMOUNT.
///
/// Run:
///   forge script script/VerifyBackingMainnet.s.sol:VerifyBackingMainnet \
///     --rpc-url robinhood_mainnet --broadcast -vvvv
contract VerifyBackingMainnet is Script {
    uint256 constant WAD = 1e18;

    struct R {
        uint256 held;
        uint256 supply;
        uint8 priceDec;
        uint256 price;
        uint256 updatedAt;
        uint256 uiMul;
        uint256 valueUsd;
        uint256 backingPerToken;
        uint256 valueUsdWrong;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address sgov = vm.envAddress("PROBE_STOCK_TOKEN");
        address feedAddr = vm.envAddress("SGOV_FEED");
        uint256 amount = vm.envUint("PROBE_AMOUNT");
        require(IERC20(sgov).balanceOf(vm.addr(pk)) >= amount, "EOA lacks SGOV");

        (address treasury, address projectToken) = _deploy(pk, sgov, feedAddr, amount);
        _report(treasury, projectToken, sgov, feedAddr);
    }

    function _deploy(uint256 pk, address sgov, address feedAddr, uint256 amount)
        internal
        returns (address treasury, address projectToken)
    {
        address eoa = vm.addr(pk);
        vm.startBroadcast(pk);
        MockERC20 token = new MockERC20("Probe Project", "PROBE", 18);
        token.mint(eoa, 1_000e18); // totalSupply = 1,000 (backing denominator)
        AssetRegistry registry = new AssetRegistry(eoa);
        registry.setAsset(sgov, feedAddr, 259200, 1e12); // staleAfter 3d, min 1e-6
        ProjectTreasury t = new ProjectTreasury(address(token), eoa, 30 days, address(registry));
        IERC20(sgov).approve(address(t), amount);
        t.deposit(sgov, amount);
        vm.stopBroadcast();

        console2.log("=== deployed (mainnet) ===");
        console2.log("projectToken:   ", address(token));
        console2.log("assetRegistry:  ", address(registry));
        console2.log("projectTreasury:", address(t));
        return (address(t), address(token));
    }

    function _report(address treasury, address projectToken, address sgov, address feedAddr) internal view {
        R memory r;
        r.held = ProjectTreasury(treasury).heldBalance(sgov);
        r.supply = IERC20(projectToken).totalSupply();
        r.priceDec = AggregatorV3Interface(feedAddr).decimals();
        (, int256 answer,, uint256 ts,) = AggregatorV3Interface(feedAddr).latestRoundData();
        require(answer > 0, "invalid price");
        r.price = uint256(answer);
        r.updatedAt = ts;
        r.uiMul = IStockToken(sgov).uiMultiplier();

        // BackingLens math (verbatim): assetDec = 18 for stock tokens.
        r.valueUsd = (r.held * r.price * WAD) / (10 ** 18 * 10 ** r.priceDec);
        r.backingPerToken = (r.valueUsd * WAD) / r.supply;
        r.valueUsdWrong = (r.valueUsd * r.uiMul) / WAD; // the double-count we AVOID

        console2.log("=== real inputs ===");
        console2.log("SGOV feed:      ", feedAddr);
        console2.log("feed price (raw):", r.price);
        console2.log("feed decimals:  ", r.priceDec);
        console2.log("feed updatedAt: ", r.updatedAt);
        console2.log("uiMultiplier(): ", r.uiMul);
        console2.log("held SGOV (wei):", r.held);
        console2.log("token supply:   ", r.supply);
        console2.log("=== backing (BackingLens math, 1e18 USD) ===");
        console2.log("totalValueUsd:  ", r.valueUsd);
        console2.log("backingPerToken:", r.backingPerToken);
        console2.log("=== no-double-multiplier proof (rule 7) ===");
        console2.log("CORRECT totalValueUsd (feed price only):     ", r.valueUsd);
        console2.log("WRONG   totalValueUsd (x uiMultiplier again):", r.valueUsdWrong);
        console2.log("We use CORRECT: the feed price already includes uiMultiplier.");
    }
}
