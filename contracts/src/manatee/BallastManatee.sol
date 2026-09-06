// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "openzeppelin-contracts/contracts/token/common/ERC2981.sol";
import {Ownable, Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";

interface IManateeRenderer {
    function tokenURI(uint256 id) external view returns (string memory);
    function svg(uint256 id) external view returns (string memory);
}

/// @title BALLAST Manatee
/// @notice A 1,000-piece, free (gas-only), one-per-wallet ERC-721. The art is
///         generated on-chain from the token id by an immutable renderer — no
///         IPFS, no metadata server. Every manatee is the same drawing; only
///         the depth changes. Nothing is rarer than anything else.
///
/// @dev Confers nothing: no revenue share, no governance, no airdrop, no
///      allocation. The owner (the deployer EOA, the same key as the rest of
///      BALLAST) has NO function that changes what a minted token looks like:
///      the renderer is immutable, there is no baseURI/reveal, no upgrade path,
///      no proxy, no pause, no blocklist. What's minted is final.
contract BallastManatee is ERC721, ERC2981, Ownable2Step {
    /// @notice Hard cap. Token ids run 1..1000, assigned in mint order.
    uint256 public constant MAX_SUPPLY = 1000;
    /// @notice EIP-2981 royalty: 7.5% (750 / 10000).
    uint96 public constant ROYALTY_BPS = 750;

    /// @notice The immutable on-chain SVG generator. Cannot be changed.
    IManateeRenderer public immutable renderer;

    /// @notice Number minted so far; also the id of the most recent mint.
    uint256 public totalSupply;
    /// @notice One mint per address, ever.
    mapping(address => bool) public hasMinted;

    error MintClosed();
    error AlreadyMinted();

    event Minted(address indexed to, uint256 indexed tokenId);

    /// @param renderer_ Deployed {ManateeRenderer}. Set once, immutable.
    constructor(address renderer_)
        ERC721("BALLAST Manatee", "MANATEE")
        Ownable(msg.sender)
    {
        renderer = IManateeRenderer(renderer_);
        // Royalty receiver is the deployer EOA, disclosed as such. Fixed at
        // deploy — there is no setter.
        _setDefaultRoyalty(msg.sender, ROYALTY_BPS);
    }

    /// @notice Mint one manatee to the caller. Free (gas only), one per wallet,
    ///         capped at {MAX_SUPPLY}. No payment, no allowlist, no phases.
    function mint() external returns (uint256 tokenId) {
        if (totalSupply >= MAX_SUPPLY) revert MintClosed();
        if (hasMinted[msg.sender]) revert AlreadyMinted();

        hasMinted[msg.sender] = true;
        tokenId = ++totalSupply; // 1..1000
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId);
    }

    /// @notice On-chain metadata (base64 JSON + embedded base64 SVG), computed
    ///         on read by the immutable renderer. Reverts for nonexistent ids.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return renderer.tokenURI(id);
    }

    /// @notice The raw SVG for a minted `id`. Convenience for the mint page.
    function tokenSVG(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return renderer.svg(id);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
