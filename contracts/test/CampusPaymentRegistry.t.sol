// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CampusPaymentRegistry} from "../src/CampusPaymentRegistry.sol";
import {StudentSBTIdentity} from "../src/StudentSBTIdentity.sol";
import {StudentSBTFixture} from "./fixtures/StudentSBTFixture.sol";

interface PaymentVm {
    function expectPartialRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function deal(address account, uint256 balance) external;
    function chainId(uint256 chainId_) external;
    function etch(address target, bytes calldata code) external;
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
}

contract RejectingMerchant {
    receive() external payable {
        revert("merchant unavailable");
    }
}

contract ReenteringMerchant {
    CampusPaymentRegistry private registry;
    CampusPaymentRegistry.Invoice private invoice;
    bytes private signature;
    bool public observedPaid;
    bool public reentrySucceeded;
    bytes4 public reentryError;

    function configure(CampusPaymentRegistry registry_, CampusPaymentRegistry.Invoice memory invoice_, bytes memory sig)
        external
    {
        registry = registry_;
        invoice = invoice_;
        signature = sig;
    }

    receive() external payable {
        observedPaid = registry.isInvoicePaid(invoice.invoiceId);
        bytes memory result;
        (reentrySucceeded, result) = address(registry).call{value: msg.value}(
            abi.encodeCall(CampusPaymentRegistry.payInvoice, (invoice, signature))
        );
        // Keep the first four revert bytes, which intentionally contain only the error selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        reentryError = bytes4(result);
    }
}

contract InvalidTierSource {
    function tierOf(address) external pure returns (uint8) {
        return 2;
    }
}

contract FailingTierSource {
    function tierOf(address) external pure returns (uint8) {
        revert("SBT unavailable");
    }
}

contract CampusPaymentRegistryTest is StudentSBTFixture {
    PaymentVm private constant vm = PaymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ADMIN = address(0xA11CE);
    address private constant MERCHANT = address(0x2000);
    uint256 private constant SIGNER_KEY = 0xBEEF; // Synthetic test signer only.
    bytes32 private constant PARKING = keccak256("PARKING");
    bytes32 private constant CANTEEN = keccak256("CANTEEN");
    StudentSBTIdentity private identity;
    CampusPaymentRegistry private registry;
    address private signer;

    function setUp() public {
        vm.chainId(20261);
        identity = deployStudentSBTFixture();
        signer = vm.addr(SIGNER_KEY);
        registry = new CampusPaymentRegistry(ADMIN, signer, address(identity));
        _allow(registry, MERCHANT, PARKING, true);
        vm.deal(REGULAR_WALLET, 10000 ether);
        vm.deal(STUDENT_WALLET, 10000 ether);
        vm.deal(EXPIRED_WALLET, 10000 ether);
    }

    function _allow(CampusPaymentRegistry target, address merchant, bytes32 category, bool allowed) private {
        sbtVm.prank(ADMIN);
        target.setMerchantCategory(merchant, category, allowed);
    }

    function _invoice() private pure returns (CampusPaymentRegistry.Invoice memory) {
        return
            CampusPaymentRegistry.Invoice(
                keccak256("L04-test-invoice"), MERCHANT, PARKING, 3000 ether, FIXTURE_TIME + 300
            );
    }

    function _signatureFor(
        CampusPaymentRegistry.Invoice memory invoice,
        uint256 chainId_,
        address verifier,
        uint256 key
    ) private pure returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IntraCampusPayment"),
                keccak256("1"),
                chainId_,
                verifier
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)"
                ),
                invoice.invoiceId,
                invoice.merchant,
                invoice.category,
                invoice.amount,
                invoice.expiresAt
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _signature(CampusPaymentRegistry.Invoice memory invoice) private view returns (bytes memory) {
        return _signatureFor(invoice, block.chainid, address(registry), SIGNER_KEY);
    }

    function _pay(CampusPaymentRegistry.Invoice memory invoice, bytes memory sig, address payer, uint256 value)
        private
    {
        sbtVm.prank(payer);
        registry.payInvoice{value: value}(invoice, sig);
    }

    function testDeploymentConfiguration() public view {
        require(registry.admin() == ADMIN && registry.posSigner() == signer, "admin/signer");
        require(address(registry.studentSbt()) == address(identity), "SBT source");
        require(registry.allowedMerchantCategories(MERCHANT, PARKING), "registered pair");
        require(!registry.allowedMerchantCategories(MERCHANT, CANTEEN), "unregistered pair");
    }

    function testDeploymentRejectsInvalidConfiguration() public {
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidConfiguration.selector);
        new CampusPaymentRegistry(address(0), signer, address(identity));
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidConfiguration.selector);
        new CampusPaymentRegistry(ADMIN, address(0), address(identity));
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidConfiguration.selector);
        new CampusPaymentRegistry(ADMIN, signer, address(0));
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidConfiguration.selector);
        new CampusPaymentRegistry(ADMIN, signer, REGULAR_WALLET);
    }

    function testOnlyAdminCanChangeMerchantCategory() public {
        sbtVm.expectRevert(CampusPaymentRegistry.UnauthorizedAdmin.selector);
        sbtVm.prank(REGULAR_WALLET);
        registry.setMerchantCategory(MERCHANT, PARKING, false);
        require(registry.allowedMerchantCategories(MERCHANT, PARKING), "unauthorized change");

        sbtVm.expectEmit(true, true, false, true, address(registry));
        emit CampusPaymentRegistry.MerchantCategoryUpdated(MERCHANT, PARKING, false);
        _allow(registry, MERCHANT, PARKING, false);
        require(!registry.allowedMerchantCategories(MERCHANT, PARKING), "disabled pair");
        _allow(registry, MERCHANT, PARKING, true);
        require(registry.allowedMerchantCategories(MERCHANT, PARKING), "re-enabled pair");
    }

    function testRegistryRejectsInvalidPairs() public {
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _allow(registry, address(0), PARKING, true);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _allow(registry, address(registry), PARKING, true);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _allow(registry, MERCHANT, bytes32(0), true);
    }

    function _assertSettlement(address payer, uint8 tier, uint256 discount, uint256 paid) private {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signature(invoice);
        {
            (uint8 quotedTier, uint256 quotedDiscount, uint256 quotedPaid) = registry.quoteInvoice(invoice, payer);
            require(quotedTier == tier && quotedDiscount == discount && quotedPaid == paid, "quote");
        }
        uint256 merchantBefore = MERCHANT.balance;
        uint256 payerBefore = payer.balance;
        sbtVm.expectEmit(true, true, true, true, address(registry));
        emit CampusPaymentRegistry.InvoicePaid(
            invoice.invoiceId, payer, MERCHANT, PARKING, invoice.amount, discount, paid, tier
        );
        _pay(invoice, sig, payer, paid);
        require(registry.isInvoicePaid(invoice.invoiceId), "paid flag");
        require(MERCHANT.balance - merchantBefore == paid, "merchant received");
        require(payerBefore - payer.balance == paid, "payer charged");
        require(address(registry).balance == 0, "no retained payment");
    }

    function testStandardInvoiceSettlementAndEvent() public {
        _assertSettlement(REGULAR_WALLET, 0, 0, 3000 ether);
    }

    function testStudentInvoiceSettlementAndEvent() public {
        _assertSettlement(STUDENT_WALLET, 1, 300 ether, 2700 ether);
    }

    function testExpiredSbtPaysFullPrice() public {
        _assertSettlement(EXPIRED_WALLET, 0, 0, 3000 ether);
    }

    function testRevokedSbtPaysFullPrice() public {
        (uint256 tokenId,) = identity.credentials(STUDENT_WALLET);
        sbtVm.prank(SBT_ISSUER);
        identity.revoke(tokenId);
        _assertSettlement(STUDENT_WALLET, 0, 0, 3000 ether);
    }

    function testInvoiceValidAtExactExpiry() public {
        sbtVm.warp(FIXTURE_TIME + 300);
        _assertSettlement(STUDENT_WALLET, 1, 300 ether, 2700 ether);
    }

    function testSbtTierChangesAfterInclusiveExpiry() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.expiresAt = STUDENT_EXPIRY + 300;
        sbtVm.warp(STUDENT_EXPIRY);
        (uint8 tier,, uint256 paid) = registry.quoteInvoice(invoice, STUDENT_WALLET);
        require(tier == 1 && paid == 2700 ether, "SBT inclusive expiry");
        bytes memory sig = _signature(invoice);
        sbtVm.warp(STUDENT_EXPIRY + 1);
        sbtVm.expectRevert(
            abi.encodeWithSelector(CampusPaymentRegistry.IncorrectPaymentAmount.selector, paid, 3000 ether)
        );
        _pay(invoice, sig, STUDENT_WALLET, paid);
        require(!registry.isInvoicePaid(invoice.invoiceId), "failed quote race marked paid");
        _pay(invoice, sig, STUDENT_WALLET, 3000 ether);
    }

    function testExpiredInvoiceRejectedInQuoteAndPay() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signature(invoice);
        sbtVm.warp(invoice.expiresAt + 1);
        bytes memory expected = abi.encodeWithSelector(
            CampusPaymentRegistry.InvoiceExpired.selector, invoice.invoiceId, invoice.expiresAt, block.timestamp
        );
        sbtVm.expectRevert(expected);
        registry.quoteInvoice(invoice, REGULAR_WALLET);
        sbtVm.expectRevert(expected);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(!registry.isInvoicePaid(invoice.invoiceId) && MERCHANT.balance == 0, "expired mutated state");
    }

    function testIncorrectValueRejectedWithoutConsumingInvoice() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signature(invoice);
        uint256[3] memory sent = [uint256(0), uint256(2700 ether - 1), uint256(3000 ether)];
        for (uint256 i; i < sent.length; ++i) {
            sbtVm.expectRevert(
                abi.encodeWithSelector(CampusPaymentRegistry.IncorrectPaymentAmount.selector, sent[i], 2700 ether)
            );
            _pay(invoice, sig, STUDENT_WALLET, sent[i]);
            require(!registry.isInvoicePaid(invoice.invoiceId), "wrong amount marked paid");
        }
        _pay(invoice, sig, STUDENT_WALLET, 2700 ether);
    }

    function testReplayRejectedAcrossPayersAndSignedPayloads() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        _pay(invoice, _signature(invoice), REGULAR_WALLET, invoice.amount);
        invoice.amount = 100 ether; // Even a newly signed payload cannot reuse a settled invoiceId.
        bytes memory sig = _signature(invoice);
        sbtVm.expectRevert(abi.encodeWithSelector(CampusPaymentRegistry.InvoiceAlreadyPaid.selector, invoice.invoiceId));
        _pay(invoice, sig, STUDENT_WALLET, 90 ether);
        sbtVm.warp(invoice.expiresAt + 1);
        vm.expectPartialRevert(CampusPaymentRegistry.InvoiceAlreadyPaid.selector);
        registry.quoteInvoice(invoice, REGULAR_WALLET);
        require(MERCHANT.balance == 3000 ether, "replay transferred funds");
    }

    function testMerchantDisabledAfterSigning() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signature(invoice);
        _allow(registry, MERCHANT, PARKING, false);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        registry.quoteInvoice(invoice, REGULAR_WALLET);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(!registry.isInvoicePaid(invoice.invoiceId), "disabled merchant marked paid");
    }

    function testMerchantAndCategoryMustBeAllowedAsOnePair() public {
        _allow(registry, address(0x2001), CANTEEN, true);
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.category = CANTEEN;
        bytes memory sig = _signature(invoice);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice.merchant = address(0x2002);
        sig = _signature(invoice);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidMerchantOrCategory.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
    }

    function testZeroAmountAndIdRejected() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.amount = 0;
        bytes memory sig = _signature(invoice);
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidInvoice.selector);
        _pay(invoice, sig, REGULAR_WALLET, 0);
        invoice = _invoice();
        invoice.invoiceId = bytes32(0);
        sbtVm.expectRevert(CampusPaymentRegistry.InvalidInvoice.selector);
        registry.quoteInvoice(invoice, REGULAR_WALLET);
    }

    function testWrongSignerAndTamperedSignedFieldsRejected() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signatureFor(invoice, block.chainid, address(registry), 0xBAD);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        sig = _signature(invoice);
        invoice.amount -= 1;
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice = _invoice();
        invoice.expiresAt += 1;
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice = _invoice();
        invoice.invoiceId = keccak256("tampered-id");
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice = _invoice();
        invoice.merchant = address(0x2001);
        _allow(registry, invoice.merchant, PARKING, true);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice = _invoice();
        invoice.category = CANTEEN;
        _allow(registry, MERCHANT, CANTEEN, true);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
    }

    function testWrongChainAndVerifierRejected() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory sig = _signatureFor(invoice, 43113, address(registry), SIGNER_KEY);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        sig = _signatureFor(invoice, block.chainid, address(0x99999), SIGNER_KEY);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        sig = _signature(invoice);
        vm.chainId(43113);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
    }

    function testMalformedSignaturesMapToP02Error() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        bytes memory valid = _signature(invoice);
        bytes[] memory signatures = new bytes[](5);
        signatures[0] = hex"";
        signatures[1] = new bytes(64);
        signatures[2] = new bytes(65); // ecrecover returns zero.
        signatures[3] = abi.encodePacked(bytes32(uint256(1)), bytes32(type(uint256).max), uint8(27));
        valid[64] = bytes1(uint8(1)); // P02 accepts v 27/28 only.
        signatures[4] = valid;
        for (uint256 i; i < signatures.length; ++i) {
            sbtVm.expectRevert(
                abi.encodeWithSelector(CampusPaymentRegistry.InvalidSignature.selector, address(0), signer)
            );
            _pay(invoice, signatures[i], REGULAR_WALLET, invoice.amount);
        }
        require(!registry.isInvoicePaid(invoice.invoiceId), "bad signature consumed invoice");
    }

    function testMerchantTransferFailureRollsBackAndAllowsRetry() public {
        RejectingMerchant merchant = new RejectingMerchant();
        _allow(registry, address(merchant), PARKING, true);
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.merchant = address(merchant);
        bytes memory sig = _signature(invoice);
        uint256 balanceBefore = REGULAR_WALLET.balance;
        sbtVm.expectRevert(
            abi.encodeWithSelector(
                CampusPaymentRegistry.MerchantTransferFailed.selector, address(merchant), invoice.amount
            )
        );
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(!registry.isInvoicePaid(invoice.invoiceId), "failed transfer consumed invoice");
        require(
            REGULAR_WALLET.balance == balanceBefore && address(registry).balance == 0, "failed transfer retained funds"
        );
        vm.etch(address(merchant), hex""); // Recipient becomes payable for the retry in this local test.
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(registry.isInvoicePaid(invoice.invoiceId), "retry failed");
    }

    function testMarksPaidBeforeMerchantCallAndBlocksReentry() public {
        ReenteringMerchant merchant = new ReenteringMerchant();
        _allow(registry, address(merchant), PARKING, true);
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.merchant = address(merchant);
        bytes memory sig = _signature(invoice);
        merchant.configure(registry, invoice, sig);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(merchant.observedPaid(), "CEI ordering");
        require(!merchant.reentrySucceeded(), "reentry succeeded");
        require(merchant.reentryError() == CampusPaymentRegistry.ReentrantPayment.selector, "reentry guard");
        require(address(merchant).balance == invoice.amount && address(registry).balance == 0, "reentry balance");
    }

    function testUnsupportedOrFailingSbtCannotSettle() public {
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        registry = new CampusPaymentRegistry(ADMIN, signer, address(new InvalidTierSource()));
        _allow(registry, MERCHANT, PARKING, true);
        bytes memory sig = _signature(invoice);
        sbtVm.expectRevert(abi.encodeWithSelector(CampusPaymentRegistry.UnsupportedTier.selector, uint8(2)));
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(!registry.isInvoicePaid(invoice.invoiceId), "unknown tier consumed invoice");
        registry = new CampusPaymentRegistry(ADMIN, signer, address(new FailingTierSource()));
        _allow(registry, MERCHANT, PARKING, true);
        sig = _signature(invoice);
        sbtVm.expectRevert(abi.encodeWithSignature("Error(string)", "SBT unavailable"));
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(!registry.isInvoicePaid(invoice.invoiceId), "failed SBT consumed invoice");
    }

    function testFuzzPricingDoesNotOverflow(uint256 amount) public view {
        if (amount == 0) amount = 1;
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.amount = amount;
        (uint8 tier, uint256 discount, uint256 paid) = registry.quoteInvoice(invoice, STUDENT_WALLET);
        require(tier == 1 && discount == amount / 10 && paid + discount == amount, "student price invariant");
        (tier, discount, paid) = registry.quoteInvoice(invoice, REGULAR_WALLET);
        require(tier == 0 && discount == 0 && paid == amount, "standard price invariant");
    }

    function testFuzzSettlementConservesFunds(uint128 rawAmount, bool student) public {
        uint256 amount = uint256(rawAmount) + 1;
        address payer = student ? STUDENT_WALLET : REGULAR_WALLET;
        vm.deal(payer, amount);
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        invoice.amount = amount;
        uint256 paid = student ? amount - amount / 10 : amount;
        _pay(invoice, _signature(invoice), payer, paid);
        require(MERCHANT.balance == paid && payer.balance == amount - paid, "conservation");
        require(registry.isInvoicePaid(invoice.invoiceId) && address(registry).balance == 0, "settled state");
    }

    function _sharedFixture() private returns (CampusPaymentRegistry.Invoice memory invoice, bytes memory sig) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../docs/fixtures/invoice-v1.json"));
        registry = new CampusPaymentRegistry(ADMIN, vm.parseJsonAddress(json, ".envelope.signer"), address(identity));
        address verifier = vm.parseJsonAddress(json, ".envelope.domain.verifyingContract");
        vm.etch(verifier, address(registry).code);
        registry = CampusPaymentRegistry(verifier);
        invoice = CampusPaymentRegistry.Invoice(
            vm.parseJsonBytes32(json, ".envelope.invoice.invoiceId"),
            vm.parseJsonAddress(json, ".envelope.invoice.merchant"),
            vm.parseJsonBytes32(json, ".envelope.invoice.category"),
            vm.parseJsonUint(json, ".envelope.invoice.amount"),
            uint64(vm.parseJsonUint(json, ".envelope.invoice.expiresAt"))
        );
        _allow(registry, invoice.merchant, invoice.category, true);
        sig = vm.parseJsonBytes(json, ".envelope.signature");
    }

    function testSharedP02FixtureSettlesStandard() public {
        (CampusPaymentRegistry.Invoice memory invoice, bytes memory sig) = _sharedFixture();
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        require(registry.isInvoicePaid(invoice.invoiceId) && invoice.merchant.balance == invoice.amount, "P02 standard");
    }

    function testSharedP02FixtureSettlesStudent() public {
        (CampusPaymentRegistry.Invoice memory invoice, bytes memory sig) = _sharedFixture();
        sbtVm.expectEmit(true, true, true, true, address(registry));
        emit CampusPaymentRegistry.InvoicePaid(
            invoice.invoiceId,
            STUDENT_WALLET,
            invoice.merchant,
            invoice.category,
            invoice.amount,
            300 ether,
            2700 ether,
            1
        );
        _pay(invoice, sig, STUDENT_WALLET, 2700 ether);
        require(registry.isInvoicePaid(invoice.invoiceId) && invoice.merchant.balance == 2700 ether, "P02 student");
    }

    function testSharedP02RoundingCasesQuoteImplementation() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../docs/fixtures/invoice-v1.json"));
        string[3] memory prefixes = [string(".pricingCases[0]"), ".pricingCases[1]", ".pricingCases[2]"];
        CampusPaymentRegistry.Invoice memory invoice = _invoice();
        for (uint256 i; i < prefixes.length; ++i) {
            invoice.amount = vm.parseJsonUint(json, string.concat(prefixes[i], ".amount"));
            (uint8 tier, uint256 discount, uint256 paid) = registry.quoteInvoice(invoice, STUDENT_WALLET);
            require(tier == 1, "fixture student tier");
            require(
                discount == vm.parseJsonUint(json, string.concat(prefixes[i], ".discountAmount")), "fixture discount"
            );
            require(paid == vm.parseJsonUint(json, string.concat(prefixes[i], ".paidAmount")), "fixture paid amount");
        }
    }

    function testSharedP02NegativeFixturesRejectedByImplementation() public {
        (CampusPaymentRegistry.Invoice memory invoice, bytes memory sig) = _sharedFixture();
        invoice.amount = 2700 ether;
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        invoice.amount = 3000 ether;
        vm.chainId(43113);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
        vm.chainId(20261);
        address otherVerifier = address(0x99999);
        vm.etch(otherVerifier, address(registry).code);
        registry = CampusPaymentRegistry(otherVerifier);
        _allow(registry, invoice.merchant, invoice.category, true);
        vm.expectPartialRevert(CampusPaymentRegistry.InvalidSignature.selector);
        _pay(invoice, sig, REGULAR_WALLET, invoice.amount);
    }
}
