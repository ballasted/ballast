// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

/// @title BallastV1Claim — the $BALLAST v1 -> v2 migration payout, in ETH
///
/// @notice Immutable, no owner, no admin surface at all. Every v1 holder in the
///         2026-09-26 snapshot (block 73,030,228) is entitled to
///         `ethAmount` ETH (sized by their snapshot USD value, converted at the
///         historical ETH/USD price at that exact block — see
///         docs/migration-budget-report.md and data/snapshot/), payable ONLY by
///         permanently burning their v1 holdings to `0x...dEaD`. Partial claims
///         are allowed and scale linearly: burn half your snapshot balance, get
///         half the ETH; burn the rest later, get the rest. Selling v1 after the
///         snapshot means you can never burn your full snapshot balance again,
///         so you can never reach 100% of your entitlement — that's the whole
///         enforcement mechanism, no oracle or off-chain check needed. Buying
///         MORE v1 after the snapshot gets you nothing extra: burning above your
///         snapshot balance is simply not accepted (the contract clamps every
///         claim to what's still owed, and the ETH payout formula is bounded by
///         that same clamp — it can never exceed `ethAmount`).
///
/// @dev The contract never holds v1 at any point — `claim()` transfers straight
///      from the claimer to the dead address, never through this contract.
///      ETH is sent via a fixed Merkle root, so no one (not even the deployer)
///      can add, remove, or change any entry after construction. After
///      `deadline`, anyone may call `sweep()` to send whatever ETH is left
///      (from holders who never claimed) to `sweepTo` — the Safe, for a
///      documented, separate $BALLAST v2 buyback-and-burn. This is the ONLY
///      path ETH can ever leave this contract other than a valid claim.
contract BallastV1Claim is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable v1Token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable deadline;
    /// @notice Where unclaimed ETH goes after `deadline` — the Safe. Fixed at
    ///         construction; this contract has no function that can change it,
    ///         redirect it, or send funds anywhere else.
    address public immutable sweepTo;

    /// @notice Cumulative v1 burned per claimer so far, capped at that
    ///         claimer's own `snapshotBalance` (enforced in `claim`).
    mapping(address => uint256) public burnedOf;

    event Claimed(address indexed account, uint256 v1Burned, uint256 ethPaid, uint256 cumulativeBurned, uint256 snapshotBalance);
    event Swept(address indexed caller, uint256 amount);

    error DeadlineNotYetPassed();
    error DeadlinePassed();
    error AlreadyFullyClaimed();
    error NothingToClaim();
    error InvalidProof();
    error AlreadySwept();
    error EthTransferFailed();
    error ZeroAddress();

    constructor(address v1Token_, bytes32 merkleRoot_, uint256 deadline_, address sweepTo_) {
        if (v1Token_ == address(0) || sweepTo_ == address(0)) revert ZeroAddress();
        v1Token = IERC20(v1Token_);
        merkleRoot = merkleRoot_;
        deadline = deadline_;
        sweepTo = sweepTo_;
    }

    /// @notice Fund the contract. No logic, no bookkeeping — the Safe simply
    ///         sends the total ETH budget here once, ahead of any claims.
    receive() external payable {}

    /// @notice Burn up to `amountV1` of the caller's own v1 holdings (clamped
    ///         to whatever is still unclaimed of `snapshotBalance`) and receive
    ///         the correspondingly-scaled share of `ethAmount`. Callable
    ///         multiple times for partial claims. `snapshotBalance` and
    ///         `ethAmount` are exactly the values this account's Merkle leaf
    ///         was built with (see data/snapshot/v1_claim_merkle.json) — passing
    ///         the wrong pair simply fails the proof, it can never overpay.
    /// @return ethPaid The ETH actually sent to the caller this call.
    function claim(uint256 amountV1, uint256 snapshotBalance, uint256 ethAmount, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256 ethPaid)
    {
        if (block.timestamp >= deadline) revert DeadlinePassed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, snapshotBalance, ethAmount))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 already = burnedOf[msg.sender];
        if (already >= snapshotBalance) revert AlreadyFullyClaimed();

        uint256 remaining = snapshotBalance - already;
        uint256 burnNow = amountV1 > remaining ? remaining : amountV1;
        if (burnNow == 0) revert NothingToClaim();

        uint256 newBurned = already + burnNow;
        burnedOf[msg.sender] = newBurned;

        // Effects before interactions: state is fully updated above before
        // either external call below (the v1 transfer, then the ETH send).
        v1Token.safeTransferFrom(msg.sender, DEAD, burnNow);

        // Linear, monotonic entitlement: paid-so-far is always
        // ethAmount * burned / snapshotBalance, so this call's payout is just
        // the delta between the new and old cumulative entitlement. Both
        // `already` and `newBurned` are <= snapshotBalance by construction
        // above, so this can never exceed `ethAmount` in total across every
        // call a single account makes.
        uint256 oldEntitlement = (ethAmount * already) / snapshotBalance;
        uint256 newEntitlement = (ethAmount * newBurned) / snapshotBalance;
        ethPaid = newEntitlement - oldEntitlement;

        if (ethPaid > 0) {
            (bool ok,) = msg.sender.call{value: ethPaid}("");
            if (!ok) revert EthTransferFailed();
        }

        emit Claimed(msg.sender, burnNow, ethPaid, newBurned, snapshotBalance);
    }

    /// @notice After the deadline, permissionless: send every remaining wei to
    ///         `sweepTo` (the Safe). Reads `address(this).balance` fresh each
    ///         call and no-ops at zero, so calling it again (e.g. after a
    ///         stray top-up) is always safe — there is no separate "already
    ///         swept" flag to get out of sync with the real balance.
    function sweep() external nonReentrant returns (uint256 amount) {
        if (block.timestamp < deadline) revert DeadlineNotYetPassed();
        amount = address(this).balance;
        if (amount == 0) return 0;
        (bool ok,) = sweepTo.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit Swept(msg.sender, amount);
    }
}
