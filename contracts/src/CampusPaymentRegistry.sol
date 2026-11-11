// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ECDSA} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

interface IStudentTier {
    function tierOf(address payer) external view returns (uint8);
}

/// @notice Settles P02 invoices in native CAMPUS using the payer's effective SBT tier.
contract CampusPaymentRegistry {
    struct Invoice {
        bytes32 invoiceId;
        address merchant;
        bytes32 category;
        uint256 amount;
        uint64 expiresAt;
    }

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed merchant,
        bytes32 category,
        uint256 originalAmount,
        uint256 discountAmount,
        uint256 paidAmount,
        uint8 tier
    );
    event MerchantCategoryUpdated(address indexed merchant, bytes32 indexed category, bool allowed);

    error InvoiceExpired(bytes32 invoiceId, uint64 expiresAt, uint256 currentTimestamp);
    error InvoiceAlreadyPaid(bytes32 invoiceId);
    error InvalidSignature(address recoveredSigner, address expectedSigner);
    error InvalidMerchantOrCategory(address merchant, bytes32 category);
    error IncorrectPaymentAmount(uint256 sentValue, uint256 requiredAmount);
    error MerchantTransferFailed(address merchant, uint256 amount);
    error InvalidConfiguration();
    error UnauthorizedAdmin();
    error InvalidInvoice();
    error UnsupportedTier(uint8 tier);
    error ReentrantPayment();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("IntraCampusPayment");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant INVOICE_TYPEHASH =
        keccak256("Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)");

    address public immutable admin;
    address public immutable posSigner;
    IStudentTier public immutable studentSbt;
    mapping(address merchant => mapping(bytes32 category => bool allowed)) public allowedMerchantCategories;
    mapping(bytes32 invoiceId => bool paid) private paidInvoices;
    bool private paying;

    constructor(address admin_, address posSigner_, address studentSbt_) {
        if (admin_ == address(0) || posSigner_ == address(0) || studentSbt_.code.length == 0) {
            revert InvalidConfiguration();
        }
        admin = admin_;
        posSigner = posSigner_;
        studentSbt = IStudentTier(studentSbt_);
    }

    modifier nonReentrant() {
        if (paying) revert ReentrantPayment();
        paying = true;
        _;
        paying = false;
    }

    /// @notice Allows or disables one exact merchant/category pair, including outstanding invoices.
    function setMerchantCategory(address merchant, bytes32 category, bool allowed) external {
        if (msg.sender != admin) revert UnauthorizedAdmin();
        if (merchant == address(0) || merchant == address(this) || category == bytes32(0)) {
            revert InvalidMerchantOrCategory(merchant, category);
        }
        allowedMerchantCategories[merchant][category] = allowed;
        emit MerchantCategoryUpdated(merchant, category, allowed);
    }

    /// @notice Quotes current eligibility; the caller must still verify the signature and simulate payment.
    function quoteInvoice(Invoice calldata invoice, address payer)
        external
        view
        returns (uint8 tier, uint256 discountAmount, uint256 paidAmount)
    {
        _validateInvoice(invoice);
        return _quote(invoice.amount, payer);
    }

    function isInvoicePaid(bytes32 invoiceId) external view returns (bool) {
        return paidInvoices[invoiceId];
    }

    function payInvoice(Invoice calldata invoice, bytes calldata signature) external payable nonReentrant {
        _validateInvoice(invoice);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(_invoiceDigest(invoice), signature);
        if (error != ECDSA.RecoverError.NoError || recovered != posSigner) {
            revert InvalidSignature(recovered, posSigner);
        }

        (uint8 tier, uint256 discountAmount, uint256 paidAmount) = _quote(invoice.amount, msg.sender);
        if (msg.value != paidAmount) revert IncorrectPaymentAmount(msg.value, paidAmount);

        paidInvoices[invoice.invoiceId] = true;
        (bool sent,) = invoice.merchant.call{value: paidAmount}("");
        if (!sent) revert MerchantTransferFailed(invoice.merchant, paidAmount);

        emit InvoicePaid(
            invoice.invoiceId,
            msg.sender,
            invoice.merchant,
            invoice.category,
            invoice.amount,
            discountAmount,
            paidAmount,
            tier
        );
    }

    function _validateInvoice(Invoice calldata invoice) private view {
        if (paidInvoices[invoice.invoiceId]) revert InvoiceAlreadyPaid(invoice.invoiceId);
        // P02 defines expiry by chain time and includes the expiresAt second itself.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > invoice.expiresAt) {
            revert InvoiceExpired(invoice.invoiceId, invoice.expiresAt, block.timestamp);
        }
        if (invoice.invoiceId == bytes32(0) || invoice.amount == 0) revert InvalidInvoice();
        if (!allowedMerchantCategories[invoice.merchant][invoice.category]) {
            revert InvalidMerchantOrCategory(invoice.merchant, invoice.category);
        }
    }

    function _quote(uint256 amount, address payer)
        private
        view
        returns (uint8 tier, uint256 discountAmount, uint256 paidAmount)
    {
        tier = studentSbt.tierOf(payer);
        if (tier > 1) revert UnsupportedTier(tier);
        // P02 fixes tier 1 at 1000 bps. floor(amount / 10) avoids amount * 1000 overflowing.
        discountAmount = tier == 1 ? amount / 10 : 0;
        paidAmount = amount - discountAmount;
    }

    function _invoiceDigest(Invoice calldata invoice) private view returns (bytes32) {
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 structHash = keccak256(
            abi.encode(
                INVOICE_TYPEHASH,
                invoice.invoiceId,
                invoice.merchant,
                invoice.category,
                invoice.amount,
                invoice.expiresAt
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
