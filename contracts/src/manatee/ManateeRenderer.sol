// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";

/// @title ManateeRenderer
/// @notice On-chain deterministic SVG generator for the BALLAST manatee
///         collection. Port of docs/manatee_gen.py — output is byte-for-byte
///         identical to the Python reference for every id 1..1000.
///
/// @dev The Python spec uses IEEE-754 doubles and `format(x, '.Nf')`
///      (round-half-even). Solidity has no floats, so every quantity is carried
///      as an exact rational (num/den in integers) and rendered with the same
///      round-half-even rule in {_fmt}. This was proven equal to the Python
///      float output for all 1000 ids (see docs/_verify_int_model.py and the
///      Foundry test that diffs against docs/manatee-svgs-ref/*.svg).
///
///      Nothing here is owner-mutable or upgradeable. It is a pure function of
///      the token id.
contract ManateeRenderer {
    uint256 internal constant SUPPLY = 1000;
    uint256 internal constant S = 1000;
    uint256 internal constant DEN = 0xFFFFFFFFFFFF; // 2**48 - 1, the Python rng denominator

    string internal constant BONE = "#F5F3EC";
    string internal constant GREEN = "#22C93A";
    string internal constant DIM = "#3C4A3E";

    // The manatee drawing is identical for every id (fixed coords, scale, and
    // stroke widths). Only its two opacities vary, so the geometry is constant.
    string internal constant BODY =
        "M 371.0 500.0 Q 369.8 461.6 405.8 452.9 Q 475.2 436.8 542.2 455.4 Q 576.9 466.5 594.2 485.1 Q 622.8 461.6 653.8 474.0 Q 677.3 500.0 653.8 526.0 Q 622.8 538.4 594.2 514.9 Q 576.9 533.5 542.2 544.6 Q 475.2 563.2 405.8 547.1 Q 369.8 538.4 371.0 500.0 Z";
    string internal constant MTAIL =
        '<path d="M 376.0 511.2 Q 390.9 521.1 409.5 516.1" fill="none" stroke="#F5F3EC" stroke-width="2.24" opacity="0.8"/><path d="M 374.8 503.7 L 365.5 500.6" fill="none" stroke="#F5F3EC" stroke-width="1.70" opacity="0.6"/><path d="M 374.8 509.9 L 364.2 506.8" fill="none" stroke="#F5F3EC" stroke-width="1.70" opacity="0.6"/><path d="M 374.8 516.1 L 366.7 513.0" fill="none" stroke="#F5F3EC" stroke-width="1.70" opacity="0.6"/><circle cx="405.8" cy="485.1" r="3.10" fill="#F5F3EC"/><path d="M 430.6 542.2 Q 425.6 569.4 449.2 574.4 Q 464.0 568.2 461.6 545.9" fill="none" stroke="#F5F3EC" stroke-width="2.89" stroke-linejoin="round"/><path d="M 495.0 545.9 Q 491.3 571.9 514.9 576.9 Q 529.8 570.7 527.3 549.6" fill="none" stroke="#F5F3EC" stroke-width="2.89" stroke-linejoin="round"/>';

    // ─────────────────────────────────────────────────────────── public API

    /// @notice The raw SVG for `id`, computed on read.
    function svg(uint256 id) public pure returns (string memory) {
        require(id >= 1 && id <= SUPPLY, "id");
        uint256 N = id - 1; // 0 at surface, 999 at seabed
        bytes memory out = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">',
            _bg(N),
            _surface(N)
        );
        out = abi.encodePacked(out, _shafts(id, N), _particles(id, N));
        out = abi.encodePacked(out, _seabed(id, N), _manatee(N), _text(id), "</svg>");
        return string(out);
    }

    /// @notice ERC-721 metadata: base64 JSON with an embedded base64 SVG.
    function tokenURI(uint256 id) external pure returns (string memory) {
        string memory image = string(
            abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(svg(id))))
        );
        bytes memory json = abi.encodePacked(
            '{"name":"BALLAST Manatee #',
            Strings.toString(id),
            '","description":"Deeper, not rarer. Generated on-chain from the token id \\u2014 no IPFS, no metadata server. This confers nothing.",',
            '"image":"',
            image,
            '","attributes":',
            _attributes(id),
            "}"
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @notice Trait array, matching the Python `traits` dict.
    function _attributes(uint256 id) internal pure returns (string memory) {
        uint256 N = id - 1;
        uint256 band = 1 + (10 * N) / (SUPPLY - 1);
        if (band > 10) band = 10;
        uint256 shafts = (100 * N < 54945) ? 1 + (_rng(id, "shafts") * 3) / DEN : 0;
        uint256 particles = 6 + (26 * N) / (SUPPLY - 1);
        bool bed = 100 * N > 67932;
        return string(
            abi.encodePacked(
                '[{"trait_type":"Depth band","value":',
                Strings.toString(band),
                '},{"trait_type":"Light shafts","value":',
                Strings.toString(shafts),
                '},{"trait_type":"Particles","value":',
                Strings.toString(particles),
                '},{"trait_type":"Seabed","value":"',
                bed ? "yes" : "no",
                '"}]'
            )
        );
    }

    // ─────────────────────────────────────────────────────── scene sections

    function _bg(uint256 N) internal pure returns (string memory) {
        // water_at(t): int(lerp) truncation, positive so integer division == floor
        uint256 r = uint256(9990 - int256(7 * N)) / (SUPPLY - 1);
        uint256 g = uint256(25974 - int256(20 * N)) / (SUPPLY - 1);
        uint256 b = uint256(13986 - int256(10 * N)) / (SUPPLY - 1);
        return string(
            abi.encodePacked(
                '<rect width="1000" height="1000" fill="#', _hex2(r), _hex2(g), _hex2(b), '"/>'
            )
        );
    }

    function _surface(uint256 N) internal pure returns (string memory) {
        int256 WL = 299700 - 560 * int256(N); // /999
        if (WL <= -59940) return ""; // WL > -60 gate
        int256 D = int256(SUPPLY - 1);

        // waterline path points
        bytes memory pts;
        {
            int256 amp = 8991 - 6 * int256(N); // /999
            for (uint256 i; i < 11; i++) {
                int256 y = (i % 2 == 1) ? (WL + amp) : (WL - amp);
                pts = abi.encodePacked(pts, i == 0 ? "M" : " L", _fmt(int256(i * 100), 1, 0), " ");
                pts = abi.encodePacked(pts, _fmt(y, D, 1));
            }
        }

        // opacities: max(0.06, 0.42*(1-t)) and max(0.04, 0.26*(1-t)); rem = 1000-id
        bytes memory out = abi.encodePacked('<path d="', pts, '" fill="none" stroke="', BONE);
        {
            uint256 rem = (SUPPLY - 1) - N; // 1 - t = (999 - N)/999
            out = abi.encodePacked(out, '" stroke-width="1.6" opacity="', _fmtMax(int256(42 * rem), 99900, 6, 100, 3), '"/>');
            string memory wl = _fmt(WL, D, 1);
            out = abi.encodePacked(out, '<line x1="0" y1="', wl, '" x2="1000" y2="', wl);
            out = abi.encodePacked(out, '" stroke="', BONE, '" stroke-width="1.1" opacity="', _fmtMax(int256(26 * rem), 99900, 4, 100, 3), '"/>');
        }
        return string(out);
    }

    function _shafts(uint256 id, uint256 N) internal pure returns (string memory) {
        if (100 * N >= 54945) return ""; // t < 0.55 gate
        int256 WL = 299700 - 560 * int256(N);
        uint256 count = 1 + (_rng(id, "shafts") * 3) / DEN;
        bytes memory out;
        for (uint256 k; k < count; k++) {
            string memory ks = Strings.toString(k);
            bytes memory seg;
            {
                uint256 vx = _rng(id, string(abi.encodePacked("shaftx", ks)));
                seg = abi.encodePacked('<path d="M', _fmt(int256(90 * DEN + 820 * vx), int256(DEN), 0), " ");
                seg = abi.encodePacked(seg, _fmt(WL, int256(SUPPLY - 1), 0), " l");
            }
            {
                // w = 26 + rng*54
                int256 wNum = int256(26 * DEN + 54 * _rng(id, string(abi.encodePacked("shaftw", ks))));
                seg = abi.encodePacked(seg, _fmt(wNum, int256(DEN), 0), " 0 l");
                seg = abi.encodePacked(seg, _fmt(wNum * 24, int256(DEN * 10), 0), " 1000 l");
                seg = abi.encodePacked(seg, _fmt(-wNum * 16, int256(DEN * 10), 0), ' 0 Z" fill="', BONE, '" opacity="');
            }
            {
                // op = (54945-100N)*(6*DEN+8*vo) / (9990000*DEN)
                int256 opNum = int256((54945 - 100 * N)) * int256(6 * DEN + 8 * _rng(id, string(abi.encodePacked("shafto", ks))));
                seg = abi.encodePacked(seg, _fmt(opNum, int256(9990000 * DEN), 3), '"/>');
            }
            out = abi.encodePacked(out, seg);
        }
        return string(out);
    }

    function _particles(uint256 id, uint256 N) internal pure returns (string memory) {
        uint256 count = 6 + (26 * N) / (SUPPLY - 1);
        bytes memory out;
        for (uint256 k; k < count; k++) {
            string memory ks = Strings.toString(k);
            bytes memory seg = abi.encodePacked('<circle cx="', _fmt(int256(S * _rng(id, string(abi.encodePacked("px", ks)))), int256(DEN), 0));
            seg = abi.encodePacked(seg, '" cy="', _fmt(int256(S * _rng(id, string(abi.encodePacked("py", ks)))), int256(DEN), 0));
            seg = abi.encodePacked(seg, '" r="', _fmt(int256(9 * DEN + 21 * _rng(id, string(abi.encodePacked("pr", ks)))), int256(10 * DEN), 1));
            seg = abi.encodePacked(seg, '" fill="', BONE, '" opacity="', _fmt(int256(10 * DEN + 22 * _rng(id, string(abi.encodePacked("po", ks)))), int256(100 * DEN), 3), '"/>');
            out = abi.encodePacked(out, seg);
        }
        return string(out);
    }

    function _seabed(uint256 id, uint256 N) internal pure returns (string memory) {
        if (100 * N <= 67932) return ""; // t > 0.68 gate
        int256 byNum = 1060 * 31968 - 190 * (int256(100 * N) - 67932); // /31968
        int256 bden = 31968;

        // points: (0,by), i=1..8 (x=125i, y=by+(rng-0.5)*34), (1000,by)
        bytes memory core = abi.encodePacked("M0 ", _fmt(byNum, bden, 0)); // the "M..." polyline (d2)
        for (uint256 i = 1; i <= 8; i++) {
            // y = by + 34*(2v-DEN)/(2*DEN) ; common den = 31968*DEN
            int256 yNum = byNum * int256(DEN)
                + 17 * (2 * int256(_rng(id, string(abi.encodePacked("bed", Strings.toString(i))))) - int256(DEN)) * bden;
            core = abi.encodePacked(core, " L", _fmt(int256(125 * i), 1, 0), " ");
            core = abi.encodePacked(core, _fmt(yNum, bden * int256(DEN), 0));
        }
        core = abi.encodePacked(core, " L1000 ", _fmt(byNum, bden, 0));

        bytes memory out = abi.encodePacked('<path d="', core, ' L1000 1000 L0 1000 Z" fill="', DIM, '" opacity="0.30"/>');
        out = abi.encodePacked(out, '<path d="', core, '" fill="none" stroke="', DIM, '" stroke-width="2" opacity="0.5"/>');
        return string(out);
    }

    function _manatee(uint256 N) internal pure returns (string memory) {
        // stroke_op = (99900-28N)/99900 ; fill_op = (15984-7N)/99900
        string memory strokeOp = _fmt(int256(99900 - 28 * N), 99900, 3);
        string memory fillOp = _fmt(int256(15984 - 7 * N), 99900, 3);
        return string(
            abi.encodePacked(
                '<g opacity="', strokeOp,
                '"><path d="', BODY, '" fill="', GREEN, '" opacity="', fillOp, '"/>',
                '<path d="', BODY,
                '" fill="none" stroke="', BONE, '" stroke-width="3.40" stroke-linejoin="round"/>',
                MTAIL,
                "</g>"
            )
        );
    }

    function _text(uint256 id) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<text x="44" y="960" fill="', BONE,
                '" opacity="0.30" font-family="Liberation Mono, monospace" font-size="19">',
                _pad4(id), " / 1000</text>"
            )
        );
    }

    // ─────────────────────────────────────────────────────────── primitives

    /// @dev First 48 bits of sha256("ballast-manatee-{id}-{salt}") == Python's
    ///      int(hexdigest[:12], 16). The value is the rng numerator over DEN.
    function _rng(uint256 id, string memory salt) internal pure returns (uint256) {
        bytes32 h = sha256(
            abi.encodePacked("ballast-manatee-", Strings.toString(id), "-", salt)
        );
        return uint256(h) >> 208;
    }

    /// @dev Render num/den to `nd` decimals with round-half-even, matching
    ///      Python's `format(float, '.Nf')` (including the leading "-" that
    ///      Python prints for negative values that round to zero).
    function _fmt(int256 num, int256 den, uint8 nd) internal pure returns (string memory) {
        require(den > 0, "den");
        bool neg = num < 0;
        uint256 an = uint256(neg ? -num : num);
        uint256 uden = uint256(den);
        uint256 sn = an * (10 ** uint256(nd));
        uint256 q = sn / uden;
        uint256 rem2 = (sn % uden) * 2;
        if (rem2 > uden || (rem2 == uden && q % 2 == 1)) q += 1;

        bytes memory core;
        if (nd == 0) {
            core = bytes(Strings.toString(q));
        } else {
            bytes memory s = bytes(Strings.toString(q));
            uint256 need = uint256(nd) + 1;
            if (s.length < need) {
                bytes memory pad = new bytes(need - s.length);
                for (uint256 i; i < pad.length; i++) pad[i] = "0";
                s = abi.encodePacked(pad, s);
            }
            uint256 ip = s.length - nd;
            core = abi.encodePacked(_slice(s, 0, ip), ".", _slice(s, ip, s.length));
        }
        return neg ? string(abi.encodePacked("-", core)) : string(core);
    }

    /// @dev _fmt of max(a/aden, f/fden). Ties resolve to the second arg, which
    ///      never affects the value (Python's max on equal values).
    function _fmtMax(int256 a, int256 aden, int256 f, int256 fden, uint8 nd)
        internal
        pure
        returns (string memory)
    {
        // compare a/aden vs f/fden (all positive)
        if (a * fden > f * aden) return _fmt(a, aden, nd);
        return _fmt(f, fden, nd);
    }

    function _slice(bytes memory b, uint256 start, uint256 end)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = b[i];
    }

    function _hex2(uint256 x) internal pure returns (string memory) {
        bytes memory HEXD = "0123456789abcdef";
        bytes memory o = new bytes(2);
        o[0] = HEXD[(x >> 4) & 0xf];
        o[1] = HEXD[x & 0xf];
        return string(o);
    }

    function _pad4(uint256 v) internal pure returns (string memory) {
        bytes memory s = bytes(Strings.toString(v));
        if (s.length >= 4) return string(s);
        bytes memory pad = new bytes(4 - s.length);
        for (uint256 i; i < pad.length; i++) pad[i] = "0";
        return string(abi.encodePacked(pad, s));
    }
}
