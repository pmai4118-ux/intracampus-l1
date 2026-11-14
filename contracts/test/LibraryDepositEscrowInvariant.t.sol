// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {LibraryDepositEscrow} from "../src/LibraryDepositEscrow.sol";

interface InvariantVm {
    function chainId(uint256 chainId_) external;
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
}

contract LibraryDepositEscrowHandler {
    InvariantVm private constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant DEPOSIT_WEI = 50 ether;
    address public constant ADMIN = address(0xA001);
    address public constant LIBRARIAN = address(0xA002);
    address public constant TREASURY = address(0xA003);
    address public constant CLAIMANT = address(0xA004);

    LibraryDepositEscrow public immutable escrow;
    address[3] public borrowers;
    bytes32[3] public books;
    bytes32[] private requestIds;
    uint256 private nextNonce;
    uint256 public immutable initialSystemBalance;

    constructor() {
        vm.chainId(20261);
        vm.warp(1_794_200_000);
        escrow = new LibraryDepositEscrow(ADMIN, LIBRARIAN, TREASURY);
        borrowers = [address(0xB001), address(0xB002), address(0xB003)];
        books = [keccak256("INV-BOOK-30"), keccak256("INV-BOOK-50"), keccak256("INV-BOOK-80")];
        uint256[3] memory prices = [uint256(30 ether), uint256(50 ether), uint256(80 ether)];

        for (uint256 i; i < 3; ++i) {
            vm.prank(ADMIN);
            escrow.seedBookTerms(books[i], DEPOSIT_WEI, prices[i]);
            vm.prank(ADMIN);
            escrow.sealBookTerms(books[i]);
            vm.deal(borrowers[i], 5_000 ether);
        }
        initialSystemBalance = 15_000 ether;
    }

    function deposit(uint8 borrowerSeed, uint8 bookSeed) external {
        address borrower = borrowers[borrowerSeed % borrowers.length];
        bytes32 bookId = books[bookSeed % books.length];
        bytes32 requestId = keccak256(abi.encodePacked("INV-REQ", nextNonce));
        nextNonce++;
        requestIds.push(requestId);
        vm.prank(borrower);
        escrow.deposit{value: DEPOSIT_WEI}(requestId, bookId);
    }

    function approve(uint256 indexSeed) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (,,,, uint64 depositedAt,,, uint8 state,) = escrow.requestInfo(requestId);
        if (state != 1 || block.timestamp >= depositedAt + escrow.APPROVAL_WINDOW()) return;
        vm.prank(LIBRARIAN);
        escrow.approve(requestId);
    }

    function reject(uint256 indexSeed) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (,,,,,,, uint8 state,) = escrow.requestInfo(requestId);
        if (state != 1) return;
        vm.prank(LIBRARIAN);
        escrow.reject(requestId);
    }

    function claimExpiredRefund(uint256 indexSeed) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (,,,, uint64 depositedAt,,, uint8 state,) = escrow.requestInfo(requestId);
        if (state != 1 || block.timestamp < depositedAt + escrow.APPROVAL_WINDOW()) return;
        vm.prank(CLAIMANT);
        escrow.claimExpiredRefund(requestId);
    }

    function settleReturn(uint256 indexSeed, uint256 repairWei) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (,,,,,,, uint8 state,) = escrow.requestInfo(requestId);
        if (state != 2) return;
        vm.prank(LIBRARIAN);
        escrow.settleReturn(requestId, repairWei % 100 ether);
    }

    function settleLost(uint256 indexSeed) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (,,,,,,, uint8 state,) = escrow.requestInfo(requestId);
        if (state != 2) return;
        vm.prank(LIBRARIAN);
        escrow.settleLost(requestId);
    }

    function payShortfall(uint256 indexSeed) external {
        if (requestIds.length == 0) return;
        bytes32 requestId = requestIds[indexSeed % requestIds.length];
        (address borrower,,,,,,, uint8 state, uint256 shortfallWei) = escrow.requestInfo(requestId);
        if (state != 5) return;
        vm.prank(borrower);
        escrow.payShortfall{value: shortfallWei}(requestId);
    }

    function warpTime(uint32 deltaSeconds) external {
        uint256 step = (uint256(deltaSeconds) % 45 days) + 1;
        vm.warp(block.timestamp + step);
    }

    function requestCount() external view returns (uint256) {
        return requestIds.length;
    }

    function requestIdAt(uint256 index) external view returns (bytes32) {
        return requestIds[index];
    }

    function expectedEscrowLiability() external view returns (uint256 total) {
        for (uint256 i; i < requestIds.length; ++i) {
            (,, uint256 depWei,,,,, uint8 state,) = escrow.requestInfo(requestIds[i]);
            if (state == 1 || state == 2) {
                total += depWei;
            }
        }
    }

    function currentSystemBalance() external view returns (uint256 total) {
        total = address(escrow).balance + TREASURY.balance + ADMIN.balance + LIBRARIAN.balance + CLAIMANT.balance;
        for (uint256 i; i < borrowers.length; ++i) {
            total += borrowers[i].balance;
        }
    }
}

contract LibraryDepositEscrowInvariantTest {
    LibraryDepositEscrowHandler private handler;

    function setUp() public {
        handler = new LibraryDepositEscrowHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_escrowBalanceCoversUnresolvedLiabilities() public view {
        require(
            address(handler.escrow()).balance == handler.expectedEscrowLiability(),
            "escrow balance must equal unresolved DEPOSITED + ACTIVE liabilities"
        );
    }

    function invariant_totalNativeFundsConserved() public view {
        require(
            handler.currentSystemBalance() == handler.initialSystemBalance(),
            "native CAMPUS must be conserved across escrow, borrowers and treasury"
        );
    }

    function invariant_requestStatesAndShortfallsConsistent() public view {
        LibraryDepositEscrow escrow = handler.escrow();
        uint256 count = handler.requestCount();
        for (uint256 i; i < count; ++i) {
            (,, uint256 depWei, uint256 priceWei,,,, uint8 state, uint256 shortfallWei) =
                escrow.requestInfo(handler.requestIdAt(i));
            require(depWei == handler.DEPOSIT_WEI() && priceWei > 0, "snapshotted terms");
            require(state >= 1 && state <= 6, "valid used state");
            if (state != 5) {
                require(shortfallWei == 0, "shortfall only nonzero in LOST_SHORTFALL_DUE");
            } else {
                require(shortfallWei > 0, "LOST_SHORTFALL_DUE requires positive shortfall");
            }
        }
    }
}
