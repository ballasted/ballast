// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BallastToken} from "./BallastToken.sol";
import {ProjectTreasury} from "./ProjectTreasury.sol";

/// @title BallastFactory
/// @notice Launch entry point + registry. Atomically deploys a project token and
///         its ProjectTreasury and wires them so the treasury pointer is permanent
///         and self-backing is impossible.
///
/// @dev PHASE 1 (this file): token + treasury deploy/wire/register only. The
///      bonding curve, graduation into the Uniswap v4 token/WETH pool, LP lock, and
///      the CREATE2-mined fee hook are deliberately NOT here yet — they are the
///      next phase and are being designed against the treasury-linked curve math
///      (docs/BALLAST-build-spec.md / research §5). For now the full fixed supply
///      is minted to the factory; distribution to the curve/pool comes with that
///      phase. No per-launch address is hardcoded anywhere — callers resolve
///      token/treasury from the launch registry or the Launched event.
contract BallastFactory {
    /// @notice Fixed supply for every launch: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Global asset allowlist every launched treasury reads from.
    address public immutable registry;

    struct Launch {
        address token;
        address treasury;
        address creator;
    }

    Launch[] public launches;
    /// @notice token => id+1 (0 means unknown).
    mapping(address token => uint256 idPlusOne) public launchIdOf;

    event Launched(
        uint256 indexed id, address indexed creator, address indexed token, address treasury, uint256 noticePeriod
    );

    error BadNoticePeriod();
    error ZeroAddress();

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    /// @notice Launch a project: deploy the token + treasury, wire them, register.
    /// @param noticePeriod Withdrawal notice, restricted to the offered set
    ///        (7 / 30 / 90 days) and immutable on the treasury once set.
    function launch(string calldata name_, string calldata symbol_, uint256 noticePeriod)
        external
        returns (uint256 id, address token, address treasury)
    {
        if (!(noticePeriod == 7 days || noticePeriod == 30 days || noticePeriod == 90 days)) {
            revert BadNoticePeriod();
        }

        // 1. Token — full supply minted to the factory (curve/pool routing: next phase).
        BallastToken t = new BallastToken(name_, symbol_, TOTAL_SUPPLY, msg.sender, address(this));

        // 2. Treasury — projectToken is immutable here, so self-backing is impossible.
        ProjectTreasury tr = new ProjectTreasury(address(t), msg.sender, noticePeriod, registry);

        // 3. Wire the token -> treasury pointer, permanently (write-once).
        t.initTreasury(address(tr));

        // 4. Register.
        token = address(t);
        treasury = address(tr);
        launches.push(Launch({token: token, treasury: treasury, creator: msg.sender}));
        id = launches.length - 1;
        launchIdOf[token] = id + 1;

        emit Launched(id, msg.sender, token, treasury, noticePeriod);
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }
}
