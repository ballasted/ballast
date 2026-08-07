// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {BuybackBurner} from "../src/BuybackBurner.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The failure the fork can't reach: the SWAP succeeds, then the BURN transfer to
// DEAD fails. On real $BALLAST that's impossible (immutable ERC-20, no pause/
// blocklist), so it can only be proven with a hostile token + a minimal pool mock
// that carries the swap far enough to attempt the burn. The invariant under test:
// a failing burn reverts the WHOLE buyback atomically and strands NO WETH — the
// funds sit exactly where they were, still burn-only. This is cheap to prove now
// and impossible once the address is permanent. (CLAUDE.md: adversarial first.)
// ─────────────────────────────────────────────────────────────────────────────

address constant DEAD = 0x000000000000000000000000000000000000dEaD;

/// @dev A $BALLAST stand-in that REVERTS when tokens are sent to DEAD. Every other
///      transfer (incl. the pool paying the buyer) works normally, so the swap fills
///      and only the burn step blows up.
contract RevertOnBurnToken is ERC20 {
    error BurnBlocked();

    constructor() ERC20("Revert Ballast", "rBAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == DEAD) revert BurnBlocked();
        super._update(from, to, value);
    }
}

/// @dev A $BALLAST stand-in that silently RETURNS FALSE on a transfer to DEAD instead
///      of reverting. SafeERC20 must catch the false and revert the buyback anyway.
contract FalseOnBurnToken is ERC20 {
    constructor() ERC20("False Ballast", "fBAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (to == DEAD) return false; // no move, no revert — the nastier case
        return super.transfer(to, value);
    }
}

/// @dev Minimal PoolManager mock implementing ONLY the calls BuybackBurner makes in
///      its unlock callback: extsload (for getSlot0), unlock, swap, sync, settle, take.
///      The swap consumes all WETH exact-in and delivers an equal count of $BALLAST,
///      so control reaches the burn with a positive `bought`.
contract MockPoolManager {
    // A nonzero Slot0: sqrtPriceX96 = 2**96 (price 1), packed in the low 160 bits.
    uint160 constant SQRT_PRICE = 79228162514264337593543950336;

    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(uint256(SQRT_PRICE));
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey calldata, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        pure
        returns (BalanceDelta)
    {
        // exact-in: amountSpecified is -wethIn. Deliver an equal amount of currency0.
        uint256 wethIn = uint256(-params.amountSpecified);
        return toBalanceDelta(int128(int256(wethIn)), -int128(int256(wethIn)));
    }

    function sync(Currency) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function take(Currency currency, address to, uint256 amount) external {
        // Deliver currency0 ($BALLAST) to the buyer; the mock is pre-funded in setUp.
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }
}

contract BuybackBurnerBurnFailureTest is Test {
    MockPoolManager pool;
    MockERC20 weth;
    address owner = makeAddr("owner");
    address anyone = makeAddr("anyone");

    uint256 constant THRESHOLD = 0.001 ether;
    uint256 constant FUND = 1 ether;

    function setUp() public {
        pool = new MockPoolManager();
        weth = new MockERC20("Wrapped ETH", "WETH", 18);
    }

    function _deploy(address ballast) internal returns (BuybackBurner bb) {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(ballast),
            currency1: Currency.wrap(address(weth)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        address[] memory hooks = new address[](0);
        bb = new BuybackBurner(
            IPoolManager(address(pool)), address(weth), ballast, key, hooks, THRESHOLD, 500, owner
        );
        // Fund the burner past threshold, and pre-fund the pool with the $BALLAST it
        // will hand back on `take`.
        weth.mint(address(bb), FUND);
    }

    // ── Positive control: with a well-behaved token the mock pipeline reaches AND
    //    completes the burn. Proves the failure tests below actually exercise the
    //    swap→burn path rather than passing because nothing happened. ──────────────

    function test_mockPipeline_happyBurn_succeeds() public {
        MockERC20 ballast = new MockERC20("Ballast", "BAL", 18);
        BuybackBurner bb = _deploy(address(ballast));
        ballast.mint(address(pool), FUND); // pool pays this out on take

        vm.prank(anyone);
        uint256 burned = bb.buybackAndBurn();

        assertEq(burned, FUND, "burned equals bought");
        assertEq(ballast.balanceOf(DEAD), FUND, "tokens landed at DEAD");
        assertEq(ballast.balanceOf(address(bb)), 0, "burner keeps no $BALLAST");
        assertEq(weth.balanceOf(address(bb)), 0, "all WETH spent");
        assertEq(bb.buybackCount(), 1, "one buyback recorded");
    }

    // ── Burn transfer REVERTS → whole buyback reverts, no WETH stranded ───────────

    function test_burnReverts_revertsAtomically_noWethStranded() public {
        RevertOnBurnToken ballast = new RevertOnBurnToken();
        BuybackBurner bb = _deploy(address(ballast));
        ballast.mint(address(pool), FUND);

        vm.prank(anyone);
        vm.expectRevert(RevertOnBurnToken.BurnBlocked.selector);
        bb.buybackAndBurn();

        _assertNothingMoved(bb, IERC20(address(ballast)));
    }

    // ── Burn transfer RETURNS FALSE → SafeERC20 reverts, no WETH stranded ─────────

    function test_burnReturnsFalse_safeERC20Reverts_noWethStranded() public {
        FalseOnBurnToken ballast = new FalseOnBurnToken();
        BuybackBurner bb = _deploy(address(ballast));
        ballast.mint(address(pool), FUND);

        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(ballast)));
        bb.buybackAndBurn();

        _assertNothingMoved(bb, IERC20(address(ballast)));
    }

    // After a reverted buyback the EVM rolls state back to before the call: the WETH
    // is exactly where it started (in the burner, still burn-only), the pool got
    // nothing, DEAD got nothing, and no buyback was recorded.
    function _assertNothingMoved(BuybackBurner bb, IERC20 ballast) internal view {
        assertEq(weth.balanceOf(address(bb)), FUND, "WETH fully retained by burner");
        assertEq(weth.balanceOf(address(pool)), 0, "no WETH stranded in the pool");
        assertEq(ballast.balanceOf(DEAD), 0, "nothing burned");
        assertEq(bb.buybackCount(), 0, "no buyback recorded");
        assertEq(bb.totalWethSpent(), 0, "no spend recorded");
    }
}
