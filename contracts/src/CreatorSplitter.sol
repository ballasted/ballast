// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title CreatorSplitter
/// @notice An add-on that receives ONLY a token's creator bucket and fans it out
///         to up to 4 recipients by fixed bps shares. It is set as the FeeRouter's
///         creator payout address, so the buyback / stakers / parent / treasury
///         buckets keep their existing security model untouched — this contract
///         only ever sees the creator's own share.
/// @dev    No owner, no admin, no upgradeability. Recipients and shares are fixed
///         at construction and can NEVER change (to change them, deploy a new
///         splitter and repoint). Pull-based (OpenZeppelin PaymentSplitter
///         accounting), so one recipient who can't receive ETH can never block the
///         others. Supports native ETH (token == address(0)), WETH and any ERC-20.
///         CEI + reentrancy guard; SafeERC20 for non-standard tokens.
contract CreatorSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 4;
    address internal constant ETH = address(0);

    address[] private _recipients;
    mapping(address => uint16) public shareBps; // recipient => bps (0 = not a recipient)

    // token (address(0) = native ETH) => accounting
    mapping(address => uint256) private _totalReleased;
    mapping(address => mapping(address => uint256)) private _released; // token => recipient => released

    event PaymentReleased(address indexed token, address indexed recipient, uint256 amount);
    event EthReceived(address indexed from, uint256 amount);

    error BadRecipientCount(uint256 n);
    error SharesMustSumToBps(uint256 sum);
    error ZeroAddress();
    error ZeroShare();
    error DuplicateRecipient(address r);
    error NotARecipient(address r);
    error NothingToRelease(address token, address recipient);
    error EthTransferFailed(address recipient);

    constructor(address[] memory recipients_, uint16[] memory sharesBps_) {
        uint256 n = recipients_.length;
        if (n == 0 || n > MAX_RECIPIENTS || sharesBps_.length != n) revert BadRecipientCount(n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address r = recipients_[i];
            uint16 s = sharesBps_[i];
            if (r == address(0)) revert ZeroAddress();
            if (s == 0) revert ZeroShare();
            if (shareBps[r] != 0) revert DuplicateRecipient(r);
            shareBps[r] = s;
            _recipients.push(r);
            sum += s;
        }
        if (sum != BPS) revert SharesMustSumToBps(sum);
    }

    // ── views ──

    function recipients() external view returns (address[] memory) {
        return _recipients;
    }

    function recipientsLength() external view returns (uint256) {
        return _recipients.length;
    }

    function totalReleased(address token) external view returns (uint256) {
        return _totalReleased[token];
    }

    function released(address token, address recipient) external view returns (uint256) {
        return _released[token][recipient];
    }

    /// @notice Total ever received of `token` (address(0) = ETH): the current
    ///         balance plus everything already paid out.
    function totalReceived(address token) public view returns (uint256) {
        uint256 bal = token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
        return bal + _totalReleased[token];
    }

    /// @notice Amount of `token` currently releasable to `recipient`.
    function releasable(address token, address recipient) public view returns (uint256) {
        uint16 s = shareBps[recipient];
        if (s == 0) return 0;
        uint256 owedTotal = (totalReceived(token) * s) / BPS;
        uint256 already = _released[token][recipient];
        return owedTotal > already ? owedTotal - already : 0;
    }

    // ── release (pull-based) ──

    /// @notice Release the caller-chosen `recipient`'s owed share of `token`
    ///         (address(0) = native ETH). Anyone may trigger it; funds only ever go
    ///         to the fixed recipient. Reverts if nothing is owed.
    function release(address token, address recipient) external nonReentrant {
        uint256 amount = _release(token, recipient);
        if (amount == 0) revert NothingToRelease(token, recipient);
    }

    /// @notice Release `token` to every recipient; skips those owed nothing so one
    ///         zero-owed or non-receiving recipient never reverts the batch... except
    ///         a recipient that reverts on ETH receipt (handled per-recipient below).
    function releaseAll(address token) external nonReentrant {
        uint256 n = _recipients.length;
        for (uint256 i; i < n; ++i) {
            _release(token, _recipients[i]);
        }
    }

    function _release(address token, address recipient) internal returns (uint256 amount) {
        if (shareBps[recipient] == 0) revert NotARecipient(recipient);
        amount = releasable(token, recipient);
        if (amount == 0) return 0;

        // Effects before interaction (CEI).
        _released[token][recipient] += amount;
        _totalReleased[token] += amount;

        if (token == ETH) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert EthTransferFailed(recipient);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
        emit PaymentReleased(token, recipient, amount);
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }
}
