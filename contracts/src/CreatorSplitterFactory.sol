// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreatorSplitter} from "./CreatorSplitter.sol";

/// @title CreatorSplitterFactory
/// @notice Deploys immutable, ownerless CreatorSplitter instances. Stateless apart
///         from a write-once `isSplitter` flag so other contracts and the UI can
///         cheaply verify a splitter actually came from this factory (same spirit
///         as BallastFactory.launchIdOf). No owner, no admin.
contract CreatorSplitterFactory {
    mapping(address => bool) public isSplitter;
    mapping(address => address) public creatorOf; // splitter => the wallet that created it

    event CreatorSplitterCreated(
        address indexed splitter, address indexed creator, address[] recipients, uint16[] sharesBps
    );

    /// @notice Deploy a CreatorSplitter with the given fixed recipients + bps shares
    ///         (validated in the CreatorSplitter constructor: 1..4 recipients, no
    ///         zero address/share, no duplicates, shares sum to 10_000).
    function create(address[] calldata recipients, uint16[] calldata sharesBps)
        external
        returns (CreatorSplitter splitter)
    {
        splitter = new CreatorSplitter(recipients, sharesBps);
        isSplitter[address(splitter)] = true;
        creatorOf[address(splitter)] = msg.sender;
        emit CreatorSplitterCreated(address(splitter), msg.sender, recipients, sharesBps);
    }
}
