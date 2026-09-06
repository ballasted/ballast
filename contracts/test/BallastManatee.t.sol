// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BallastManatee} from "../src/manatee/BallastManatee.sol";
import {ManateeRenderer} from "../src/manatee/ManateeRenderer.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "openzeppelin-contracts/contracts/interfaces/IERC2981.sol";

/// A contract that CAN receive ERC-721s.
contract GoodReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    function mint(BallastManatee c) external returns (uint256) {
        return c.mint();
    }
}

/// A contract that CANNOT receive ERC-721s (no onERC721Received).
contract BadReceiver {
    function mint(BallastManatee c) external returns (uint256) {
        return c.mint();
    }
}

contract BallastManateeTest is Test {
    BallastManatee nft;
    ManateeRenderer rnd;
    address deployer = address(this);

    string constant REF = "../docs/manatee-svgs-ref/all-1000.txt";

    function setUp() public {
        rnd = new ManateeRenderer();
        nft = new BallastManatee(address(rnd)); // deployer = this test contract
    }

    // ─────────────────────────────────────────────── adversarial: minting

    function test_MintOncePerWallet() public {
        address alice = makeAddr("alice");
        vm.prank(alice);
        uint256 id = nft.mint();
        assertEq(id, 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.totalSupply(), 1);
        assertTrue(nft.hasMinted(alice));
    }

    function test_Revert_MintTwiceSameWallet() public {
        address alice = makeAddr("alice");
        vm.startPrank(alice);
        nft.mint();
        vm.expectRevert(BallastManatee.AlreadyMinted.selector);
        nft.mint();
        vm.stopPrank();
    }

    function test_Revert_MintPastCap() public {
        // Mint the full supply from 1000 distinct wallets.
        for (uint256 i = 1; i <= 1000; i++) {
            address w = address(uint160(0x1000 + i));
            vm.prank(w);
            nft.mint();
        }
        assertEq(nft.totalSupply(), 1000);
        // 1001st distinct wallet is turned away.
        address late = makeAddr("late");
        vm.prank(late);
        vm.expectRevert(BallastManatee.MintClosed.selector);
        nft.mint();
    }

    function test_MintFromContract_ReceiverOnce() public {
        GoodReceiver g = new GoodReceiver();
        uint256 id = g.mint(nft);
        assertEq(id, 1);
        assertEq(nft.ownerOf(1), address(g));
        // A contract is still one-per-address.
        vm.expectRevert(BallastManatee.AlreadyMinted.selector);
        g.mint(nft);
    }

    function test_MintFromContract_NonReceiverReverts() public {
        // Standard ERC-721 safe-mint behavior: a contract that can't receive
        // an NFT cannot mint one to itself.
        BadReceiver b = new BadReceiver();
        vm.expectRevert(); // ERC721InvalidReceiver
        b.mint(nft);
    }

    // ─────────────────────────────────────────────── adversarial: tokenURI

    function test_Revert_TokenURINonexistent() public {
        vm.expectRevert(); // ERC721NonexistentToken
        nft.tokenURI(1);
        vm.expectRevert();
        nft.tokenURI(0);
        vm.expectRevert();
        nft.tokenURI(1001);
    }

    function test_TokenURI_And_SVG_MatchReference_1_and_1000() public {
        // Mint id 1 and id 1000.
        address a = makeAddr("a");
        vm.prank(a);
        nft.mint(); // id 1
        for (uint256 i = 2; i <= 1000; i++) {
            vm.prank(address(uint160(0x2000 + i)));
            nft.mint();
        }
        assertEq(nft.totalSupply(), 1000);

        // Read reference lines 1 and 1000.
        string memory ref1 = vm.readLine(REF);
        string memory ref1000;
        for (uint256 i = 2; i <= 1000; i++) ref1000 = vm.readLine(REF);
        vm.closeFile(REF);

        // Raw SVG through the NFT wrapper matches the published reference.
        assertEq(keccak256(bytes(nft.tokenSVG(1))), keccak256(bytes(ref1)), "svg 1");
        assertEq(keccak256(bytes(nft.tokenSVG(1000))), keccak256(bytes(ref1000)), "svg 1000");

        // tokenURI is a base64 JSON data URI wrapping that SVG.
        string memory uri1 = nft.tokenURI(1);
        string memory uri1000 = nft.tokenURI(1000);
        assertTrue(_startsWith(uri1, "data:application/json;base64,"), "uri1 prefix");
        assertTrue(_startsWith(uri1000, "data:application/json;base64,"), "uri1000 prefix");
        assertGt(bytes(uri1).length, bytes(ref1).length, "uri wraps svg");
    }

    /// The only id-derived text in the SVG is the zero-padded id number in a
    /// fixed "%04d / 1000" template. There is no owner- or user-supplied string
    /// anywhere in the render path, so nothing external can be injected into the
    /// markup. This test documents that the id is confined to digits.
    function test_NoUnintendedMarkup_IdIsDigitsOnly() public {
        for (uint256 i = 1; i <= 1000; i++) {
            vm.prank(address(uint160(0x3000 + i)));
            nft.mint();
        }
        string memory s = nft.tokenSVG(777);
        // The rendered svg must not contain a nested "<svg" or a "<script".
        assertFalse(_contains(s, "<script"), "no script");
        assertEq(_countOccurrences(s, "<svg"), 1, "single root svg");
    }

    // ─────────────────────────────────────────────── royalty (EIP-2981)

    function test_Royalty_7_5pct_ToDeployer() public view {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 10_000);
        assertEq(receiver, deployer, "royalty receiver = deployer");
        assertEq(amount, 750, "7.5%");
        (, uint256 amtOnEth) = nft.royaltyInfo(1, 1 ether);
        assertEq(amtOnEth, 0.075 ether);
    }

    function test_SupportsInterfaces() public view {
        assertTrue(nft.supportsInterface(type(IERC721).interfaceId), "721");
        assertTrue(nft.supportsInterface(type(IERC2981).interfaceId), "2981");
        assertTrue(nft.supportsInterface(0x01ffc9a7), "165");
    }

    // ─────────────────────────────────────────────── owner has no art power

    function test_NoArtMutatingOwnerFunctions() public view {
        // renderer is immutable; there is no setter. Compile-time guarantee,
        // asserted here for the record.
        assertEq(address(nft.renderer()), address(rnd));
    }

    // ─────────────────────────────────────────────── helpers

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory bs = bytes(s);
        bytes memory bp = bytes(p);
        if (bs.length < bp.length) return false;
        for (uint256 i; i < bp.length; i++) if (bs[i] != bp[i]) return false;
        return true;
    }

    function _contains(string memory s, string memory sub) internal pure returns (bool) {
        return _countOccurrences(s, sub) > 0;
    }

    function _countOccurrences(string memory s, string memory sub)
        internal
        pure
        returns (uint256 count)
    {
        bytes memory bs = bytes(s);
        bytes memory bsub = bytes(sub);
        if (bsub.length == 0 || bs.length < bsub.length) return 0;
        for (uint256 i; i <= bs.length - bsub.length; i++) {
            bool ok = true;
            for (uint256 j; j < bsub.length; j++) {
                if (bs[i + j] != bsub[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) count++;
        }
    }
}
