// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev L04 owns the merchant/category allowlist shared by invoices and grants.
interface IGrantMerchantRegistry {
    function allowedMerchantCategories(address merchant, bytes32 category) external view returns (bool);
}

/// @notice Native CAMPUS grants that beneficiaries can spend only within their funded category.
contract PurposeBoundGrantVault {
    event GrantIssued(
        address indexed beneficiary, bytes32 indexed category, address indexed issuer, uint256 amount, uint256 balance
    );
    event GrantSpent(
        address indexed beneficiary, address indexed merchant, bytes32 indexed category, uint256 amount, uint256 balance
    );

    error InvalidConfiguration();
    error UnauthorizedIssuer();
    error InvalidBeneficiary();
    error InvalidCategory();
    error InvalidAmount();
    error InvalidMerchant(address merchant, bytes32 category);
    error InsufficientGrantBalance(uint256 available, uint256 requested);
    error MerchantTransferFailed(address merchant, uint256 amount);
    error ReentrantGrant();

    address public immutable issuer;
    IGrantMerchantRegistry public immutable merchantRegistry;
    mapping(address beneficiary => mapping(bytes32 category => uint256 balance)) public balances;
    uint256 public totalAllocated;
    bool private entered;

    constructor(address issuer_, address registry_) {
        if (issuer_ == address(0) || registry_.code.length == 0) revert InvalidConfiguration();
        issuer = issuer_;
        merchantRegistry = IGrantMerchantRegistry(registry_);
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantGrant();
        entered = true;
        _;
        entered = false;
    }

    /// @notice Fully funds the grant in native CAMPUS; the issuer chooses its one spending category.
    function grant(address beneficiary, bytes32 category) external payable nonReentrant {
        if (msg.sender != issuer) revert UnauthorizedIssuer();
        if (beneficiary == address(0) || beneficiary == address(this)) revert InvalidBeneficiary();
        if (category == bytes32(0)) revert InvalidCategory();
        if (msg.value == 0) revert InvalidAmount();

        uint256 balance = balances[beneficiary][category] + msg.value;
        balances[beneficiary][category] = balance;
        totalAllocated += msg.value;
        emit GrantIssued(beneficiary, category, msg.sender, msg.value, balance);
    }

    /// @notice Spends only msg.sender's budget, with the current L04 allowlist checked on every call.
    function spend(address merchant, bytes32 category, uint256 amount) external nonReentrant {
        if (category == bytes32(0)) revert InvalidCategory();
        if (amount == 0) revert InvalidAmount();
        if (
            merchant == address(0) || merchant == address(this) || merchant == msg.sender
                || !merchantRegistry.allowedMerchantCategories(merchant, category)
        ) revert InvalidMerchant(merchant, category);

        uint256 available = balances[msg.sender][category];
        if (amount > available) revert InsufficientGrantBalance(available, amount);

        uint256 balance = available - amount;
        balances[msg.sender][category] = balance;
        totalAllocated -= amount;
        (bool sent,) = merchant.call{value: amount}("");
        if (!sent) revert MerchantTransferFailed(merchant, amount);
        emit GrantSpent(msg.sender, merchant, category, amount, balance);
    }
}
