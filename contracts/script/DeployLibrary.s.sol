// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {LibraryDepositEscrow} from "../src/LibraryDepositEscrow.sol";

interface LibraryDeploymentVm {
    function envAddress(string calldata name) external returns (address);
    function envBytes32(string calldata name, string calldata delim) external returns (bytes32[] memory);
    function envUint(string calldata name, string calldata delim) external returns (uint256[] memory);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

abstract contract LibraryScriptBase {
    LibraryDeploymentVm internal constant vm =
        LibraryDeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant CHAIN_ID = 20261;
    uint256 public constant DEPOSIT_WEI = 50 ether;

    struct BookTermSeed {
        bytes32 bookId;
        uint256 depositWei;
        uint256 replacementPriceWei;
    }

    error WrongChain(uint256 actual);
    error InvalidDeploymentConfig();
    error DeploymentReadbackFailed();

    function _loadBooksFromEnv() internal returns (BookTermSeed[] memory books) {
        bytes32[] memory ids = vm.envBytes32("LIBRARY_BOOK_IDS", ",");
        uint256[] memory prices = vm.envUint("LIBRARY_BOOK_REPLACEMENT_PRICES_WEI", ",");
        if (ids.length == 0 || ids.length != prices.length) revert InvalidDeploymentConfig();
        books = new BookTermSeed[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            books[i] = BookTermSeed({bookId: ids[i], depositWei: DEPOSIT_WEI, replacementPriceWei: prices[i]});
        }
    }

    function _validateBooks(BookTermSeed[] memory books) internal pure {
        if (books.length == 0) revert InvalidDeploymentConfig();
        for (uint256 i; i < books.length; ++i) {
            if (
                books[i].bookId == bytes32(0) || books[i].depositWei != DEPOSIT_WEI || books[i].replacementPriceWei == 0
            ) {
                revert InvalidDeploymentConfig();
            }
            for (uint256 j; j < i; ++j) {
                if (books[j].bookId == books[i].bookId) revert InvalidDeploymentConfig();
            }
        }
    }

    function _verifyBooksReadback(BookTermSeed[] memory books, LibraryDepositEscrow escrow) internal view {
        for (uint256 i; i < books.length; ++i) {
            (uint256 depositWei, uint256 replacementPriceWei, bool isSealed) = escrow.bookTerms(books[i].bookId);
            if (!isSealed || depositWei != books[i].depositWei || replacementPriceWei != books[i].replacementPriceWei) {
                revert DeploymentReadbackFailed();
            }
        }
    }
}

/// @notice Deploy LibraryDepositEscrow and seed/seal initial book terms with an external Forge signer.
contract DeployLibrary is LibraryScriptBase {
    struct Config {
        address deployer;
        address administrator;
        address librarian;
        address treasury;
        BookTermSeed[] books;
    }

    function run() external returns (LibraryDepositEscrow escrow) {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        Config memory config = Config({
            deployer: vm.envAddress("DEPLOYER_ADDRESS"),
            administrator: vm.envAddress("LIBRARY_ADMIN_ADDRESS"),
            librarian: vm.envAddress("LIBRARY_LIBRARIAN_ADDRESS"),
            treasury: vm.envAddress("LIBRARY_TREASURY_ADDRESS"),
            books: _loadBooksFromEnv()
        });
        validate(config);
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);

        vm.startBroadcast(config.deployer);
        escrow = new LibraryDepositEscrow(config.administrator, config.librarian, config.treasury);
        if (config.administrator != config.deployer) {
            vm.stopBroadcast();
            vm.startBroadcast(config.administrator);
        }
        for (uint256 i; i < config.books.length; ++i) {
            BookTermSeed memory book = config.books[i];
            escrow.seedBookTerms(book.bookId, book.depositWei, book.replacementPriceWei);
            escrow.sealBookTerms(book.bookId);
        }
        vm.stopBroadcast();

        verify(config, escrow);
    }

    function validate(Config memory config) public pure {
        if (
            config.deployer == address(0) || config.administrator == address(0) || config.librarian == address(0)
                || config.treasury == address(0)
        ) {
            revert InvalidDeploymentConfig();
        }
        if (
            config.treasury == config.deployer || config.treasury == config.administrator
                || config.treasury == config.librarian
        ) {
            revert InvalidDeploymentConfig();
        }
        _validateBooks(config.books);
    }

    function verify(Config memory config, LibraryDepositEscrow escrow) public view {
        if (
            escrow.administrator() != config.administrator || escrow.librarian() != config.librarian
                || escrow.treasury() != config.treasury || escrow.APPROVAL_WINDOW() != 86_400
                || escrow.LOAN_DURATION() != 1_209_600 || escrow.GRACE_PERIOD() != 259_200
                || escrow.LATE_FEE_INTERVAL() != 86_400 || escrow.LATE_FEE_PER_INTERVAL() != 0.1 ether
                || escrow.MAX_LATE_FEE() != 25 ether || escrow.FULL_DEPOSIT_RETENTION_AFTER() != 2_592_000
        ) {
            revert DeploymentReadbackFailed();
        }
        _verifyBooksReadback(config.books, escrow);
    }
}

/// @notice Idempotently verifies or seeds/seals unsealed books on an existing escrow; never overwrites sealed terms.
contract SeedLibraryBooks is LibraryScriptBase {
    error SealedBookTermsMismatch(
        bytes32 bookId,
        uint256 sealedDepositWei,
        uint256 sealedReplacementPriceWei,
        uint256 requestedDepositWei,
        uint256 requestedReplacementPriceWei
    );

    function run() external {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        address escrowAddress = vm.envAddress("LIBRARY_ESCROW_ADDRESS");
        address administrator = vm.envAddress("LIBRARY_ADMIN_ADDRESS");
        BookTermSeed[] memory books = _loadBooksFromEnv();
        if (escrowAddress == address(0) || escrowAddress.code.length == 0 || administrator == address(0)) {
            revert InvalidDeploymentConfig();
        }
        _validateBooks(books);

        LibraryDepositEscrow escrow = LibraryDepositEscrow(escrowAddress);
        if (escrow.administrator() != administrator) revert InvalidDeploymentConfig();

        bool[] memory needsSeed = new bool[](books.length);
        bool[] memory needsSeal = new bool[](books.length);
        bool anyBroadcast;

        for (uint256 i; i < books.length; ++i) {
            (uint256 currentDeposit, uint256 currentPrice, bool isSealed) = escrow.bookTerms(books[i].bookId);
            if (isSealed) {
                if (currentDeposit != books[i].depositWei || currentPrice != books[i].replacementPriceWei) {
                    revert SealedBookTermsMismatch(
                        books[i].bookId, currentDeposit, currentPrice, books[i].depositWei, books[i].replacementPriceWei
                    );
                }
            } else {
                needsSeal[i] = true;
                anyBroadcast = true;
                if (currentDeposit != books[i].depositWei || currentPrice != books[i].replacementPriceWei) {
                    needsSeed[i] = true;
                }
            }
        }

        if (anyBroadcast) {
            if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
            vm.startBroadcast(administrator);
            for (uint256 i; i < books.length; ++i) {
                if (needsSeed[i]) {
                    escrow.seedBookTerms(books[i].bookId, books[i].depositWei, books[i].replacementPriceWei);
                }
                if (needsSeal[i]) {
                    escrow.sealBookTerms(books[i].bookId);
                }
            }
            vm.stopBroadcast();
        }

        _verifyBooksReadback(books, escrow);
    }
}
