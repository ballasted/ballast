// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManager} from
    "../../lib/ramses-v3-contracts/contracts/CL/periphery/interfaces/INonfungiblePositionManager.sol";

/// @notice Deterministic, test-only stand-in for Ramses' real
///         NonfungiblePositionManager — just enough surface for the REAL
///         RamsesLocker.sol and RamsesLockLauncher.sol to run unit/fuzz tests
///         without a fork. Fee accrual (`accrueFees`) and the ability to
///         short-change a mint (`mintShortfallBps`) are test-only hooks; real
///         Ramses needs neither (fees come from real trading, and mint()
///         genuinely may use less than desired at the current tick).
///
/// @dev NOT a vendored file — this is our own minimal mock, deliberately kept
///      separate from contracts/lib/ramses-v3-contracts (the real, pinned
///      source). The authoritative proof against the REAL deployed contract
///      is the fork suite (test/BallastFeeSplitterFork.t.sol), which this
///      mock cannot substitute for.
contract MockRamsesPositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    address public immutable deployerAddr;
    uint256 public nextTokenId = 1;
    /// @dev out of 10_000; applied to BOTH legs of the next mint() only, then reset.
    uint256 public mintShortfallBps;

    mapping(uint256 => Position) public positions_;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => uint256) public owed0;
    mapping(uint256 => uint256) public owed1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    error NotAuthorized();

    constructor(address deployerAddr_) {
        deployerAddr = deployerAddr_;
    }

    function deployer() external view returns (address) {
        return deployerAddr;
    }

    function setMintShortfallBps(uint256 bps) external {
        mintShortfallBps = bps;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            address token0,
            address token1,
            int24 tickSpacing,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage p = positions_[tokenId];
        return (p.token0, p.token1, p.tickSpacing, p.tickLower, p.tickUpper, p.liquidity, 0, 0, 0, 0);
    }

    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        uint256 shortfall = mintShortfallBps;
        mintShortfallBps = 0; // one-shot, like the launcher's dust-refund test expects

        amount0 = params.amount0Desired - (params.amount0Desired * shortfall) / 10_000;
        amount1 = params.amount1Desired - (params.amount1Desired * shortfall) / 10_000;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "slippage");

        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextTokenId++;
        liquidity = uint128(amount0 + amount1); // arbitrary deterministic placeholder, unused by locker
        positions_[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            tickSpacing: params.tickSpacing,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity
        });
        ownerOf[tokenId] = params.recipient;
        emit Transfer(address(0), params.recipient, tokenId);
    }

    /// @dev Test-only: simulates swap fees accruing to a position (real Ramses
    ///      accrues these from trading; here the test pulls tokens from itself).
    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Position storage p = positions_[tokenId];
        if (amount0 > 0) {
            IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
            owed0[tokenId] += amount0;
        }
        if (amount1 > 0) {
            IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);
            owed1[tokenId] += amount1;
        }
    }

    function collect(INonfungiblePositionManager.CollectParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage p = positions_[params.tokenId];
        uint256 max0 = params.amount0Max;
        uint256 max1 = params.amount1Max;
        amount0 = owed0[params.tokenId] < max0 ? owed0[params.tokenId] : max0;
        amount1 = owed1[params.tokenId] < max1 ? owed1[params.tokenId] : max1;
        owed0[params.tokenId] -= amount0;
        owed1[params.tokenId] -= amount1;
        if (amount0 > 0) IERC20(p.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransfer(params.recipient, amount1);
    }

    // ---------------------------------------------------------------- //
    //  Minimal ERC-721 surface (ownerOf/getApproved/isApprovedForAll     //
    //  already exposed as public mappings above; approve/transferFrom   //
    //  need real logic)                                                  //
    // ---------------------------------------------------------------- //

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], NotAuthorized());
        getApproved[tokenId] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(owner == from, "wrong owner");
        require(
            msg.sender == owner || msg.sender == getApproved[tokenId] || isApprovedForAll[owner][msg.sender],
            NotAuthorized()
        );
        delete getApproved[tokenId];
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
