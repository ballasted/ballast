// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ManateeRenderer} from "../src/manatee/ManateeRenderer.sol";

contract ManateeRendererTest is Test {
    ManateeRenderer r;

    // Path is relative to the foundry project root (contracts/).
    string constant REF = "../docs/manatee-svgs-ref/all-1000.txt";

    function setUp() public {
        r = new ManateeRenderer();
    }

    /// Byte-for-byte comparison of the on-chain SVG against the Python
    /// reference for EVERY id 1..1000.
    function test_ByteForByte_All1000() public {
        for (uint256 id = 1; id <= 1000; id++) {
            string memory expected = vm.readLine(REF);
            string memory got = r.svg(id);
            if (keccak256(bytes(got)) != keccak256(bytes(expected))) {
                emit log_named_uint("MISMATCH id", id);
                _firstDiff(expected, got);
                emit log_named_string("expected", expected);
                emit log_named_string("got     ", got);
                fail();
                return;
            }
        }
        vm.closeFile(REF);
    }

    function _firstDiff(string memory a, string memory b) internal {
        bytes memory ba = bytes(a);
        bytes memory bb = bytes(b);
        uint256 n = ba.length < bb.length ? ba.length : bb.length;
        for (uint256 i; i < n; i++) {
            if (ba[i] != bb[i]) {
                emit log_named_uint("first diff at offset", i);
                emit log_named_uint("expected len", ba.length);
                emit log_named_uint("got len", bb.length);
                return;
            }
        }
        emit log_named_uint("common prefix equal; lengths differ; min len", n);
        emit log_named_uint("expected len", ba.length);
        emit log_named_uint("got len", bb.length);
    }

    /// Gas for tokenURI() across a depth spread (what OpenSea / indexers pay).
    function test_Gas_tokenURI() public view {
        uint256[6] memory ids = [uint256(1), uint256(2), uint256(500), uint256(840), uint256(950), uint256(1000)];
        for (uint256 i; i < ids.length; i++) {
            uint256 g0 = gasleft();
            string memory uri = r.tokenURI(ids[i]);
            uint256 used = g0 - gasleft();
            console.log("tokenURI id", ids[i]);
            console.log("  uri bytes", bytes(uri).length);
            console.log("  gas used ", used);
        }
    }

    /// Gas for svg() alone, worst case (deepest id -> largest SVG).
    function test_Gas_svg_worst() public view {
        uint256 g0 = gasleft();
        string memory s = r.svg(1000);
        uint256 used = g0 - gasleft();
        console.log("svg(1000) bytes", bytes(s).length);
        console.log("svg(1000) gas  ", used);
    }
}
