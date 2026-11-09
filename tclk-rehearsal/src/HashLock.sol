// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ETH hash lock for a tclk rehearsal. Test chains only, not audited.
/// Uses sha256 to match tclk's hash locks.
contract HashLock {
    struct Lock { address payer; address payee; uint256 amount; uint64 refundAfter; bool done; }
    uint64 public constant MIN_LOCK = 10 minutes; // claim window floor, like tclk validateDeadlines
    mapping(bytes32 => Lock) public locks; // key = sha256(preimage)

    event Locked(bytes32 indexed hash, address payer, address payee, uint256 amount, uint64 refundAfter);
    event Claimed(bytes32 indexed hash, bytes32 preimage);
    event Refunded(bytes32 indexed hash);

    function lock(bytes32 hash, address payee, uint64 refundAfter) external payable {
        require(msg.value > 0, "no value");
        require(locks[hash].payer == address(0), "hash used");
        require(refundAfter >= block.timestamp + MIN_LOCK, "lock too short");
        locks[hash] = Lock(msg.sender, payee, msg.value, refundAfter, false);
        emit Locked(hash, msg.sender, payee, msg.value, refundAfter);
    }

    function claim(bytes32 preimage) external {
        bytes32 hash = sha256(abi.encodePacked(preimage));
        Lock storage l = locks[hash];
        require(l.payer != address(0) && !l.done, "no open lock");
        require(block.timestamp < l.refundAfter, "expired");
        l.done = true;
        emit Claimed(hash, preimage); // the reveal: anyone watching learns the secret
        (bool ok,) = l.payee.call{value: l.amount}("");
        require(ok, "send failed");
    }

    function refund(bytes32 hash) external {
        Lock storage l = locks[hash];
        require(l.payer != address(0) && !l.done, "no open lock");
        require(block.timestamp >= l.refundAfter, "too early");
        l.done = true;
        emit Refunded(hash);
        (bool ok,) = l.payer.call{value: l.amount}("");
        require(ok, "send failed");
    }
}
