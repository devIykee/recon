// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./IERC20.sol";
import {FeeController} from "./FeeController.sol";

/// @title Acme Vault (test fixture for recon)
/// @notice Users deposit an ERC20 asset and receive shares. A keeper harvests yield.
contract Vault {
    IERC20 public immutable asset;
    FeeController public immutable fees;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 assets, uint256 shares);

    constructor(IERC20 _asset, FeeController _fees) {
        asset = _asset;
        fees = _fees;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        uint256 supply = totalShares;
        shares = supply == 0 ? assets : (assets * supply) / totalAssets();
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, assets, shares);
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        require(sharesOf[msg.sender] >= shares, "not enough shares");
        assets = (shares * totalAssets()) / totalShares;
        uint256 fee = (assets * fees.withdrawFeeBps()) / 10_000;

        (bool ok, ) = msg.sender.call(abi.encodeWithSignature("onWithdraw(uint256)", assets - fee));
        ok;
        require(asset.transfer(msg.sender, assets - fee), "transfer failed");
        require(asset.transfer(fees.treasury(), fee), "fee transfer failed");

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        emit Withdraw(msg.sender, assets, shares);
    }

    function harvest(address strategy, bytes calldata data) external {
        require(msg.sender == fees.keeper(), "not keeper");
        (bool ok, ) = strategy.call(data);
        require(ok, "harvest failed");
    }
}
