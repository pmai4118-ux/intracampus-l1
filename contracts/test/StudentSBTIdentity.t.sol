// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {StudentSBTIdentity} from "../src/StudentSBTIdentity.sol";
import {StudentSBTFixture} from "./fixtures/StudentSBTFixture.sol";

contract StudentSBTIdentityTest is StudentSBTFixture {
    StudentSBTIdentity private identity;

    function setUp() public {
        identity = deployStudentSBTFixture();
    }

    function testIssuerMintsLockedCredential() public {
        (uint256 previousId,) = identity.credentials(STUDENT_WALLET);
        uint256 nextId = previousId + 1;
        sbtVm.expectEmit(true, true, true, true, address(identity));
        emit StudentSBTIdentity.Transfer(address(0), REGULAR_WALLET, nextId);
        sbtVm.expectEmit(false, false, false, true, address(identity));
        emit StudentSBTIdentity.Locked(nextId);

        sbtVm.prank(SBT_ISSUER);
        uint256 tokenId = identity.mint(REGULAR_WALLET, STUDENT_EXPIRY);
        (uint256 storedId, uint64 storedExpiry) = identity.credentials(REGULAR_WALLET);
        require(storedId == tokenId && storedExpiry == STUDENT_EXPIRY, "credential");
        require(identity.issuer() == SBT_ISSUER, "issuer");
        require(identity.ownerOf(tokenId) == REGULAR_WALLET, "owner");
        require(identity.balanceOf(REGULAR_WALLET) == 1, "balance");
        require(identity.locked(tokenId), "locked");
        require(identity.tierOf(REGULAR_WALLET) == 1, "tier");
    }

    function testOnlyIssuerCanMintOrRevoke() public {
        (uint256 tokenId,) = identity.credentials(STUDENT_WALLET);
        sbtVm.expectRevert(StudentSBTIdentity.UnauthorizedIssuer.selector);
        sbtVm.prank(REGULAR_WALLET);
        identity.mint(REGULAR_WALLET, STUDENT_EXPIRY);

        sbtVm.expectRevert(StudentSBTIdentity.UnauthorizedIssuer.selector);
        sbtVm.prank(STUDENT_WALLET);
        identity.revoke(tokenId);

        require(identity.tierOf(REGULAR_WALLET) == 0, "unauthorized mint");
        require(identity.tierOf(STUDENT_WALLET) == 1, "unauthorized revoke");
    }

    function testMintRejectsZeroWalletAndNonFutureExpiry() public {
        sbtVm.expectRevert(StudentSBTIdentity.InvalidWallet.selector);
        new StudentSBTIdentity(address(0));

        sbtVm.expectRevert(StudentSBTIdentity.InvalidWallet.selector);
        sbtVm.prank(SBT_ISSUER);
        identity.mint(address(0), STUDENT_EXPIRY);

        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.InvalidExpiry.selector, EXPIRED_EXPIRY));
        sbtVm.prank(SBT_ISSUER);
        identity.mint(REGULAR_WALLET, EXPIRED_EXPIRY);

        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.InvalidExpiry.selector, FIXTURE_TIME));
        sbtVm.prank(SBT_ISSUER);
        identity.mint(REGULAR_WALLET, FIXTURE_TIME);
    }

    function testDuplicateMintRequiresRevocationEvenAfterExpiry() public {
        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.CredentialAlreadyIssued.selector, STUDENT_WALLET));
        sbtVm.prank(SBT_ISSUER);
        identity.mint(STUDENT_WALLET, STUDENT_EXPIRY);

        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.CredentialAlreadyIssued.selector, EXPIRED_WALLET));
        sbtVm.prank(SBT_ISSUER);
        identity.mint(EXPIRED_WALLET, STUDENT_EXPIRY);
    }

    function testTierFixtureAndInclusiveExpiry() public {
        require(identity.tierOf(REGULAR_WALLET) == 0, "regular tier");
        require(identity.balanceOf(REGULAR_WALLET) == 0, "regular balance");
        require(identity.tierOf(STUDENT_WALLET) == 1, "student tier");
        require(identity.tierOf(EXPIRED_WALLET) == 0, "expired tier");

        sbtVm.warp(STUDENT_EXPIRY);
        require(identity.tierOf(STUDENT_WALLET) == 1, "tier at expiry");
        sbtVm.warp(STUDENT_EXPIRY + 1);
        require(identity.tierOf(STUDENT_WALLET) == 0, "tier after expiry");

        (uint256 tokenId,) = identity.credentials(STUDENT_WALLET);
        require(identity.balanceOf(STUDENT_WALLET) == 1, "expired balance");
        require(identity.ownerOf(tokenId) == STUDENT_WALLET && identity.locked(tokenId), "expired card stays locked");
    }

    function testRevokeBurnsCredentialAndAllowsReissue() public {
        (uint256 tokenId,) = identity.credentials(STUDENT_WALLET);
        sbtVm.expectEmit(true, true, true, true, address(identity));
        emit StudentSBTIdentity.Transfer(STUDENT_WALLET, address(0), tokenId);

        sbtVm.prank(SBT_ISSUER);
        identity.revoke(tokenId);
        require(identity.tierOf(STUDENT_WALLET) == 0, "revoked tier");
        require(identity.balanceOf(STUDENT_WALLET) == 0, "revoked balance");
        (uint256 storedId, uint64 storedExpiry) = identity.credentials(STUDENT_WALLET);
        require(storedId == 0 && storedExpiry == 0, "cleared credential");

        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.TokenNotFound.selector, tokenId));
        identity.ownerOf(tokenId);
        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.TokenNotFound.selector, tokenId));
        identity.locked(tokenId);
        sbtVm.prank(SBT_ISSUER);
        uint256 newTokenId = identity.mint(STUDENT_WALLET, STUDENT_EXPIRY);
        require(newTokenId != tokenId && identity.locked(newTokenId), "fresh locked token");

        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.TokenNotFound.selector, tokenId));
        sbtVm.prank(SBT_ISSUER);
        identity.revoke(tokenId);
        require(identity.tierOf(STUDENT_WALLET) == 1, "reissued tier");
    }

    function testTransfersAndApprovalsRevert() public {
        (uint256 tokenId,) = identity.credentials(STUDENT_WALLET);
        sbtVm.expectRevert(StudentSBTIdentity.Soulbound.selector);
        sbtVm.prank(STUDENT_WALLET);
        identity.transferFrom(STUDENT_WALLET, REGULAR_WALLET, tokenId);
        sbtVm.expectRevert(StudentSBTIdentity.Soulbound.selector);
        sbtVm.prank(STUDENT_WALLET);
        identity.safeTransferFrom(STUDENT_WALLET, REGULAR_WALLET, tokenId);
        sbtVm.expectRevert(StudentSBTIdentity.Soulbound.selector);
        sbtVm.prank(SBT_ISSUER);
        identity.safeTransferFrom(STUDENT_WALLET, REGULAR_WALLET, tokenId, hex"01");

        sbtVm.expectRevert(StudentSBTIdentity.Soulbound.selector);
        sbtVm.prank(STUDENT_WALLET);
        identity.approve(REGULAR_WALLET, tokenId);
        sbtVm.expectRevert(StudentSBTIdentity.Soulbound.selector);
        sbtVm.prank(STUDENT_WALLET);
        identity.setApprovalForAll(REGULAR_WALLET, true);

        require(identity.getApproved(tokenId) == address(0), "token approval");
        require(!identity.isApprovedForAll(STUDENT_WALLET, REGULAR_WALLET), "operator approval");
        require(identity.ownerOf(tokenId) == STUDENT_WALLET, "owner after transfer attempts");
    }

    function testERC165AndInvalidQueries() public {
        require(identity.supportsInterface(0x01ffc9a7), "ERC-165");
        require(identity.supportsInterface(0x80ac58cd), "ERC-721");
        require(identity.supportsInterface(0xb45a3c0e), "ERC-5192");
        require(!identity.supportsInterface(0xffffffff), "invalid interface");

        sbtVm.expectRevert(StudentSBTIdentity.InvalidWallet.selector);
        identity.balanceOf(address(0));
        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.TokenNotFound.selector, uint256(0)));
        identity.getApproved(0);
        sbtVm.expectRevert(abi.encodeWithSelector(StudentSBTIdentity.TokenNotFound.selector, uint256(0)));
        identity.locked(0);
    }
}
