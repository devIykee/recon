// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FeeController (test fixture for recon)
contract FeeController {
    address public owner;
    address public treasury;
    address public keeper;
    uint256 public withdrawFeeBps;

    constructor(address _treasury, address _keeper) {
        owner = msg.sender;
        treasury = _treasury;
        keeper = _keeper;
        withdrawFeeBps = 30;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
    }

    function setWithdrawFee(uint256 bps) external {
        withdrawFeeBps = bps;
    }
}
