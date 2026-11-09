// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/HashLock.sol";

contract HashLockTest is Test {
    HashLock h; address alice = address(0xA11CE); address bob = address(0xB0B);
    bytes32 pre = keccak256("rehearsal-secret"); bytes32 hash;
    function setUp() public { h = new HashLock(); hash = sha256(abi.encodePacked(pre)); vm.deal(alice, 1 ether); }
    function _lock() internal { vm.prank(alice); h.lock{value: 0.1 ether}(hash, bob, uint64(block.timestamp + 1 hours)); }
    function testClaimWithPreimage() public { _lock(); h.claim(pre); assertEq(bob.balance, 0.1 ether); }
    function testWrongPreimageReverts() public { _lock(); vm.expectRevert("no open lock"); h.claim(bytes32(uint256(1))); }
    function testNoDoubleClaim() public { _lock(); h.claim(pre); vm.expectRevert("no open lock"); h.claim(pre); }
    function testRefundOnlyAfterTimeout() public {
        _lock(); vm.expectRevert("too early"); h.refund(hash);
        vm.warp(block.timestamp + 1 hours); vm.expectRevert("expired"); h.claim(pre);
        h.refund(hash); assertEq(alice.balance, 1 ether);
    }
    function testNoRefundAfterClaim() public { _lock(); h.claim(pre); vm.warp(block.timestamp + 2 hours); vm.expectRevert("no open lock"); h.refund(hash); }
}
