// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ProtocolFeeSink} from "../src/ProtocolFeeSink.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {NoReturnERC20} from "./mocks/NoReturnERC20.sol";

contract ProtocolFeeSinkTest is Test {
    ProtocolFeeSink sink;
    AssetRegistry registry;
    MockERC20 weth;
    MockERC20 nvda; // AssetRegistry-listed stock token
    MockERC20 launchedToken; // NOT listed — the "other side" of a launch pool
    MockERC20 ballast; // $BALLAST stand-in — also NOT listed, same bucket as launchedToken

    address safe = makeAddr("safe");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        weth = new MockERC20("Wrapped ETH", "WETH", 18);
        nvda = new MockERC20("NVDA", "NVDA", 18);
        launchedToken = new MockERC20("SomeLaunch", "LAUNCH", 18);
        ballast = new MockERC20("BALLAST", "BALLAST", 18);

        registry = new AssetRegistry(address(this));
        registry.setAsset(address(nvda), makeAddr("nvdaFeed"), 3600, 1);

        sink = new ProtocolFeeSink(address(weth), safe, address(registry));
    }

    // --------------------------------------------------------------------- //
    //  Constructor                                                           //
    // --------------------------------------------------------------------- //

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(ProtocolFeeSink.ZeroAddress.selector);
        new ProtocolFeeSink(address(0), safe, address(registry));
        vm.expectRevert(ProtocolFeeSink.ZeroAddress.selector);
        new ProtocolFeeSink(address(weth), address(0), address(registry));
        vm.expectRevert(ProtocolFeeSink.ZeroAddress.selector);
        new ProtocolFeeSink(address(weth), safe, address(0));
    }

    // --------------------------------------------------------------------- //
    //  Explicit per-token routing — "never burn WETH/stock tokens/$BALLAST   //
    //  by mistake": each gets its own dedicated test proving EXACTLY what    //
    //  happens, no ambiguity left implicit.                                  //
    // --------------------------------------------------------------------- //

    function test_flush_weth_goesToSafe_neverBurned() public {
        weth.mint(address(sink), 5 ether);
        (uint256 amount, address dest, bool burned) = sink.flush(address(weth));
        assertEq(amount, 5 ether);
        assertEq(dest, safe);
        assertFalse(burned, "WETH must never be burned");
        assertEq(weth.balanceOf(safe), 5 ether);
        assertEq(weth.balanceOf(DEAD), 0);
    }

    function test_flush_assetRegistryListedStockToken_goesToSafe_neverBurned() public {
        nvda.mint(address(sink), 3 ether);
        (uint256 amount, address dest, bool burned) = sink.flush(address(nvda));
        assertEq(amount, 3 ether);
        assertEq(dest, safe);
        assertFalse(burned, "an AssetRegistry-listed stock token must never be burned");
        assertEq(nvda.balanceOf(safe), 3 ether);
        assertEq(nvda.balanceOf(DEAD), 0);
    }

    /// @notice $BALLAST is neither WETH nor AssetRegistry-listed (the registry
    ///         only ever lists treasury-eligible STOCK tokens, never the
    ///         protocol's own token) — so it falls in the same bucket as any
    ///         launched token and is burned. This is the literal consequence
    ///         of the two-bucket rule as specified; it also matches the
    ///         existing BuybackBurnerV2 philosophy of intentionally burning
    ///         $BALLAST. Flagged explicitly in the report in case the intent
    ///         was actually "protect $BALLAST from the burn bucket" instead.
    function test_flush_ballast_isBurned_perLiteralTwoBucketRule() public {
        ballast.mint(address(sink), 10 ether);
        (uint256 amount, address dest, bool burned) = sink.flush(address(ballast));
        assertEq(amount, 10 ether);
        assertEq(dest, DEAD);
        assertTrue(burned);
        assertEq(ballast.balanceOf(DEAD), 10 ether);
        assertEq(ballast.balanceOf(safe), 0);
    }

    function test_flush_launchedToken_isBurned() public {
        launchedToken.mint(address(sink), 777 ether);
        (uint256 amount, address dest, bool burned) = sink.flush(address(launchedToken));
        assertEq(amount, 777 ether);
        assertEq(dest, DEAD);
        assertTrue(burned);
        assertEq(launchedToken.balanceOf(DEAD), 777 ether);
    }

    function test_flush_unlistedRandomToken_isBurned() public {
        MockERC20 random = new MockERC20("Random", "RND", 6);
        random.mint(address(sink), 42e6);
        (, address dest, bool burned) = sink.flush(address(random));
        assertEq(dest, DEAD);
        assertTrue(burned);
    }

    function test_flush_noReturnValueToken_works() public {
        NoReturnERC20 usdtLike = new NoReturnERC20();
        usdtLike.mint(address(sink), 100 ether);
        sink.flush(address(usdtLike));
        assertEq(usdtLike.balanceOf(DEAD), 100 ether);
    }

    function test_flush_removedFromRegistry_fallsBackToBurn() public {
        nvda.mint(address(sink), 1 ether);
        registry.removeAsset(address(nvda));
        (, address dest, bool burned) = sink.flush(address(nvda));
        assertEq(dest, DEAD);
        assertTrue(burned, "a de-listed asset is no longer protected from the burn bucket");
    }

    function test_flush_zeroBalance_reverts() public {
        vm.expectRevert(ProtocolFeeSink.NothingToFlush.selector);
        sink.flush(address(weth));
    }

    function test_flush_permissionless() public {
        weth.mint(address(sink), 1 ether);
        vm.prank(makeAddr("stranger"));
        sink.flush(address(weth));
        assertEq(weth.balanceOf(safe), 1 ether);
    }

    function test_flush_emitsEvent() public {
        weth.mint(address(sink), 1 ether);
        vm.expectEmit(true, true, false, true, address(sink));
        emit ProtocolFeeSink.Flushed(address(weth), 1 ether, safe, false);
        sink.flush(address(weth));
    }

    // --------------------------------------------------------------------- //
    //  Fuzz                                                                 //
    // --------------------------------------------------------------------- //

    function testFuzz_flush_wethOrListed_alwaysSafe_neverBurned(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        nvda.mint(address(sink), amount);
        (, address dest, bool burned) = sink.flush(address(nvda));
        assertEq(dest, safe);
        assertFalse(burned);
    }

    function testFuzz_flush_unlisted_alwaysBurned(uint256 amount, address tokenSeed) public {
        amount = bound(amount, 1, 1e30);
        vm.assume(tokenSeed != address(weth) && tokenSeed != address(nvda));
        MockERC20 token = new MockERC20("Fuzz", "FZZ", 18);
        token.mint(address(sink), amount);
        (uint256 flushed, address dest, bool burned) = sink.flush(address(token));
        assertEq(flushed, amount);
        assertEq(dest, DEAD);
        assertTrue(burned);
    }

    // --------------------------------------------------------------------- //
    //  ABI surface — no owner/admin/pause/rescue/sweep selector             //
    // --------------------------------------------------------------------- //

    function test_abiSurface_noOwnerOrAdminOrRescueFunction() public {
        string memory json = vm.readFile("out/ProtocolFeeSink.sol/ProtocolFeeSink.json");
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        assertGt(sigs.length, 0, "methodIdentifiers must be non-empty");

        string[] memory forbidden = new string[](13);
        forbidden[0] = "owner";
        forbidden[1] = "admin";
        forbidden[2] = "pause";
        forbidden[3] = "unpause";
        forbidden[4] = "rescue";
        forbidden[5] = "sweep";
        forbidden[6] = "setOwner";
        forbidden[7] = "transferOwnership";
        forbidden[8] = "renounceOwnership";
        forbidden[9] = "emergencyWithdraw";
        forbidden[10] = "withdrawAll";
        forbidden[11] = "upgradeTo";
        forbidden[12] = "setFeeReceiver";

        for (uint256 i = 0; i < sigs.length; i++) {
            for (uint256 j = 0; j < forbidden.length; j++) {
                assertFalse(_contains(sigs[i], forbidden[j]), string.concat("forbidden function present: ", sigs[i]));
            }
        }
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}

// --------------------------------------------------------------------- //
//  Stateful invariant: random mint-then-flush sequences across many      //
//  tokens, balance must be zero after every single flush call.           //
// --------------------------------------------------------------------- //

contract ProtocolFeeSinkHandler is Test {
    ProtocolFeeSink public sink;
    MockERC20[] public tokens;
    uint256 public flushes;

    constructor(ProtocolFeeSink sink_, MockERC20[] memory tokens_) {
        sink = sink_;
        tokens = tokens_;
    }

    function mintAndFlush(uint256 tokenSeed, uint256 amountSeed) external {
        MockERC20 token = tokens[tokenSeed % tokens.length];
        uint256 amount = bound(amountSeed, 1, 1e24);
        token.mint(address(sink), amount);
        sink.flush(address(token));
        flushes++;
    }
}

contract ProtocolFeeSinkInvariantTest is Test {
    ProtocolFeeSink sink;
    ProtocolFeeSinkHandler handler;
    MockERC20[] tokens;

    function setUp() public {
        MockERC20 weth = new MockERC20("WETH", "WETH", 18);
        AssetRegistry registry = new AssetRegistry(address(this));
        MockERC20 nvda = new MockERC20("NVDA", "NVDA", 18);
        registry.setAsset(address(nvda), makeAddr("feed"), 3600, 1);
        MockERC20 launched = new MockERC20("LAUNCH", "LAUNCH", 18);
        MockERC20 ballast = new MockERC20("BALLAST", "BALLAST", 18);

        sink = new ProtocolFeeSink(address(weth), makeAddr("safe"), address(registry));
        tokens = [weth, nvda, launched, ballast];

        handler = new ProtocolFeeSinkHandler(sink, tokens);
        targetContract(address(handler));
    }

    function invariant_sinkBalanceIsZeroAfterEveryFlush() public view {
        for (uint256 i; i < tokens.length; i++) {
            assertEq(tokens[i].balanceOf(address(sink)), 0);
        }
    }
}
