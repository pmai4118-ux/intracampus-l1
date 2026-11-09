// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @notice A permanently locked ERC-721 credential for the demo student tier.
contract StudentSBTIdentity {
    struct Credential {
        uint256 tokenId;
        uint64 expiresAt;
    }

    error InvalidWallet();
    error UnauthorizedIssuer();
    error InvalidExpiry(uint64 expiresAt);
    error CredentialAlreadyIssued(address wallet);
    error TokenNotFound(uint256 tokenId);
    error Soulbound();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);

    uint8 private constant STUDENT_TIER = 1;

    address public immutable issuer;
    mapping(address wallet => Credential credential) public credentials;
    mapping(uint256 tokenId => address wallet) private owners;
    uint256 private nextTokenId = 1;

    constructor(address issuer_) {
        if (issuer_ == address(0)) revert InvalidWallet();
        issuer = issuer_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert UnauthorizedIssuer();
        _;
    }

    /// @notice Issues tier 1 until expiresAt, inclusive. An existing card must be revoked first.
    function mint(address wallet, uint64 expiresAt) external onlyIssuer returns (uint256 tokenId) {
        if (wallet == address(0)) revert InvalidWallet();
        if (credentials[wallet].tokenId != 0) revert CredentialAlreadyIssued(wallet);
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);

        tokenId = nextTokenId++;
        credentials[wallet] = Credential(tokenId, expiresAt);
        owners[tokenId] = wallet;
        emit Transfer(address(0), wallet, tokenId);
        emit Locked(tokenId);
    }

    /// @notice Burns the current card, ending eligibility and allowing a fresh mint.
    function revoke(uint256 tokenId) external onlyIssuer {
        address wallet = ownerOf(tokenId);
        delete credentials[wallet];
        delete owners[tokenId];
        emit Transfer(wallet, address(0), tokenId);
    }

    /// @notice Returns the effective P02 tier. Expiry ends eligibility without burning the card.
    function tierOf(address wallet) external view returns (uint8) {
        Credential storage credential = credentials[wallet];
        if (credential.tokenId == 0 || block.timestamp > credential.expiresAt) return 0;
        return STUDENT_TIER;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0xb45a3c0e;
    }

    function balanceOf(address wallet) external view returns (uint256) {
        if (wallet == address(0)) revert InvalidWallet();
        return credentials[wallet].tokenId == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address wallet) {
        wallet = owners[tokenId];
        if (wallet == address(0)) revert TokenNotFound(tokenId);
    }

    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }
}
