// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface FixtureVm {
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function toString(uint256 value) external pure returns (string memory);
}

/// P02 conformance vectors, not an implementation of the L04 payment registry.
contract InvoiceVectorsTest {
    FixtureVm private constant vm = FixtureVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INVOICE_TYPEHASH =
        keccak256("Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)");

    function fixture() private view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../docs/fixtures/invoice-v1.json"));
    }

    function domainHashFor(string memory json, string memory prefix) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("IntraCampusPayment"),
                keccak256("1"),
                vm.parseJsonUint(json, string.concat(prefix, ".domain.chainId")),
                vm.parseJsonAddress(json, string.concat(prefix, ".domain.verifyingContract"))
            )
        );
    }

    function structHashFor(string memory json, string memory prefix) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                INVOICE_TYPEHASH,
                vm.parseJsonBytes32(json, string.concat(prefix, ".invoice.invoiceId")),
                vm.parseJsonAddress(json, string.concat(prefix, ".invoice.merchant")),
                vm.parseJsonBytes32(json, string.concat(prefix, ".invoice.category")),
                vm.parseJsonUint(json, string.concat(prefix, ".invoice.amount")),
                uint64(vm.parseJsonUint(json, string.concat(prefix, ".invoice.expiresAt")))
            )
        );
    }

    function testAllSharedTypedDataVectors() public view {
        string memory json = fixture();
        bytes memory signature = vm.parseJsonBytes(json, ".envelope.signature");
        require(signature.length == 65, "signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        require(v == 27 || v == 28, "signature v");
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "signature high-s");
        address authorizedSigner = vm.parseJsonAddress(json, ".envelope.signer");
        for (uint256 i; i < 4; ++i) {
            string memory prefix = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 domainHash = domainHashFor(json, prefix);
            bytes32 structHash = structHashFor(json, prefix);
            bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainHash, structHash));
            address recovered = ecrecover(digest, v, r, s);
            require(
                domainHash == vm.parseJsonBytes32(json, string.concat(prefix, ".expected.domainSeparator")), "domain"
            );
            require(structHash == vm.parseJsonBytes32(json, string.concat(prefix, ".expected.structHash")), "struct");
            require(digest == vm.parseJsonBytes32(json, string.concat(prefix, ".expected.digest")), "digest");
            require(
                recovered == vm.parseJsonAddress(json, string.concat(prefix, ".expected.recoveredSigner")), "recover"
            );
            require((recovered == authorizedSigner) == (i == 0), "tampered vector accepted");
        }
    }

    function testSharedIntegerRoundingCases() public view {
        string memory json = fixture();
        for (uint256 i; i < 3; ++i) {
            string memory prefix = string.concat(".pricingCases[", vm.toString(i), "]");
            uint256 amount = vm.parseJsonUint(json, string.concat(prefix, ".amount"));
            uint256 discount = amount * 1000 / 10000;
            require(discount == vm.parseJsonUint(json, string.concat(prefix, ".discountAmount")), "discount rounding");
            require(amount - discount == vm.parseJsonUint(json, string.concat(prefix, ".paidAmount")), "paid amount");
        }
    }
}
