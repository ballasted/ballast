// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";

/// @title ProjectTreasury
/// @notice Holds a project's on-chain "ballast" — a treasury of tokenized
///         real-world assets whose value is displayed as backing per token.
///
/// @dev THIS CONTRACT CREATES NO CLAIM. Holding the project token gives no
///      redemption right or entitlement to anything held here. This is disclosure,
///      not a financial product. The following invariants keep it that way and are
///      enforced in code, not comments:
///
///        - `noticePeriod` is immutable. A creator cannot advertise a long notice
///          to earn trust and quietly shorten it. This is the single most important
///          invariant in the system.
///        - Creators may withdraw ONLY what they themselves deposited, and only
///          after announcing publicly and waiting `noticePeriod`.
///        - Third-party deposits are permanently locked. No function — not even
///          onlyCreator — can move them out. This stops the "public funds the
///          treasury, creator drains it" pipeline.
///        - Self-backing is impossible: the project token can never be deposited.
///        - No fee is taken on deposits or AUM, and depositors receive nothing in
///          return — no tokens, points, or claim. Any such reward would convert a
///          deposit into an investment contract.
contract ProjectTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --------------------------------------------------------------------- //
    //  Immutable configuration                                              //
    // --------------------------------------------------------------------- //

    /// @notice Delay a creator must wait between announcing and executing a
    ///         withdrawal. LOCKED AT DEPLOY — never make this mutable.
    uint256 public immutable noticePeriod;

    /// @notice The project's own token. Used to block self-backing.
    address public immutable projectToken;

    /// @notice The only address allowed to make withdrawable (creator) deposits
    ///         and to run the withdrawal lifecycle.
    address public immutable creator;

    /// @notice Global allowlist + pricing config. Assets are validated against
    ///         this at deposit time.
    IAssetRegistry public immutable registry;

    /// @notice Window a creator has to accept or decline a third-party proposal
    ///         before it can be reclaimed by the depositor.
    uint256 public constant ACCEPT_WINDOW = 7 days;

    // --------------------------------------------------------------------- //
    //  Accounting                                                           //
    // --------------------------------------------------------------------- //

    /// @notice Gross amount each depositor has contributed per asset (record of
    ///         who funded what). depositor => asset => amount.
    mapping(address depositor => mapping(address asset => uint256 amount)) public deposited;

    /// @notice Creator-owned balance still available to withdraw, per asset.
    ///         = creator deposits − executed creator withdrawals. Withdrawals may
    ///         only ever draw from this.
    mapping(address asset => uint256 amount) public creatorWithdrawable;

    /// @notice Permanently locked balance per asset (accepted third-party
    ///         deposits). Never withdrawable by anyone, ever.
    mapping(address asset => uint256 amount) public lockedBalance;

    /// @dev Assets this treasury has ever held (for enumeration by the Lens).
    address[] private _assets;
    mapping(address asset => bool) private _known;

    // --------------------------------------------------------------------- //
    //  Third-party deposit queue                                            //
    // --------------------------------------------------------------------- //

    enum PendingStatus {
        None,
        Pending,
        Accepted,
        Declined,
        Reclaimed
    }

    struct PendingDeposit {
        address depositor;
        address asset;
        uint256 amount;
        uint64 proposedAt;
        PendingStatus status;
        bytes32 disclosureVersion; // hash of the exact disclosure text confirmed
    }

    mapping(uint256 id => PendingDeposit) public pendingDeposits;
    uint256 public pendingCount;

    // --------------------------------------------------------------------- //
    //  Withdrawal lifecycle (two-phase, one active at a time)               //
    // --------------------------------------------------------------------- //

    enum WithdrawalStatus {
        None,
        Announced,
        Executed,
        Cancelled
    }

    struct Withdrawal {
        address asset;
        uint256 amount;
        uint64 unlockAt;
        WithdrawalStatus status;
    }

    mapping(uint256 id => Withdrawal) public withdrawals;
    uint256 public withdrawalCount;

    /// @notice Id of the currently active (announced, not yet executed/cancelled)
    ///         withdrawal, or 0 if none. Only one may be active at a time so a
    ///         creator cannot announce many and execute selectively to obscure
    ///         intent. Ids start at 1.
    uint256 public activeWithdrawalId;

    // --------------------------------------------------------------------- //
    //  Events                                                               //
    // --------------------------------------------------------------------- //

    event CreatorDeposited(address indexed asset, uint256 amount);
    event DepositProposed(
        uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount, bytes32 disclosureVersion
    );
    event DepositAccepted(uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount);
    event DepositDeclined(uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount);
    event DepositReclaimed(uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount);
    event WithdrawalAnnounced(uint256 indexed id, address indexed asset, uint256 amount, uint64 unlockAt);
    event WithdrawalExecuted(uint256 indexed id, address indexed asset, uint256 amount);
    event WithdrawalCancelled(uint256 indexed id, address indexed asset, uint256 amount);

    // --------------------------------------------------------------------- //
    //  Errors                                                               //
    // --------------------------------------------------------------------- //

    error NotCreator();
    error SelfBacking();
    error AssetNotAllowed(address asset);
    error BelowMinimum(uint256 amount, uint256 minimum);
    error DisclosureRequired();
    error BadState();
    error WindowClosed();
    error WindowOpen();
    error WithdrawalPending();
    error ExceedsWithdrawable(uint256 amount, uint256 available);
    error StillLocked(uint64 unlockAt);
    error ZeroAmount();

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    constructor(address projectToken_, address creator_, uint256 noticePeriod_, address registry_) {
        require(projectToken_ != address(0) && creator_ != address(0) && registry_ != address(0), "zero addr");
        require(noticePeriod_ > 0, "noticePeriod=0");
        projectToken = projectToken_;
        creator = creator_;
        noticePeriod = noticePeriod_;
        registry = IAssetRegistry(registry_);
    }

    // --------------------------------------------------------------------- //
    //  Creator deposits (withdrawable)                                      //
    // --------------------------------------------------------------------- //

    /// @notice Creator adds ballast that they may later withdraw, subject to the
    ///         notice period. No fee is taken; the full amount enters the treasury.
    function deposit(address asset, uint256 amount) external onlyCreator nonReentrant {
        _validateAsset(asset, amount);

        deposited[creator][asset] += amount;
        creatorWithdrawable[asset] += amount;
        _track(asset);

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit CreatorDeposited(asset, amount);
    }

    // --------------------------------------------------------------------- //
    //  Third-party deposits (permanently locked, via queue)                 //
    // --------------------------------------------------------------------- //

    /// @notice Anyone may propose a deposit. Funds are escrowed here but do NOT
    ///         count toward backing until the creator accepts. This gives the
    ///         creator a window to decline assets from a tainted or sanctioned
    ///         address.
    /// @param disclosureVersion Hash of the exact disclosure text the depositor
    ///        confirmed. Stored permanently; if the text changes later, the old
    ///        version stays on record.
    function proposeDeposit(address asset, uint256 amount, bytes32 disclosureVersion)
        external
        nonReentrant
        returns (uint256 id)
    {
        _validateAsset(asset, amount);
        if (disclosureVersion == bytes32(0)) revert DisclosureRequired();

        id = ++pendingCount;
        pendingDeposits[id] = PendingDeposit({
            depositor: msg.sender,
            asset: asset,
            amount: amount,
            proposedAt: uint64(block.timestamp),
            status: PendingStatus.Pending,
            disclosureVersion: disclosureVersion
        });

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit DepositProposed(id, msg.sender, asset, amount, disclosureVersion);
    }

    /// @notice Creator accepts a proposal within ACCEPT_WINDOW. The funds become
    ///         PERMANENTLY LOCKED — they can never be withdrawn by anyone.
    function acceptDeposit(uint256 id) external onlyCreator nonReentrant {
        PendingDeposit storage p = pendingDeposits[id];
        if (p.status != PendingStatus.Pending) revert BadState();
        if (block.timestamp > uint256(p.proposedAt) + ACCEPT_WINDOW) revert WindowClosed();

        p.status = PendingStatus.Accepted;
        lockedBalance[p.asset] += p.amount;
        deposited[p.depositor][p.asset] += p.amount;
        _track(p.asset);

        emit DepositAccepted(id, p.depositor, p.asset, p.amount);
    }

    /// @notice Creator declines a proposal, returning the escrowed funds.
    function declineDeposit(uint256 id) external onlyCreator nonReentrant {
        PendingDeposit storage p = pendingDeposits[id];
        if (p.status != PendingStatus.Pending) revert BadState();

        p.status = PendingStatus.Declined;
        emit DepositDeclined(id, p.depositor, p.asset, p.amount);
        IERC20(p.asset).safeTransfer(p.depositor, p.amount);
    }

    /// @notice After ACCEPT_WINDOW passes with no decision, anyone may trigger the
    ///         return of the escrowed funds to the original depositor.
    /// @dev RE-CALLABLE BY DESIGN. If the asset is an issuer-paused/blocked stock
    ///      token, `safeTransfer` reverts and — because the status write is an
    ///      effect BEFORE the interaction — the whole call reverts atomically,
    ///      leaving the entry `Pending`. It never consumes the queue entry on a
    ///      failed transfer, so it simply succeeds on a later call once transfers
    ///      resume. Never refactor this to swallow the transfer failure.
    function reclaimExpired(uint256 id) external nonReentrant {
        PendingDeposit storage p = pendingDeposits[id];
        if (p.status != PendingStatus.Pending) revert BadState();
        if (block.timestamp <= uint256(p.proposedAt) + ACCEPT_WINDOW) revert WindowOpen();

        p.status = PendingStatus.Reclaimed;
        emit DepositReclaimed(id, p.depositor, p.asset, p.amount);
        IERC20(p.asset).safeTransfer(p.depositor, p.amount);
    }

    // --------------------------------------------------------------------- //
    //  Two-phase withdrawal (creator-withdrawable balance only)             //
    // --------------------------------------------------------------------- //

    /// @notice Announce intent to withdraw. Sets a public unlock time. Only one
    ///         withdrawal may be active at a time, and it may not exceed the
    ///         current creator-withdrawable balance for the asset.
    function announceWithdrawal(address asset, uint256 amount) external onlyCreator returns (uint256 id) {
        if (activeWithdrawalId != 0) revert WithdrawalPending();
        if (amount == 0) revert ZeroAmount();
        uint256 available = creatorWithdrawable[asset];
        if (amount > available) revert ExceedsWithdrawable(amount, available);

        id = ++withdrawalCount;
        uint64 unlockAt = uint64(block.timestamp + noticePeriod);
        withdrawals[id] =
            Withdrawal({asset: asset, amount: amount, unlockAt: unlockAt, status: WithdrawalStatus.Announced});
        activeWithdrawalId = id;

        emit WithdrawalAnnounced(id, asset, amount, unlockAt);
    }

    /// @notice Execute an announced withdrawal once the notice period elapses.
    ///         Draws only from creatorWithdrawable — locked third-party funds are
    ///         untouchable.
    function executeWithdrawal(uint256 id) external onlyCreator nonReentrant {
        Withdrawal storage w = withdrawals[id];
        if (w.status != WithdrawalStatus.Announced) revert BadState();
        if (block.timestamp < w.unlockAt) revert StillLocked(w.unlockAt);

        uint256 available = creatorWithdrawable[w.asset];
        if (w.amount > available) revert ExceedsWithdrawable(w.amount, available);

        w.status = WithdrawalStatus.Executed;
        activeWithdrawalId = 0;
        creatorWithdrawable[w.asset] = available - w.amount;
        deposited[creator][w.asset] -= w.amount;

        emit WithdrawalExecuted(id, w.asset, w.amount);
        IERC20(w.asset).safeTransfer(creator, w.amount);
    }

    /// @notice Cancel an announced withdrawal at any time before execution.
    function cancelWithdrawal(uint256 id) external onlyCreator {
        Withdrawal storage w = withdrawals[id];
        if (w.status != WithdrawalStatus.Announced) revert BadState();

        w.status = WithdrawalStatus.Cancelled;
        activeWithdrawalId = 0;
        emit WithdrawalCancelled(id, w.asset, w.amount);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                //
    // --------------------------------------------------------------------- //

    /// @notice Total ballast held for an asset that counts toward backing:
    ///         permanently-locked + creator-withdrawable. Excludes pending
    ///         (escrowed, not-yet-accepted) proposals.
    function heldBalance(address asset) public view returns (uint256) {
        return lockedBalance[asset] + creatorWithdrawable[asset];
    }

    /// @notice The active pending withdrawal, if any. Exposed so third parties can
    ///         build alerts without permission.
    function pendingWithdrawal()
        external
        view
        returns (uint256 id, address asset, uint256 amount, uint64 unlockAt)
    {
        id = activeWithdrawalId;
        if (id == 0) return (0, address(0), 0, 0);
        Withdrawal storage w = withdrawals[id];
        return (id, w.asset, w.amount, w.unlockAt);
    }

    /// @notice Assets this treasury has ever held (locked or withdrawable).
    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    // --------------------------------------------------------------------- //
    //  Internal                                                             //
    // --------------------------------------------------------------------- //

    /// @dev Every deposit path funnels through here. Blocks self-backing,
    ///      non-allowlisted assets, dust, and zero amounts.
    function _validateAsset(address asset, uint256 amount) internal view {
        if (asset == projectToken) revert SelfBacking();
        if (amount == 0) revert ZeroAmount();
        if (!registry.isAllowed(asset)) revert AssetNotAllowed(asset);
        uint256 min = registry.minDeposit(asset);
        if (amount < min) revert BelowMinimum(amount, min);
    }

    function _track(address asset) internal {
        if (!_known[asset]) {
            _known[asset] = true;
            _assets.push(asset);
        }
    }
}
