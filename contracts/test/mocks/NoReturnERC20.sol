// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice USDT-style ERC20: transfer()/transferFrom()/approve() return nothing
///         (no bool), reverting on failure instead of returning false. Used to
///         prove the splitter's custom optional-return handling (_tryTransfer)
///         and plain SafeERC20 (withdraw) both treat a non-reverting,
///         no-return-value transfer as success, per CLAUDE.md-adjacent hard
///         rule 10 ("handle non-standard ERC20s with SafeERC20").
contract NoReturnERC20 {
    string public name = "NoReturn";
    string public symbol = "NRT";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
