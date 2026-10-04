// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";
import {IRobinhoodV4Router, RobinhoodV4} from "./interfaces/IRobinhoodV4Router.sol";
import {IAllowanceTransfer} from "./interfaces/IPermit2.sol";

interface IWETH9Claim {
    function deposit() external payable;
}

/// @title BallastV1Claim — the $BALLAST v1 -> v2 migration payout, ETH or $BALLAST v2
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
///         claim to what's still owed, and the payout formula is bounded by
///         that same clamp — it can never exceed `ethAmount`).
///
///         Each holder picks exactly ONE of two payout paths the FIRST time they
///         claim anything, and is locked to it for every subsequent partial
///         claim (`claimETH` / `claimToken` are mutually exclusive per address):
///           - `claimETH`: the entitlement is paid straight in ETH.
///           - `claimToken`: the entitlement's ETH value is swapped, in the same
///             transaction, into $BALLAST v2 through its live WETH pool (the
///             Ballast hook) and the resulting tokens are sent to the holder.
///             The caller supplies `minOut` (the frontend sources it from a live
///             quote and the chosen slippage, never 0 or 1 — this contract
///             rejects 0 outright). If the swap can't clear `minOut`, the ENTIRE
///             call reverts — including the v1 burn and the `burnedOf` update —
///             so a failed swap never marks any of the claim as used.
///
/// @dev The contract never holds v1 at any point — `claimETH`/`claimToken`
///      transfer straight from the claimer to the dead address, never through
///      this contract. It never holds $BALLAST v2 between transactions either:
///      `claimToken` forwards 100% of what the swap just produced, in the same
///      call, before returning. ETH is sent via a fixed Merkle root, so no one
///      (not even the deployer) can add, remove, or change any entry after
///      construction. After `deadline`, anyone may call `sweep()` to send
///      whatever ETH is left (from holders who never claimed, or who claimed
///      less than their full entitlement) to `sweepTo` — the Safe, for a
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

    // ── claimToken swap infra, all fixed at construction ────────────────────
    address public immutable ballastV2;
    address public immutable weth;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable hook;

    enum ClaimPath {
        None,
        Eth,
        Token
    }

    /// @notice Cumulative v1 burned per claimer so far, capped at that
    ///         claimer's own `snapshotBalance` (enforced in claimETH/claimToken).
    mapping(address => uint256) public burnedOf;
    /// @notice The payout path a claimer locked in on their first claim.
    ///         Immutable per-address thereafter — see `_lockPath`.
    mapping(address => ClaimPath) public pathOf;

    event Claimed(address indexed account, uint256 v1Burned, uint256 ethPaid, uint256 cumulativeBurned, uint256 snapshotBalance);
    event ClaimedToken(
        address indexed account,
        uint256 v1Burned,
        uint256 ethSwapped,
        uint256 tokensOut,
        uint256 cumulativeBurned,
        uint256 snapshotBalance
    );
    event Swept(address indexed caller, uint256 amount);

    error DeadlineNotYetPassed();
    error DeadlinePassed();
    error SwapDeadlineExpired();
    error AlreadyFullyClaimed();
    error NothingToClaim();
    error InvalidProof();
    error WrongPath();
    error MinOutTooLow();
    error InsufficientOutput();
    error EthTransferFailed();
    error ZeroAddress();

    constructor(
        address v1Token_,
        bytes32 merkleRoot_,
        uint256 deadline_,
        address sweepTo_,
        address ballastV2_,
        address weth_,
        address universalRouter_,
        address permit2_,
        address hook_
    ) {
        if (
            v1Token_ == address(0) || sweepTo_ == address(0) || ballastV2_ == address(0) || weth_ == address(0)
                || universalRouter_ == address(0) || permit2_ == address(0) || hook_ == address(0)
        ) revert ZeroAddress();
        v1Token = IERC20(v1Token_);
        merkleRoot = merkleRoot_;
        deadline = deadline_;
        sweepTo = sweepTo_;
        ballastV2 = ballastV2_;
        weth = weth_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        hook = hook_;
    }

    /// @notice Fund the contract. No logic, no bookkeeping — the Safe simply
    ///         sends the total ETH budget here once, ahead of any claims.
    receive() external payable {}

    /// @dev First claim of any kind locks `account` into `path` forever; every
    ///      later claim (by either function) must match it. This is the entire
    ///      "one path per holder" enforcement — a plain mapping, checked before
    ///      any external call in either claim function.
    function _lockPath(address account, ClaimPath path) private {
        ClaimPath existing = pathOf[account];
        if (existing == ClaimPath.None) {
            pathOf[account] = path;
        } else if (existing != path) {
            revert WrongPath();
        }
    }

    /// @dev Shared accounting for both claim functions: verifies the Merkle
    ///      leaf, clamps the burn to what's still owed, updates `burnedOf`, and
    ///      burns the v1 tokens. Returns the ETH value of this call's share of
    ///      the entitlement — `claimETH` pays it directly, `claimToken` swaps
    ///      it. Reverts (and so undoes nothing, since nothing has happened yet)
    ///      on a bad proof, an already-fully-claimed account, or a zero burn.
    function _accrue(uint256 amountV1, uint256 snapshotBalance, uint256 ethAmount, bytes32[] calldata proof, ClaimPath path)
        private
        returns (uint256 burnNow, uint256 ethShare)
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, snapshotBalance, ethAmount))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 already = burnedOf[msg.sender];
        if (already >= snapshotBalance) revert AlreadyFullyClaimed();

        _lockPath(msg.sender, path);

        uint256 remaining = snapshotBalance - already;
        burnNow = amountV1 > remaining ? remaining : amountV1;
        if (burnNow == 0) revert NothingToClaim();

        uint256 newBurned = already + burnNow;
        burnedOf[msg.sender] = newBurned;

        // Effects before interactions: state is fully updated above before the
        // v1 burn below, or anything either caller does afterward.
        v1Token.safeTransferFrom(msg.sender, DEAD, burnNow);

        // Linear, monotonic entitlement: paid-so-far is always
        // ethAmount * burned / snapshotBalance, so this call's share is just
        // the delta between the new and old cumulative entitlement. Both
        // `already` and `newBurned` are <= snapshotBalance by construction
        // above, so this can never exceed `ethAmount` in total across every
        // call a single account makes, on either path.
        uint256 oldEntitlement = (ethAmount * already) / snapshotBalance;
        uint256 newEntitlement = (ethAmount * newBurned) / snapshotBalance;
        ethShare = newEntitlement - oldEntitlement;
    }

    /// @notice Burn up to `amountV1` of the caller's own v1 holdings (clamped
    ///         to whatever is still unclaimed of `snapshotBalance`) and receive
    ///         the correspondingly-scaled share of `ethAmount`, in ETH.
    ///         Callable multiple times for partial claims. Locks the caller to
    ///         the ETH path forever (see `_lockPath`).
    /// @return ethPaid The ETH actually sent to the caller this call.
    function claimETH(uint256 amountV1, uint256 snapshotBalance, uint256 ethAmount, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256 ethPaid)
    {
        if (block.timestamp >= deadline) revert DeadlinePassed();

        uint256 burnNow;
        (burnNow, ethPaid) = _accrue(amountV1, snapshotBalance, ethAmount, proof, ClaimPath.Eth);

        if (ethPaid > 0) {
            (bool ok,) = msg.sender.call{value: ethPaid}("");
            if (!ok) revert EthTransferFailed();
        }

        emit Claimed(msg.sender, burnNow, ethPaid, burnedOf[msg.sender], snapshotBalance);
    }

    /// @notice Same entitlement mechanics as `claimETH`, but the ETH share is
    ///         swapped in this same transaction into $BALLAST v2 (through its
    ///         WETH pool, via the Ballast hook) and the resulting tokens are
    ///         sent to the caller. Locks the caller to the token path forever.
    /// @param minOut The minimum $BALLAST v2 to accept — sourced by the caller
    ///        from a live quote and their chosen slippage. Must be > 0: this
    ///        contract refuses to let a holder's entitlement go through with no
    ///        floor at all. If the swap can't clear it, this whole call
    ///        reverts and NOTHING is marked claimed (the v1 burn and
    ///        `burnedOf` update revert along with it).
    /// @param swapDeadline A timestamp deadline for the swap leg (this chain
    ///        has ~100ms blocks — use time, never a block number).
    /// @return tokensOut The $BALLAST v2 actually sent to the caller this call.
    function claimToken(
        uint256 amountV1,
        uint256 snapshotBalance,
        uint256 ethAmount,
        bytes32[] calldata proof,
        uint256 minOut,
        uint256 swapDeadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp >= deadline) revert DeadlinePassed();
        if (minOut == 0) revert MinOutTooLow();

        uint256 burnNow;
        uint256 ethToSwap;
        (burnNow, ethToSwap) = _accrue(amountV1, snapshotBalance, ethAmount, proof, ClaimPath.Token);

        if (ethToSwap > 0) {
            tokensOut = _swapEthForBallastV2(ethToSwap, minOut, swapDeadline);
            IERC20(ballastV2).safeTransfer(msg.sender, tokensOut);
        }

        emit ClaimedToken(msg.sender, burnNow, ethToSwap, tokensOut, burnedOf[msg.sender], snapshotBalance);
    }

    /// @dev Wraps `ethIn` to WETH, swaps it for $BALLAST v2 through the fixed
    ///      UniversalRouter fork (the same leg-2 encoding BallastRouter v1
    ///      proved against a live pool — see IRobinhoodV4Router.sol), and
    ///      returns exactly what the pool paid out (a real balance delta, never
    ///      a declared amount). The Permit2 allowance is exact and reset to
    ///      zero immediately after use — no standing approval survives this
    ///      call. Reverts (undoing everything in this transaction, including
    ///      the v1 burn already recorded by the caller) if the swap's deadline
    ///      has passed or its output is below `minOut`.
    function _swapEthForBallastV2(uint256 ethIn, uint256 minOut, uint256 swapDeadline) private returns (uint256 out) {
        if (block.timestamp > swapDeadline) revert SwapDeadlineExpired();

        IWETH9Claim(weth).deposit{value: ethIn}();

        bool wethIsCurrency0 = weth < ballastV2;
        RobinhoodV4.PoolKey memory key = RobinhoodV4.PoolKey({
            currency0: wethIsCurrency0 ? weth : ballastV2,
            currency1: wethIsCurrency0 ? ballastV2 : weth,
            fee: 0,
            tickSpacing: 60,
            hooks: hook
        });

        IERC20(weth).forceApprove(permit2, ethIn);
        IAllowanceTransfer(permit2).approve(weth, universalRouter, uint160(ethIn), uint48(swapDeadline));

        RobinhoodV4.ExactInputSingleParams memory params = RobinhoodV4.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: wethIsCurrency0,
            amountIn: uint128(ethIn),
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: ""
        });

        bytes memory actions = abi.encodePacked(
            RobinhoodV4.ACT_SWAP_EXACT_IN_SINGLE, RobinhoodV4.ACT_SETTLE_ALL, RobinhoodV4.ACT_TAKE_ALL
        );
        bytes[] memory v4Params = new bytes[](3);
        v4Params[0] = abi.encode(params);
        v4Params[1] = abi.encode(weth, ethIn);
        v4Params[2] = abi.encode(ballastV2, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, v4Params);
        bytes memory commands = abi.encodePacked(RobinhoodV4.CMD_V4_SWAP);

        uint256 before = IERC20(ballastV2).balanceOf(address(this));
        IRobinhoodV4Router(universalRouter).execute(commands, inputs, swapDeadline);
        out = IERC20(ballastV2).balanceOf(address(this)) - before;

        // Exact-approval hygiene: reset immediately, never leave a standing
        // allowance for either Permit2 itself or the router-as-spender.
        IAllowanceTransfer(permit2).approve(weth, universalRouter, 0, 0);
        IERC20(weth).forceApprove(permit2, 0);

        if (out < minOut) revert InsufficientOutput();
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
