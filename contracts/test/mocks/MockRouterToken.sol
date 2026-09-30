// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal stand-in for BallastToken's creator/treasury/setMetadataURI
///         surface (the real contract is exercised elsewhere — see
///         BallastFactory.t.sol / ProjectTreasury.t.sol). FeeRouter only ever reads
///         these three members, so that's all this implements.
contract MockRouterToken is ERC20 {
    address public immutable creator;
    address public treasury;
    bool internal _treasurySet;
    string public metadataURI;

    error OnlyCreator();
    error AlreadySet();

    constructor(address creator_) ERC20("Mock Router Token", "MRT") {
        creator = creator_;
        _mint(msg.sender, 1_000_000_000e18);
    }

    function setTreasury(address treasury_) external {
        if (_treasurySet) revert AlreadySet();
        treasury = treasury_;
        _treasurySet = true;
    }

    function setMetadataURI(string calldata newURI) external {
        if (msg.sender != creator) revert OnlyCreator();
        metadataURI = newURI;
    }
}
