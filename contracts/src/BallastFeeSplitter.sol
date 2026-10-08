// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title BallastFeeSplitter — splits one locked Ramses v3 position's fees between
///        a token's creator and the Ballast protocol, in a fixed, immutable ratio
///
/// @notice One clone per locked position (per Ramses `tokenId`), deployed by
///         BallastFeeSplitterFactory and set as that position's `feeReceiver` on
///         Ramses' position locker. Ramses' locks are permanent and only the
///         CURRENT `feeReceiver` may ever call the locker's `setFeeReceiver` — this
///         contract never calls the locker at all (not even to read from it), so
///         the fee destination a position was locked to can only ever move between
///         the two recipients configured here, never anywhere else.
///
/// @dev No owner, no admin, no pause, no upgrade path, no rescue function. The
///      ONLY two addresses that can ever receive a token balance held here are
///      `creatorRecipient` and `protocolRecipient`, and the only way either moves
///      is that recipient rotating itself (`setCreatorRecipient`/
///      `setProtocolRecipient`, each gated to the CURRENT holder of that role).
///      `distribute()` is balance-based and permissionless — it works for any
///      ERC20 that lands here, including gauge reward tokens, with no allowlist
///      (this contract never prices or displays anything; it only forwards
///      whatever arrives to one of the two fixed recipients).
///
///      Deployed as an EIP-1167 minimal proxy clone (see BallastFeeSplitterFactory)
///      with config set once via `initialize()` instead of a constructor — clones
///      share bytecode, so Solidity's `immutable` keyword can't hold per-clone
///      values. `initialized` is a one-shot guard; there is no setter for
///      `creatorBps`/`protocolBps`, so the split is immutable in practice even
///      though it isn't an EVM `immutable` variable. The factory clones and
///      initializes in the same transaction, so there is never a window where a
///      freshly deployed, uninitialized clone could be front-run.
contract BallastFeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;

    enum Role {
        Creator,
        Protocol
    }

    // --------------------------------------------------------------------- //
    //  Metadata — informational only, never used in any external call       //
    // --------------------------------------------------------------------- //

    address public token;
    address public locker;
    uint256 public positionId;

    // --------------------------------------------------------------------- //
    //  Split config — set once in initialize(); no setter for either value  //
    // --------------------------------------------------------------------- //

    address public creatorRecipient;
    address public protocolRecipient;
    uint16 public creatorBps;
    uint16 public protocolBps;
    bool public initialized;

    /// @notice Pull-fallback credit, keyed by ROLE (not address) so rotating a
    ///         recipient carries forward any balance a push couldn't deliver —
    ///         it is paid to whoever CURRENTLY holds that role at withdraw time.
    mapping(address => mapping(Role => uint256)) public pending;

    // --------------------------------------------------------------------- //
    //  Events                                                               //
    // --------------------------------------------------------------------- //

    event SplitterInitialized(
        address indexed token,
        address indexed locker,
        uint256 indexed positionId,
        address creatorRecipient,
        address protocolRecipient,
        uint16 creatorBps,
        uint16 protocolBps
    );
    event Distributed(
        address indexed token, uint256 toCreator, uint256 toProtocol, uint256 creatorPending, uint256 protocolPending
    );
    event Withdrawn(address indexed token, Role indexed role, address indexed recipient, uint256 amount);
    event CreatorRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event ProtocolRecipientChanged(address indexed oldRecipient, address indexed newRecipient);

    // --------------------------------------------------------------------- //
    //  Errors                                                               //
    // --------------------------------------------------------------------- //

    error AlreadyInitialized();
    error ZeroAddress();
    error BadSplit();
    error NotCreatorRecipient();
    error NotProtocolRecipient();
    error NothingToDistribute();
    error NothingToWithdraw();

    modifier onlyCreatorRecipient() {
        if (msg.sender != creatorRecipient) revert NotCreatorRecipient();
        _;
    }

    modifier onlyProtocolRecipient() {
        if (msg.sender != protocolRecipient) revert NotProtocolRecipient();
        _;
    }

    // --------------------------------------------------------------------- //
    //  Init — called once, by the factory, in the same tx as the clone      //
    // --------------------------------------------------------------------- //

    function initialize(
        address token_,
        address locker_,
        uint256 positionId_,
        address creatorRecipient_,
        address protocolRecipient_,
        uint16 creatorBps_,
        uint16 protocolBps_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            token_ == address(0) || locker_ == address(0) || creatorRecipient_ == address(0)
                || protocolRecipient_ == address(0)
        ) revert ZeroAddress();
        if (uint256(creatorBps_) + protocolBps_ != BPS) revert BadSplit();

        initialized = true;
        token = token_;
        locker = locker_;
        positionId = positionId_;
        creatorRecipient = creatorRecipient_;
        protocolRecipient = protocolRecipient_;
        creatorBps = creatorBps_;
        protocolBps = protocolBps_;

        emit SplitterInitialized(token_, locker_, positionId_, creatorRecipient_, protocolRecipient_, creatorBps_, protocolBps_);
    }

    // --------------------------------------------------------------------- //
    //  distribute() — permissionless, balance-based, push-with-pull-fallback//
    // --------------------------------------------------------------------- //

    /// @notice Splits this contract's full balance of `token_` between the two
    ///         recipients. Dust from integer division goes to the creator. A
    ///         recipient whose transfer fails (blocklisted, reverting token, etc.)
    ///         is credited to `pending` instead of blocking the other recipient's
    ///         share or reverting the whole call.
    function distribute(address token_) external nonReentrant returns (uint256 toCreator, uint256 toProtocol) {
        uint256 bal = IERC20(token_).balanceOf(address(this));
        if (bal == 0) revert NothingToDistribute();

        toProtocol = (bal * protocolBps) / BPS;
        toCreator = bal - toProtocol; // remainder + rounding dust to the creator

        uint256 creatorPending = _pushOrCredit(token_, Role.Creator, creatorRecipient, toCreator);
        uint256 protocolPending = _pushOrCredit(token_, Role.Protocol, protocolRecipient, toProtocol);

        emit Distributed(token_, toCreator - creatorPending, toProtocol - protocolPending, creatorPending, protocolPending);
    }

    function _pushOrCredit(address token_, Role role, address to, uint256 amount) internal returns (uint256 credited) {
        if (amount == 0) return 0;
        if (_tryTransfer(token_, to, amount)) return 0;
        pending[token_][role] += amount;
        return amount;
    }

    /// @dev Mirrors SafeERC20's internal optional-return-bool handling exactly
    ///      (OZ's `_callOptionalReturnBool` is a private library function, so this
    ///      reimplements the same logic): a token that returns no data is treated
    ///      as success iff it has code; a token that returns `false` or reverts is
    ///      treated as failure — never bubbled up as a revert here, unlike plain
    ///      SafeERC20.safeTransfer.
    function _tryTransfer(address token_, address to, uint256 amount) internal returns (bool ok) {
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        bool callSuccess;
        uint256 returnSize;
        uint256 returnValue;
        assembly ("memory-safe") {
            callSuccess := call(gas(), token_, 0, add(data, 0x20), mload(data), 0, 0x20)
            returnSize := returndatasize()
            returnValue := mload(0)
        }
        ok = callSuccess && (returnSize == 0 ? token_.code.length > 0 : returnValue == 1);
    }

    // --------------------------------------------------------------------- //
    //  withdraw() — permissionless retry of a stuck pull-fallback credit     //
    // --------------------------------------------------------------------- //

    /// @notice Pays out `pending[token][role]` to whichever address CURRENTLY
    ///         holds that role. Permissionless (anyone may trigger the retry),
    ///         but the destination is always one of the two fixed, already-
    ///         trusted recipients — never caller-supplied. Uses SafeERC20, so it
    ///         reverts (rather than silently re-crediting) if the transfer still
    ///         fails; nothing is lost, the credit simply stays pending.
    function withdraw(address token_, Role role) external nonReentrant returns (uint256 amount) {
        amount = pending[token_][role];
        if (amount == 0) revert NothingToWithdraw();
        pending[token_][role] = 0;

        address to = role == Role.Creator ? creatorRecipient : protocolRecipient;
        IERC20(token_).safeTransfer(to, amount);

        emit Withdrawn(token_, role, to, amount);
    }

    // --------------------------------------------------------------------- //
    //  Recipient rotation — self-service only, no admin override            //
    // --------------------------------------------------------------------- //

    function setCreatorRecipient(address newRecipient) external onlyCreatorRecipient {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit CreatorRecipientChanged(creatorRecipient, newRecipient);
        creatorRecipient = newRecipient;
    }

    function setProtocolRecipient(address newRecipient) external onlyProtocolRecipient {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit ProtocolRecipientChanged(protocolRecipient, newRecipient);
        protocolRecipient = newRecipient;
    }
}
