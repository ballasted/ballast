// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";

/// @title MetadataDenylist
/// @notice Owner-managed, DEFAULT-ALLOW denylist of token addresses whose
///         project-supplied metadata (name, logo, description, links) the BALLAST
///         interface will refuse to render under its own origin.
///
///         This is a DISPLAY takedown, not a takedown of anything on-chain. A
///         denylisted token stays listed by ticker and contract address; its raw
///         metadataURI remains fully readable on-chain by anyone. All that changes
///         is that we stop serving the project's self-declared branding under
///         ballasted.xyz. It exists for one purpose: to stop us hosting
///         impersonation / phishing / deceptive branding — the thing Google Safe
///         Browsing's deceptive-content category catches, and the thing render-time
///         URL validation cannot prevent (a token's metadataURI is a free launch()
///         parameter, so anyone can pin impersonation branding and launch it).
///
/// @dev The public record is the point. Every change emits an event carrying the
///      reason and block timestamp, so the fact and grounds of every suppression
///      are public and cannot be quietly rewritten — the docs page only mirrors
///      what the chain already proves. The interface is deliberately minimal so it
///      never needs a breaking redeploy. It holds no funds, prices nothing, and
///      controls no other contract: it only answers "should the UI withhold this
///      token's metadata, and why". Ownership is Ownable2Step so it can move to the
///      Safe alongside AssetRegistry and FeeConfig.
contract MetadataDenylist is Ownable2Step {
    struct Entry {
        bool denied;
        uint64 updatedAt; // block timestamp of the last change
        string reason; // human-readable grounds, always set
    }

    mapping(address token => Entry) private _entries;
    // Every token ever touched (kept even after it is un-denied, so the list is a
    // stable index of what has ever been acted on). `deniedTokens()` filters to the
    // currently-denied subset.
    address[] private _list;
    mapping(address token => uint256 indexPlusOne) private _listIndex;

    event MetadataDenied(address indexed token, bool denied, string reason, uint64 at);

    error ZeroAddress();
    error ReasonRequired();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Set or clear the denied state for a token, with a public reason. A
    ///         reason is REQUIRED even when clearing (e.g. "reinstated after review"),
    ///         so the on-chain record always states why an action was taken.
    function setDenied(address token, bool denied_, string calldata reason) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (bytes(reason).length == 0) revert ReasonRequired();

        Entry storage e = _entries[token];
        e.denied = denied_;
        e.updatedAt = uint64(block.timestamp);
        e.reason = reason;

        if (_listIndex[token] == 0) {
            _list.push(token);
            _listIndex[token] = _list.length; // index + 1
        }
        emit MetadataDenied(token, denied_, reason, uint64(block.timestamp));
    }

    /// @notice Is this token's metadata currently withheld by the interface?
    function isDenied(address token) external view returns (bool) {
        return _entries[token].denied;
    }

    /// @notice Full current record for a token: state, when it last changed, and why.
    function entryOf(address token)
        external
        view
        returns (bool denied, uint64 updatedAt, string memory reason)
    {
        Entry storage e = _entries[token];
        return (e.denied, e.updatedAt, e.reason);
    }

    /// @notice Every token CURRENTLY denied — read by the UI to suppress metadata and
    ///         by the docs page to publish the record.
    function deniedTokens() external view returns (address[] memory tokens) {
        uint256 n = _deniedCount();
        tokens = new address[](n);
        uint256 j;
        uint256 len = _list.length;
        for (uint256 i; i < len; ++i) {
            address t = _list[i];
            if (_entries[t].denied) tokens[j++] = t;
        }
    }

    /// @notice Count of currently-denied tokens.
    function deniedCount() external view returns (uint256) {
        return _deniedCount();
    }

    function _deniedCount() internal view returns (uint256 n) {
        uint256 len = _list.length;
        for (uint256 i; i < len; ++i) {
            if (_entries[_list[i]].denied) ++n;
        }
    }
}
