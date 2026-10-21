// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

interface IBurnVoteRegistry {
    function isAllowed(address asset) external view returns (bool);
}

interface IBurnVoteFactory {
    /// @return id+1 for a token this factory launched, else 0.
    function launchIdOf(address token) external view returns (uint256);
}

/// @title BurnVote
/// @notice Burn-to-vote: a token's holders burn their tokens to the dead address to
///         signal which allowlisted stock should be the DEFAULT round-up stock for
///         that token's community. The vote controls NO funds — it only informs the
///         RoundupRouter's suggested default. Weekly epochs (Monday 00:00 UTC).
/// @dev    No owner, no admin, no upgradeability. Burns go straight to dead via
///         transferFrom(voter -> dead). The default is derived permissionlessly:
///         `finalize()` folds completed epochs forward, and `defaultStock()` is
///         correct even if nobody ever calls finalize (lazy, gas-bounded).
contract BurnVote is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev 2024-01-01 00:00:00 UTC — a Monday. Epoch 0 starts here; epochs are 1 week.
    uint256 public constant EPOCH_GENESIS = 1_704_067_200;
    uint256 public constant EPOCH_LENGTH = 7 days;

    IBurnVoteRegistry public immutable registry;
    /// @dev Factories whose launches are eligible. A token is votable if ANY returns
    ///      launchIdOf != 0. Immutable set, fixed at construction.
    address[] private _factories;

    // token => epoch => stock => votes
    mapping(address => mapping(uint256 => mapping(address => uint256))) public tally;
    // token => epoch => distinct stocks that received a vote (bounded by allowlist size)
    mapping(address => mapping(uint256 => address[])) private _stocksInEpoch;
    mapping(address => mapping(uint256 => mapping(address => bool))) private _seenInEpoch;
    // token => ascending list of epochs that received at least one vote
    mapping(address => uint256[]) private _votedEpochs;

    // Resolved default state (updated by finalize). The VIEW is correct regardless.
    mapping(address => address) private _storedDefault;
    // Number of entries of _votedEpochs already folded into _storedDefault.
    mapping(address => uint256) private _resolvedCount;

    event Voted(address indexed token, address indexed voter, address indexed stock, uint256 amount, uint256 epoch);
    event DefaultChanged(address indexed token, address oldStock, address newStock, uint256 epoch);

    error ZeroAddress();
    error NotBallastToken(address token);
    error StockNotAllowed(address stock);
    error ZeroAmount();
    error SelfVote();

    constructor(address registry_, address[] memory factories_) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (factories_.length == 0) revert ZeroAddress();
        registry = IBurnVoteRegistry(registry_);
        for (uint256 i; i < factories_.length; ++i) {
            if (factories_[i] == address(0)) revert ZeroAddress();
            _factories.push(factories_[i]);
        }
    }

    // ── epochs ──

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp < EPOCH_GENESIS) return 0;
        return (block.timestamp - EPOCH_GENESIS) / EPOCH_LENGTH;
    }

    /// @notice Seconds remaining in the current epoch.
    function timeLeftInEpoch() external view returns (uint256) {
        uint256 end = EPOCH_GENESIS + (currentEpoch() + 1) * EPOCH_LENGTH;
        return end > block.timestamp ? end - block.timestamp : 0;
    }

    // ── voting ──

    /// @notice Burn `amount` of `token` to the dead address and add `amount` votes for
    ///         `stock` in the current epoch for `token`'s community.
    function vote(address token, address stock, uint256 amount) external nonReentrant {
        if (token == address(0) || stock == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (stock == token) revert SelfVote();
        if (!_isBallastToken(token)) revert NotBallastToken(token);
        if (!registry.isAllowed(stock)) revert StockNotAllowed(stock);

        uint256 epoch = currentEpoch();

        // Effects before interaction (CEI). Record the vote first.
        if (!_seenInEpoch[token][epoch][stock]) {
            _seenInEpoch[token][epoch][stock] = true;
            _stocksInEpoch[token][epoch].push(stock);
        }
        uint256[] storage ve = _votedEpochs[token];
        if (ve.length == 0 || ve[ve.length - 1] != epoch) {
            // epochs only ever increase, so a new epoch is appended at the end
            ve.push(epoch);
        }
        tally[token][epoch][stock] += amount;

        emit Voted(token, msg.sender, stock, amount, epoch);

        // Interaction: pull the voter's tokens straight to the dead address.
        IERC20(token).safeTransferFrom(msg.sender, DEAD, amount);
    }

    // ── default resolution ──

    /// @notice Fold every newly-completed voted epoch into the stored default.
    ///         Permissionless and idempotent. Not required for correctness —
    ///         `defaultStock()` already accounts for unresolved epochs — but it
    ///         bounds the view's gas after long inactivity.
    function finalize(address token) external {
        uint256[] storage ve = _votedEpochs[token];
        uint256 n = ve.length;
        uint256 i = _resolvedCount[token];
        uint256 cur = currentEpoch();
        address def = _storedDefault[token];
        while (i < n && ve[i] < cur) {
            address w = _epochWinner(token, ve[i]);
            if (w != address(0) && w != def) {
                emit DefaultChanged(token, def, w, ve[i]);
                def = w;
            }
            unchecked {
                ++i;
            }
        }
        _storedDefault[token] = def;
        _resolvedCount[token] = i;
    }

    /// @notice The current default round-up stock for `token`, or address(0) if the
    ///         token has never had a decisive winner. Correct with nobody calling
    ///         anything: folds any unresolved COMPLETED voted epochs on the fly.
    function defaultStock(address token) public view returns (address) {
        uint256[] storage ve = _votedEpochs[token];
        uint256 n = ve.length;
        uint256 cur = currentEpoch();
        // Walk unresolved completed voted epochs NEWEST-first; the first unique
        // winner is the answer (later ties/empties keep the prior default, which is
        // exactly "an earlier unique winner" — so we only need the most recent one).
        uint256 i = n;
        while (i > _resolvedCount[token]) {
            unchecked {
                --i;
            }
            if (ve[i] >= cur) continue; // not yet completed
            address w = _epochWinner(token, ve[i]);
            if (w != address(0)) return w;
        }
        return _storedDefault[token];
    }

    /// @notice The leader of the CURRENT (in-progress) epoch — informational only.
    ///         Returns (stock, votes); stock is address(0) on an empty or tied lead.
    function currentLeader(address token) external view returns (address stock, uint256 votes) {
        uint256 e = currentEpoch();
        stock = _epochWinner(token, e);
        if (stock != address(0)) votes = tally[token][e][stock];
    }

    /// @notice The distinct stocks voted in an epoch and their tallies.
    function epochTallies(address token, uint256 epoch)
        external
        view
        returns (address[] memory stocks, uint256[] memory votes)
    {
        stocks = _stocksInEpoch[token][epoch];
        votes = new uint256[](stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            votes[i] = tally[token][epoch][stocks[i]];
        }
    }

    // ── internals ──

    /// @dev Winner = the UNIQUE strict maximum. Returns address(0) on a tie or no
    ///      votes. Bounded by the number of distinct stocks voted that epoch.
    function _epochWinner(address token, uint256 epoch) internal view returns (address) {
        address[] storage stocks = _stocksInEpoch[token][epoch];
        uint256 len = stocks.length;
        address top;
        uint256 topVotes;
        bool tied;
        for (uint256 i; i < len; ++i) {
            uint256 v = tally[token][epoch][stocks[i]];
            if (v > topVotes) {
                top = stocks[i];
                topVotes = v;
                tied = false;
            } else if (v == topVotes) {
                tied = true;
            }
        }
        if (topVotes == 0 || tied) return address(0);
        return top;
    }

    /// @notice True if `token` was launched by any registered Ballast factory —
    ///         the same gate `vote()` enforces. Exposed so the UI can decide whether
    ///         to show the burn-to-vote card, and so coverage across every factory
    ///         generation is directly testable.
    function isVotableToken(address token) external view returns (bool) {
        return _isBallastToken(token);
    }

    function _isBallastToken(address token) internal view returns (bool) {
        uint256 len = _factories.length;
        for (uint256 i; i < len; ++i) {
            // allowFailure semantics: a factory predating launchIdOf simply reverts;
            // treat that as "not from this factory" and keep checking the others.
            try IBurnVoteFactory(_factories[i]).launchIdOf(token) returns (uint256 idPlus1) {
                if (idPlus1 != 0) return true;
            } catch {}
        }
        return false;
    }

    function factories() external view returns (address[] memory) {
        return _factories;
    }
}
