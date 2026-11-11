// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {StudentSBTIdentity} from "../../src/StudentSBTIdentity.sol";

interface StudentSBTTestVm {
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata errorData) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

/// @dev Shared synthetic wallets and timestamps for L03 and payment tests.
abstract contract StudentSBTFixture {
    StudentSBTTestVm internal constant sbtVm =
        StudentSBTTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant SBT_ISSUER = address(0x1000);
    address internal constant REGULAR_WALLET = address(0x1001);
    address internal constant STUDENT_WALLET = address(0x1002);
    address internal constant EXPIRED_WALLET = address(0x1003);
    uint64 internal constant FIXTURE_TIME = 1794142500; // P02 fixture's issuedAt.
    uint64 internal constant STUDENT_EXPIRY = FIXTURE_TIME + 1 days;
    uint64 internal constant EXPIRED_EXPIRY = FIXTURE_TIME - 1;

    function deployStudentSBTFixture() internal returns (StudentSBTIdentity identity) {
        identity = new StudentSBTIdentity(SBT_ISSUER);
        sbtVm.warp(EXPIRED_EXPIRY - 1);
        sbtVm.prank(SBT_ISSUER);
        identity.mint(EXPIRED_WALLET, EXPIRED_EXPIRY);

        sbtVm.warp(FIXTURE_TIME);
        sbtVm.prank(SBT_ISSUER);
        identity.mint(STUDENT_WALLET, STUDENT_EXPIRY);
    }
}
