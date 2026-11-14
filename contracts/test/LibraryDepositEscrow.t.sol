// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {LibraryDepositEscrow} from "../src/LibraryDepositEscrow.sol";
import {DeployLibrary, LibraryScriptBase, SeedLibraryBooks} from "../script/DeployLibrary.s.sol";

interface EscrowVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function chainId(uint256 chainId_) external;
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata errorData) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool checkData, address emitter) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonInt(string calldata json, string calldata key) external pure returns (int256);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool);
    function toString(uint256 value) external pure returns (string memory);
    function setEnv(string calldata key, string calldata value) external;
    function getNonce(address account) external view returns (uint64);
}

contract RejectingRecipient {
    receive() external payable {
        revert("transfer rejected");
    }
}

contract ReenteringBorrower {
    enum Mode {
        REJECT,
        CLAIM_EXPIRED,
        SETTLE_RETURN,
        SETTLE_LOST
    }

    LibraryDepositEscrow private escrow;
    bytes32 private requestId;
    Mode private mode;
    bool public reentrySucceeded;
    bytes4 public reentryError;
    uint8 public observedState;

    function placeDeposit(LibraryDepositEscrow escrow_, bytes32 requestId_, bytes32 bookId) external payable {
        escrow = escrow_;
        requestId = requestId_;
        escrow.deposit{value: msg.value}(requestId_, bookId);
    }

    function arm(Mode mode_) external {
        mode = mode_;
        reentrySucceeded = false;
        reentryError = bytes4(0);
        observedState = 0;
    }

    receive() external payable {
        (,,,,,,, observedState,,) = escrow.requestInfo(requestId);
        bytes memory data;
        if (mode == Mode.REJECT) {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.reject, (requestId)));
        } else if (mode == Mode.CLAIM_EXPIRED) {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.claimExpiredRefund, (requestId)));
        } else if (mode == Mode.SETTLE_RETURN) {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.settleReturn, (requestId, 0)));
        } else {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.settleLost, (requestId)));
        }
        if (data.length >= 4) {
            // forge-lint: disable-next-line(unsafe-typecast)
            reentryError = bytes4(data);
        }
    }
}

contract ReenteringTreasury {
    enum Mode {
        SETTLE_RETURN,
        SETTLE_LOST,
        PAY_SHORTFALL
    }

    LibraryDepositEscrow private escrow;
    bytes32 private requestId;
    Mode private mode;
    bool public reentrySucceeded;
    bytes4 public reentryError;
    uint8 public observedState;

    function arm(LibraryDepositEscrow escrow_, bytes32 requestId_, Mode mode_) external {
        escrow = escrow_;
        requestId = requestId_;
        mode = mode_;
        reentrySucceeded = false;
        reentryError = bytes4(0);
        observedState = 0;
    }

    receive() external payable {
        (,,,,,,, observedState,,) = escrow.requestInfo(requestId);
        bytes memory data;
        if (mode == Mode.SETTLE_RETURN) {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.settleReturn, (requestId, 0)));
        } else if (mode == Mode.SETTLE_LOST) {
            (reentrySucceeded, data) = address(escrow).call(abi.encodeCall(escrow.settleLost, (requestId)));
        } else {
            (reentrySucceeded, data) =
                address(escrow).call{value: msg.value}(abi.encodeCall(escrow.payShortfall, (requestId)));
        }
        if (data.length >= 4) {
            // forge-lint: disable-next-line(unsafe-typecast)
            reentryError = bytes4(data);
        }
    }
}

contract LibraryDepositEscrowTest {
    EscrowVm private constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0x1001);
    address private constant LIBRARIAN = address(0x1002);
    address private constant TREASURY = address(0x1003);
    address private constant BORROWER = address(0x2001);
    address private constant OTHER_USER = address(0x2002);

    uint256 private constant DEPOSIT_WEI = 50 ether;
    uint64 private constant BASE_TIME = 1_794_200_000;

    bytes32 private constant BOOK_CHEAP = keccak256("BOOK-30");
    bytes32 private constant BOOK_EXACT = keccak256("BOOK-50");
    bytes32 private constant BOOK_EXPENSIVE = keccak256("BOOK-80");

    LibraryDepositEscrow private escrow;

    function setUp() public {
        vm.chainId(20261);
        vm.warp(BASE_TIME);
        escrow = new LibraryDepositEscrow(ADMIN, LIBRARIAN, TREASURY);
        _seedAndSeal(BOOK_CHEAP, 30 ether);
        _seedAndSeal(BOOK_EXACT, 50 ether);
        _seedAndSeal(BOOK_EXPENSIVE, 80 ether);
        vm.deal(BORROWER, 1_000 ether);
        vm.deal(OTHER_USER, 1_000 ether);
        vm.deal(LIBRARIAN, 1_000 ether);
        vm.deal(ADMIN, 100 ether);
    }

    function _fixture() private view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../docs/fixtures/library-v1.json"));
    }

    function _seedAndSeal(bytes32 bookId, uint256 replacementPriceWei) private {
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, replacementPriceWei);
        vm.prank(ADMIN);
        escrow.sealBookTerms(bookId);
    }

    function _deposit(bytes32 requestId, bytes32 bookId, address borrower) private {
        vm.prank(borrower);
        escrow.deposit{value: DEPOSIT_WEI}(requestId, bookId);
    }

    function _depositAndApprove(bytes32 requestId, bytes32 bookId, address borrower)
        private
        returns (uint64 approvedAt, uint64 dueAt)
    {
        _deposit(requestId, bookId, borrower);
        vm.warp(block.timestamp + 100);
        approvedAt = uint64(block.timestamp);
        dueAt = approvedAt + escrow.LOAN_DURATION();
        vm.prank(LIBRARIAN);
        escrow.approve(requestId);
    }

    function testConstructorAndPolicyConstantsMatchFixture() public view {
        string memory json = _fixture();
        require(escrow.administrator() == ADMIN, "administrator");
        require(escrow.librarian() == LIBRARIAN, "librarian");
        require(escrow.treasury() == TREASURY, "treasury");
        require(escrow.APPROVAL_WINDOW() == uint64(vm.parseJsonUint(json, ".policy.approvalWindowSeconds")), "window");
        require(escrow.LOAN_DURATION() == uint64(vm.parseJsonUint(json, ".policy.loanDurationSeconds")), "duration");
        require(escrow.GRACE_PERIOD() == uint64(vm.parseJsonUint(json, ".policy.gracePeriodSeconds")), "grace");
        require(
            escrow.LATE_FEE_INTERVAL() == uint64(vm.parseJsonUint(json, ".policy.lateFeeIntervalSeconds")), "interval"
        );
        require(
            escrow.LATE_FEE_PER_INTERVAL() == vm.parseJsonUint(json, ".policy.lateFeePerIntervalWei"),
            "fee per interval"
        );
        require(escrow.MAX_LATE_FEE() == vm.parseJsonUint(json, ".policy.maxLateFeeWei"), "max late fee");
        require(
            escrow.FULL_DEPOSIT_RETENTION_AFTER()
                == uint64(vm.parseJsonUint(json, ".policy.fullDepositRetentionAfterSeconds")),
            "retention cutoff"
        );
    }

    function testConstructorRejectsZeroRolesOrTreasury() public {
        vm.expectRevert(LibraryDepositEscrow.InvalidConfiguration.selector);
        new LibraryDepositEscrow(address(0), LIBRARIAN, TREASURY);
        vm.expectRevert(LibraryDepositEscrow.InvalidConfiguration.selector);
        new LibraryDepositEscrow(ADMIN, address(0), TREASURY);
        vm.expectRevert(LibraryDepositEscrow.InvalidConfiguration.selector);
        new LibraryDepositEscrow(ADMIN, LIBRARIAN, address(0));
    }

    function testBookTermsSeedSealImmutabilityAndRoleChecks() public {
        bytes32 bookId = keccak256("BOOK-NEW");

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedAdministrator.selector);
        vm.prank(LIBRARIAN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, 40 ether);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedAdministrator.selector);
        vm.prank(OTHER_USER);
        escrow.sealBookTerms(bookId);

        vm.expectRevert(LibraryDepositEscrow.InvalidBookTerms.selector);
        vm.prank(ADMIN);
        escrow.seedBookTerms(bytes32(0), DEPOSIT_WEI, 40 ether);

        vm.expectRevert(LibraryDepositEscrow.InvalidBookTerms.selector);
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, 49 ether, 40 ether);

        vm.expectRevert(LibraryDepositEscrow.InvalidBookTerms.selector);
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, 0);

        vm.expectRevert(LibraryDepositEscrow.InvalidBookTerms.selector);
        vm.prank(ADMIN);
        escrow.sealBookTerms(bookId);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit LibraryDepositEscrow.BookTermsSeeded(bookId, DEPOSIT_WEI, 40 ether);
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, 40 ether);

        // Unsealed terms may still be adjusted prior to sealing.
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, 45 ether);

        (uint256 dep, uint256 price, bool isSealed) = escrow.bookTerms(bookId);
        require(dep == DEPOSIT_WEI && price == 45 ether && !isSealed, "seeded unsealed");

        vm.expectEmit(true, false, false, false, address(escrow));
        emit LibraryDepositEscrow.BookTermsSealed(bookId);
        vm.prank(ADMIN);
        escrow.sealBookTerms(bookId);

        (dep, price, isSealed) = escrow.bookTerms(bookId);
        require(dep == DEPOSIT_WEI && price == 45 ether && isSealed, "sealed readback");

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.BookTermsAlreadySealed.selector, bookId));
        vm.prank(ADMIN);
        escrow.seedBookTerms(bookId, DEPOSIT_WEI, 46 ether);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.BookTermsAlreadySealed.selector, bookId));
        vm.prank(ADMIN);
        escrow.sealBookTerms(bookId);
    }

    function testDepositValidationAndNoRequestReplayAcrossLifecycle() public {
        bytes32 unsealedBook = keccak256("BOOK-UNSEALED");
        vm.prank(ADMIN);
        escrow.seedBookTerms(unsealedBook, DEPOSIT_WEI, 35 ether);

        bytes32 req1 = keccak256("REQ-1");
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.BookTermsNotSealed.selector, unsealedBook));
        vm.prank(BORROWER);
        escrow.deposit{value: DEPOSIT_WEI}(req1, unsealedBook);

        bytes32 unknownBook = keccak256("BOOK-UNKNOWN");
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.BookTermsNotSealed.selector, unknownBook));
        vm.prank(BORROWER);
        escrow.deposit{value: DEPOSIT_WEI}(req1, unknownBook);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, bytes32(0), uint8(0)));
        vm.prank(BORROWER);
        escrow.deposit{value: DEPOSIT_WEI}(bytes32(0), BOOK_EXACT);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidPayment.selector, DEPOSIT_WEI, 49 ether));
        vm.prank(BORROWER);
        escrow.deposit{value: 49 ether}(req1, BOOK_EXACT);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidPayment.selector, DEPOSIT_WEI, 51 ether));
        vm.prank(BORROWER);
        escrow.deposit{value: 51 ether}(req1, BOOK_EXACT);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit LibraryDepositEscrow.DepositReceived(req1, BORROWER, BOOK_EXACT, DEPOSIT_WEI, uint64(block.timestamp));
        _deposit(req1, BOOK_EXACT, BORROWER);

        (
            address borrower,
            bytes32 bookId,
            uint256 dep,
            uint256 price,
            uint64 depositedAt,
            uint64 approvedAt,
            uint64 dueAt,
            uint8 state,
            uint256 shortfall,
            uint64 returnReceivedAt
        ) = escrow.requestInfo(req1);
        require(
            borrower == BORROWER && bookId == BOOK_EXACT && dep == DEPOSIT_WEI && price == 50 ether
                && depositedAt == uint64(block.timestamp) && approvedAt == 0 && dueAt == 0 && state == 1
                && shortfall == 0 && returnReceivedAt == 0,
            "deposited snapshot"
        );
        require(address(escrow).balance == DEPOSIT_WEI, "escrow balance");

        // Replay while DEPOSITED reverts.
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestAlreadyUsed.selector, req1));
        vm.prank(OTHER_USER);
        escrow.deposit{value: DEPOSIT_WEI}(req1, BOOK_EXACT);

        // Reject and confirm replay still reverts after REFUNDED.
        vm.prank(LIBRARIAN);
        escrow.reject(req1);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestAlreadyUsed.selector, req1));
        vm.prank(BORROWER);
        escrow.deposit{value: DEPOSIT_WEI}(req1, BOOK_EXACT);

        // Return-settled request cannot be reused either.
        bytes32 req2 = keccak256("REQ-2");
        _depositAndApprove(req2, BOOK_CHEAP, BORROWER);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(req2);
        vm.prank(LIBRARIAN);
        escrow.settleReturn(req2, 0);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestAlreadyUsed.selector, req2));
        vm.prank(BORROWER);
        escrow.deposit{value: DEPOSIT_WEI}(req2, BOOK_CHEAP);
    }

    function testApprovalDeadlineVectorsFromFixture() public {
        string memory json = _fixture();
        for (uint256 i; i < 3; ++i) {
            string memory prefix = string.concat(".approvalDeadlineVectors[", vm.toString(i), "]");
            int256 offset = vm.parseJsonInt(json, string.concat(prefix, ".secondsFromDeadline"));
            bool approvalAllowed = vm.parseJsonBool(json, string.concat(prefix, ".approvalAllowed"));
            bool refundClaimAllowed = vm.parseJsonBool(json, string.concat(prefix, ".refundClaimAllowed"));

            bytes32 reqId = keccak256(abi.encodePacked("DEADLINE-VEC", i));
            uint64 depositedAt = uint64(block.timestamp);
            uint64 deadline = depositedAt + escrow.APPROVAL_WINDOW();
            _deposit(reqId, BOOK_EXACT, BORROWER);

            uint256 targetTs = uint256(int256(uint256(deadline)) + offset);
            vm.warp(targetTs);

            if (approvalAllowed) {
                vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.ApprovalWindowOpen.selector, deadline));
                vm.prank(OTHER_USER);
                escrow.claimExpiredRefund(reqId);

                uint64 expectedDue = uint64(targetTs) + escrow.LOAN_DURATION();
                vm.expectEmit(true, true, false, true, address(escrow));
                emit LibraryDepositEscrow.LoanApproved(reqId, BORROWER, uint64(targetTs), expectedDue, 50 ether);
                vm.prank(LIBRARIAN);
                escrow.approve(reqId);

                (,,,,, uint64 approvedAt, uint64 dueAt, uint8 state,, uint64 returnReceivedAt) =
                    escrow.requestInfo(reqId);
                require(
                    approvedAt == uint64(targetTs) && dueAt == expectedDue && state == 2 && returnReceivedAt == 0,
                    "approved"
                );
            } else {
                require(refundClaimAllowed, "fixture expectation");
                vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.ApprovalWindowExpired.selector, deadline));
                vm.prank(LIBRARIAN);
                escrow.approve(reqId);

                uint256 borrowerBefore = BORROWER.balance;
                uint256 claimantBefore = OTHER_USER.balance;
                vm.expectEmit(true, true, false, true, address(escrow));
                emit LibraryDepositEscrow.ExpiredRefundClaimed(reqId, BORROWER, DEPOSIT_WEI);
                vm.prank(OTHER_USER);
                escrow.claimExpiredRefund(reqId);

                require(BORROWER.balance == borrowerBefore + DEPOSIT_WEI, "refunded original borrower");
                require(OTHER_USER.balance == claimantBefore, "claimant cannot divert");
                (,,,,,,, uint8 state,,) = escrow.requestInfo(reqId);
                require(state == 3, "refunded state");
            }
        }
    }

    function testApproveRejectAndRefundRoleAndDuplicateGuards() public {
        bytes32 missing = keccak256("MISSING");
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestNotFound.selector, missing));
        vm.prank(LIBRARIAN);
        escrow.approve(missing);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestNotFound.selector, missing));
        vm.prank(LIBRARIAN);
        escrow.reject(missing);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestNotFound.selector, missing));
        vm.prank(BORROWER);
        escrow.claimExpiredRefund(missing);

        bytes32 reqId = keccak256("REQ-ROLE");
        _deposit(reqId, BOOK_EXACT, BORROWER);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(ADMIN);
        escrow.approve(reqId);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(BORROWER);
        escrow.reject(reqId);

        uint256 borrowerBefore = BORROWER.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.RequestRejected(reqId, BORROWER, DEPOSIT_WEI);
        vm.prank(LIBRARIAN);
        escrow.reject(reqId);
        require(BORROWER.balance == borrowerBefore + DEPOSIT_WEI, "reject refund");

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(3)));
        vm.prank(LIBRARIAN);
        escrow.reject(reqId);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(3)));
        vm.prank(LIBRARIAN);
        escrow.approve(reqId);

        vm.warp(block.timestamp + escrow.APPROVAL_WINDOW() + 1);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(3)));
        vm.prank(BORROWER);
        escrow.claimExpiredRefund(reqId);

        // Expiry claim cannot happen twice.
        bytes32 reqExp = keccak256("REQ-EXP-TWICE");
        _deposit(reqExp, BOOK_EXACT, BORROWER);
        vm.warp(block.timestamp + escrow.APPROVAL_WINDOW());
        vm.prank(OTHER_USER);
        escrow.claimExpiredRefund(reqExp);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqExp, uint8(3)));
        vm.prank(BORROWER);
        escrow.claimExpiredRefund(reqExp);
    }

    struct ReturnVector {
        uint256 elapsed;
        uint256 repairRequested;
        uint256 expectedLate;
        uint256 expectedRetained;
        uint256 expectedRefund;
        bool expectedOverdue;
    }

    function testReturnVectorsFromFixture() public {
        string memory json = _fixture();
        for (uint256 i; i < 8; ++i) {
            _assertReturnVector(json, i);
        }
    }

    function _assertReturnVector(string memory json, uint256 i) private {
        string memory prefix = string.concat(".returnVectors[", vm.toString(i), "]");
        ReturnVector memory v = ReturnVector({
            elapsed: vm.parseJsonUint(json, string.concat(prefix, ".elapsedSinceDueSeconds")),
            repairRequested: vm.parseJsonUint(json, string.concat(prefix, ".repairRequestedWei")),
            expectedLate: vm.parseJsonUint(json, string.concat(prefix, ".expectedLateFeeWei")),
            expectedRetained: vm.parseJsonUint(json, string.concat(prefix, ".expectedRetainedWei")),
            expectedRefund: vm.parseJsonUint(json, string.concat(prefix, ".expectedRefundWei")),
            expectedOverdue: vm.parseJsonBool(json, string.concat(prefix, ".expectedOverdue"))
        });

        bytes32 reqId = keccak256(abi.encodePacked("RETURN-VEC", i));
        (, uint64 dueAt) = _depositAndApprove(reqId, BOOK_EXACT, BORROWER);
        uint64 returnedAt = uint64(uint256(dueAt) + v.elapsed);
        vm.warp(returnedAt);

        uint256 treasuryBefore = TREASURY.balance;
        uint256 borrowerBefore = BORROWER.balance;

        {
            vm.expectEmit(true, true, false, true, address(escrow));
            emit LibraryDepositEscrow.PhysicalReturnConfirmed(reqId, BORROWER, returnedAt);
            vm.prank(LIBRARIAN);
            escrow.confirmPhysicalReturn(reqId);

            (,,,,,,, uint8 confirmState,, uint64 returnReceivedAt) = escrow.requestInfo(reqId);
            require(confirmState == 7 && returnReceivedAt == returnedAt, "RETURN_RECEIVED stored");
            require(TREASURY.balance == treasuryBefore && BORROWER.balance == borrowerBefore, "confirm moves no funds");
        }

        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(
            reqId,
            BORROWER,
            returnedAt,
            v.expectedLate,
            v.expectedOverdue ? 0 : v.expectedRetained - v.expectedLate,
            v.expectedOverdue ? DEPOSIT_WEI - v.expectedLate : 0,
            v.expectedRetained,
            v.expectedRefund,
            v.repairRequested > 0
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqId, v.repairRequested);

        require(TREASURY.balance - treasuryBefore == v.expectedRetained, "treasury return delta");
        require(BORROWER.balance - borrowerBefore == v.expectedRefund, "borrower return delta");
        require(address(escrow).balance == 0, "escrow cleared");
        {
            (,,,,,,, uint8 state,, uint64 settledReturnAt) = escrow.requestInfo(reqId);
            require(state == 4 && settledReturnAt == returnedAt, "RETURN_SETTLED");
        }

        // Cannot settle twice.
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(4)));
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqId, 0);
    }

    function testConfirmPhysicalReturnFreezesLateFeesAndExcludesLost() public {
        string memory json = _fixture();
        uint256 returnedElapsed = vm.parseJsonUint(json, ".returnTimingVectors[0].returnedAtElapsedSinceDueSeconds");
        uint256 settleElapsed = vm.parseJsonUint(json, ".returnTimingVectors[0].settlementAtElapsedSinceDueSeconds");
        uint256 expectedLate = vm.parseJsonUint(json, ".returnTimingVectors[0].expectedLateFeeWei");
        uint256 expectedRefund = vm.parseJsonUint(json, ".returnTimingVectors[0].expectedRefundWei");
        uint256 expectedForfeit = vm.parseJsonUint(json, ".returnTimingVectors[0].expectedOverdueForfeitWei");

        // 1. Confirm physical return on exact day 30; settle at day 30 + 1 sec (late fees remain frozen at day 30).
        bytes32 reqFrozen = keccak256("RETURN-TIMING-FREEZE");
        (, uint64 dueAt) = _depositAndApprove(reqFrozen, BOOK_EXACT, BORROWER);
        uint64 confirmedAt = uint64(uint256(dueAt) + returnedElapsed);
        vm.warp(confirmedAt);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.PhysicalReturnConfirmed(reqFrozen, BORROWER, confirmedAt);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqFrozen);

        // Once confirmed returned: settleLost and duplicate confirmPhysicalReturn must revert.
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqFrozen, uint8(7)));
        vm.prank(LIBRARIAN);
        escrow.settleLost(reqFrozen);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqFrozen, uint8(7)));
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqFrozen);

        // Advance past day 30 (+ 1 sec and verify against fixture returnTimingVectors[0]).
        vm.warp(uint256(dueAt) + settleElapsed);
        uint256 treasuryBefore = TREASURY.balance;
        uint256 borrowerBefore = BORROWER.balance;

        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(
            reqFrozen,
            BORROWER,
            confirmedAt,
            expectedLate,
            0,
            expectedForfeit,
            DEPOSIT_WEI - expectedRefund,
            expectedRefund,
            false
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqFrozen, 0);

        require(BORROWER.balance - borrowerBefore == 47.3 ether, "frozen refund preserves 47.3 CAMPUS");
        require(TREASURY.balance - treasuryBefore == 2.7 ether, "frozen late fee remains 2.7 CAMPUS");
        (,,,,,,, uint8 frozenState,, uint64 storedReturnedAt) = escrow.requestInfo(reqFrozen);
        require(frozenState == 4 && storedReturnedAt == confirmedAt, "settled with preserved returnReceivedAt");

        // 2. Confirm AFTER day 30 retains full deposit regardless of settlement time.
        bytes32 reqAfter30 = keccak256("RETURN-CONFIRMED-AFTER-30");
        (, uint64 dueAt2) = _depositAndApprove(reqAfter30, BOOK_EXACT, BORROWER);
        uint64 lateConfirmedAt = uint64(uint256(dueAt2) + 30 days + 1);
        vm.warp(lateConfirmedAt);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqAfter30);
        vm.warp(uint256(lateConfirmedAt) + 10 days);

        treasuryBefore = TREASURY.balance;
        borrowerBefore = BORROWER.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(
            reqAfter30, BORROWER, lateConfirmedAt, 2.7 ether, 0, 47.3 ether, DEPOSIT_WEI, 0, false
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqAfter30, 0);
        require(TREASURY.balance - treasuryBefore == DEPOSIT_WEI && BORROWER.balance == borrowerBefore, "full forfeit");

        // 3. confirmPhysicalReturn role/replay/missing checks and direct settleReturn-from-ACTIVE rejection.
        bytes32 reqActive = keccak256("ACTIVE-NO-CONFIRM");
        _depositAndApprove(reqActive, BOOK_EXACT, BORROWER);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(BORROWER);
        escrow.confirmPhysicalReturn(reqActive);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(ADMIN);
        escrow.confirmPhysicalReturn(reqActive);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(OTHER_USER);
        escrow.confirmPhysicalReturn(reqActive);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqActive, uint8(2)));
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqActive, 0);

        // Once settled lost, confirmPhysicalReturn must revert.
        vm.prank(LIBRARIAN);
        escrow.settleLost(reqActive);
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqActive, uint8(6)));
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqActive);

        bytes32 missingReq = keccak256("MISSING-CONFIRM");
        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.RequestNotFound.selector, missingReq));
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(missingReq);
    }

    function testReturnEarlyAndDamagedPastThirtyDaysPreservesMaintenanceAndCap() public {
        // Early return (before dueAt): zero fee, full refund.
        bytes32 reqEarly = keccak256("RETURN-EARLY");
        (uint64 approvedAt,) = _depositAndApprove(reqEarly, BOOK_EXACT, BORROWER);
        vm.warp(approvedAt + 1 days);
        uint64 earlyReturnedAt = uint64(block.timestamp);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqEarly);

        uint256 borrowerBefore = BORROWER.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(reqEarly, BORROWER, earlyReturnedAt, 0, 0, 0, 0, DEPOSIT_WEI, false);
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqEarly, 0);
        require(BORROWER.balance == borrowerBefore + DEPOSIT_WEI, "early full refund");

        // Damaged book returned > 30 days late: deposit consumed by late + overdue forfeit, maintenanceRequired stays true.
        bytes32 reqOverdueDamaged = keccak256("RETURN-OVERDUE-DAMAGED");
        (, uint64 dueAt) = _depositAndApprove(reqOverdueDamaged, BOOK_EXACT, BORROWER);
        vm.warp(uint256(dueAt) + 30 days + 1);
        uint64 overdueReturnedAt = uint64(block.timestamp);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqOverdueDamaged);

        uint256 treasuryBefore = TREASURY.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(
            reqOverdueDamaged, BORROWER, overdueReturnedAt, 2.7 ether, 0, 47.3 ether, DEPOSIT_WEI, 0, true
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqOverdueDamaged, 10 ether);
        require(TREASURY.balance == treasuryBefore + DEPOSIT_WEI, "treasury keeps full deposit");

        // Very late return caps lateFeeWei at MAX_LATE_FEE (25 ether).
        bytes32 reqVeryLate = keccak256("RETURN-VERY-LATE");
        (, uint64 dueAt2) = _depositAndApprove(reqVeryLate, BOOK_EXACT, BORROWER);
        vm.warp(uint256(dueAt2) + 400 days);
        uint64 veryLateReturnedAt = uint64(block.timestamp);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqVeryLate);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit LibraryDepositEscrow.ReturnSettled(
            reqVeryLate, BORROWER, veryLateReturnedAt, 25 ether, 0, 25 ether, DEPOSIT_WEI, 0, false
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqVeryLate, 0);
    }

    function testReturnAndLostRoleAndStateEnforcement() public {
        bytes32 reqPending = keccak256("PENDING");
        _deposit(reqPending, BOOK_EXACT, BORROWER);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(BORROWER);
        escrow.confirmPhysicalReturn(reqPending);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(BORROWER);
        escrow.settleReturn(reqPending, 0);

        vm.expectRevert(LibraryDepositEscrow.UnauthorizedLibrarian.selector);
        vm.prank(ADMIN);
        escrow.settleLost(reqPending);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqPending, uint8(1)));
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqPending);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqPending, uint8(1)));
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqPending, 0);

        vm.expectRevert(abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqPending, uint8(1)));
        vm.prank(LIBRARIAN);
        escrow.settleLost(reqPending);
    }

    function testLostVectorsFromFixtureAndShortfallPayment() public {
        string memory json = _fixture();
        bytes32[3] memory books = [BOOK_CHEAP, BOOK_EXACT, BOOK_EXPENSIVE];

        for (uint256 i; i < 3; ++i) {
            string memory prefix = string.concat(".lostVectors[", vm.toString(i), "]");
            uint256 replacementPrice = vm.parseJsonUint(json, string.concat(prefix, ".replacementPriceWei"));
            uint256 expectedRetained = vm.parseJsonUint(json, string.concat(prefix, ".expectedRetainedWei"));
            uint256 expectedRefund = vm.parseJsonUint(json, string.concat(prefix, ".expectedRefundWei"));
            uint256 expectedShortfall = vm.parseJsonUint(json, string.concat(prefix, ".expectedShortfallWei"));

            bytes32 reqId = keccak256(abi.encodePacked("LOST-VEC", i));
            (, uint64 dueAt) = _depositAndApprove(reqId, books[i], BORROWER);
            // Advance past 30 days overdue to verify lost settlement never charges late fees separately.
            vm.warp(uint256(dueAt) + 40 days);

            uint256 treasuryBefore = TREASURY.balance;
            uint256 borrowerBefore = BORROWER.balance;
            vm.expectEmit(true, true, false, true, address(escrow));
            emit LibraryDepositEscrow.LostSettled(
                reqId, BORROWER, replacementPrice, expectedRetained, expectedRefund, expectedShortfall
            );
            vm.prank(LIBRARIAN);
            escrow.settleLost(reqId);

            require(TREASURY.balance - treasuryBefore == expectedRetained, "lost treasury retained");
            require(BORROWER.balance - borrowerBefore == expectedRefund, "lost borrower refund");
            require(address(escrow).balance == 0, "escrow balance cleared");

            (,,,,,,, uint8 state, uint256 storedShortfall,) = escrow.requestInfo(reqId);
            require(storedShortfall == expectedShortfall, "stored shortfall");

            if (expectedShortfall == 0) {
                require(state == 6, "LOST_SETTLED");
                vm.expectRevert(
                    abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(6))
                );
                vm.prank(BORROWER);
                escrow.payShortfall(reqId);
            } else {
                require(state == 5, "LOST_SHORTFALL_DUE");

                vm.expectRevert(LibraryDepositEscrow.UnauthorizedBorrower.selector);
                vm.prank(OTHER_USER);
                escrow.payShortfall{value: expectedShortfall}(reqId);

                vm.expectRevert(LibraryDepositEscrow.UnauthorizedBorrower.selector);
                vm.prank(LIBRARIAN);
                escrow.payShortfall{value: expectedShortfall}(reqId);

                vm.expectRevert(
                    abi.encodeWithSelector(
                        LibraryDepositEscrow.InvalidPayment.selector, expectedShortfall, expectedShortfall - 1
                    )
                );
                vm.prank(BORROWER);
                escrow.payShortfall{value: expectedShortfall - 1}(reqId);

                vm.expectRevert(
                    abi.encodeWithSelector(
                        LibraryDepositEscrow.InvalidPayment.selector, expectedShortfall, expectedShortfall + 1
                    )
                );
                vm.prank(BORROWER);
                escrow.payShortfall{value: expectedShortfall + 1}(reqId);

                uint256 treasuryBeforeShortfall = TREASURY.balance;
                vm.expectEmit(true, true, false, true, address(escrow));
                emit LibraryDepositEscrow.ShortfallPaid(reqId, BORROWER, expectedShortfall);
                vm.prank(BORROWER);
                escrow.payShortfall{value: expectedShortfall}(reqId);

                require(TREASURY.balance - treasuryBeforeShortfall == expectedShortfall, "treasury shortfall");
                (,,,,,,, state, storedShortfall,) = escrow.requestInfo(reqId);
                require(state == 6 && storedShortfall == 0, "shortfall cleared");

                // Replay payShortfall and settleReturn/settleLost revert.
                vm.expectRevert(
                    abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(6))
                );
                vm.prank(BORROWER);
                escrow.payShortfall{value: expectedShortfall}(reqId);

                vm.expectRevert(
                    abi.encodeWithSelector(LibraryDepositEscrow.InvalidRequestState.selector, reqId, uint8(6))
                );
                vm.prank(LIBRARIAN);
                escrow.settleLost(reqId);
            }
        }
    }

    function testTransferFailuresToBorrowerRevertAtomically() public {
        RejectingRecipient rejectingBorrower = new RejectingRecipient();
        vm.deal(address(rejectingBorrower), 200 ether);

        // 1. reject revert
        bytes32 reqReject = keccak256("FAIL-REJECT");
        vm.prank(address(rejectingBorrower));
        escrow.deposit{value: DEPOSIT_WEI}(reqReject, BOOK_EXACT);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibraryDepositEscrow.TransferFailed.selector, address(rejectingBorrower), DEPOSIT_WEI
            )
        );
        vm.prank(LIBRARIAN);
        escrow.reject(reqReject);
        (,,,,,,, uint8 state,,) = escrow.requestInfo(reqReject);
        require(state == 1 && address(escrow).balance == DEPOSIT_WEI, "reject rolled back");

        // 2. claimExpiredRefund revert
        vm.warp(block.timestamp + escrow.APPROVAL_WINDOW());
        vm.expectRevert(
            abi.encodeWithSelector(
                LibraryDepositEscrow.TransferFailed.selector, address(rejectingBorrower), DEPOSIT_WEI
            )
        );
        vm.prank(OTHER_USER);
        escrow.claimExpiredRefund(reqReject);
        (,,,,,,, state,,) = escrow.requestInfo(reqReject);
        require(state == 1 && address(escrow).balance == DEPOSIT_WEI, "claim rolled back");

        // 3. settleReturn revert when borrower refund fails (treasury must NOT receive partial fee!)
        bytes32 reqReturn = keccak256("FAIL-RETURN");
        vm.prank(address(rejectingBorrower));
        escrow.deposit{value: DEPOSIT_WEI}(reqReturn, BOOK_EXACT);
        vm.prank(LIBRARIAN);
        escrow.approve(reqReturn);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqReturn);
        uint256 treasuryBefore = TREASURY.balance;
        vm.expectRevert(
            abi.encodeWithSelector(LibraryDepositEscrow.TransferFailed.selector, address(rejectingBorrower), 40 ether)
        );
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqReturn, 10 ether);
        (,,,,,,, state,,) = escrow.requestInfo(reqReturn);
        require(state == 7 && TREASURY.balance == treasuryBefore, "settleReturn atomic rollback");

        // 4. settleLost revert when borrower surplus refund fails
        bytes32 reqLost = keccak256("FAIL-LOST");
        vm.prank(address(rejectingBorrower));
        escrow.deposit{value: DEPOSIT_WEI}(reqLost, BOOK_CHEAP);
        vm.prank(LIBRARIAN);
        escrow.approve(reqLost);
        vm.expectRevert(
            abi.encodeWithSelector(LibraryDepositEscrow.TransferFailed.selector, address(rejectingBorrower), 20 ether)
        );
        vm.prank(LIBRARIAN);
        escrow.settleLost(reqLost);
        (,,,,,,, state,,) = escrow.requestInfo(reqLost);
        require(state == 2 && TREASURY.balance == treasuryBefore, "settleLost atomic rollback");
    }

    function testTransferFailuresToTreasuryRevertAtomically() public {
        RejectingRecipient badTreasury = new RejectingRecipient();
        LibraryDepositEscrow badEscrow = new LibraryDepositEscrow(ADMIN, LIBRARIAN, address(badTreasury));
        vm.prank(ADMIN);
        badEscrow.seedBookTerms(BOOK_EXPENSIVE, DEPOSIT_WEI, 80 ether);
        vm.prank(ADMIN);
        badEscrow.sealBookTerms(BOOK_EXPENSIVE);

        bytes32 reqReturn = keccak256("TREASURY-FAIL-RETURN");
        vm.prank(BORROWER);
        badEscrow.deposit{value: DEPOSIT_WEI}(reqReturn, BOOK_EXPENSIVE);
        vm.prank(LIBRARIAN);
        badEscrow.approve(reqReturn);
        vm.prank(LIBRARIAN);
        badEscrow.confirmPhysicalReturn(reqReturn);
        uint256 borrowerBefore = BORROWER.balance;
        vm.expectRevert(
            abi.encodeWithSelector(LibraryDepositEscrow.TransferFailed.selector, address(badTreasury), 10 ether)
        );
        vm.prank(LIBRARIAN);
        badEscrow.settleReturn(reqReturn, 10 ether);
        (,,,,,,, uint8 state,,) = badEscrow.requestInfo(reqReturn);
        require(state == 7 && BORROWER.balance == borrowerBefore, "treasury return fail rollback");

        bytes32 reqLost = keccak256("TREASURY-FAIL-LOST");
        vm.prank(BORROWER);
        badEscrow.deposit{value: DEPOSIT_WEI}(reqLost, BOOK_EXPENSIVE);
        vm.prank(LIBRARIAN);
        badEscrow.approve(reqLost);
        vm.expectRevert(
            abi.encodeWithSelector(LibraryDepositEscrow.TransferFailed.selector, address(badTreasury), DEPOSIT_WEI)
        );
        vm.prank(LIBRARIAN);
        badEscrow.settleLost(reqLost);
        (,,,,,,, state,,) = badEscrow.requestInfo(reqLost);
        require(state == 2 && address(badEscrow).balance == 2 * DEPOSIT_WEI, "treasury lost fail rollback");

        // Shortfall payment revert when treasury rejects
        LibraryDepositEscrow goodEscrow = new LibraryDepositEscrow(ADMIN, LIBRARIAN, address(badTreasury));
        vm.prank(ADMIN);
        goodEscrow.seedBookTerms(BOOK_EXPENSIVE, DEPOSIT_WEI, 80 ether);
        vm.prank(ADMIN);
        goodEscrow.sealBookTerms(BOOK_EXPENSIVE);
        // Directly verify deposit + reject works even when treasury rejects, since reject doesn't touch treasury.
        bytes32 reqReject = keccak256("TREASURY-DOWN-REJECT");
        vm.prank(BORROWER);
        goodEscrow.deposit{value: DEPOSIT_WEI}(reqReject, BOOK_EXPENSIVE);
        vm.prank(LIBRARIAN);
        goodEscrow.reject(reqReject);
        (,,,,,,, state,,) = goodEscrow.requestInfo(reqReject);
        require(state == 3, "reject independent of treasury");
    }

    function testReentrancyBlockedFromBorrowerAndTreasury() public {
        ReenteringBorrower attacker = new ReenteringBorrower();
        vm.deal(address(attacker), 500 ether);

        // 1. Reenter during reject
        bytes32 req1 = keccak256("REENTER-REJECT");
        attacker.placeDeposit{value: DEPOSIT_WEI}(escrow, req1, BOOK_EXACT);
        attacker.arm(ReenteringBorrower.Mode.REJECT);
        vm.prank(LIBRARIAN);
        escrow.reject(req1);
        require(!attacker.reentrySucceeded(), "reject reentry blocked");
        require(attacker.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "reject error");
        require(attacker.observedState() == 3, "state updated before call");

        // 2. Reenter during claimExpiredRefund
        bytes32 req2 = keccak256("REENTER-EXPIRE");
        attacker.placeDeposit{value: DEPOSIT_WEI}(escrow, req2, BOOK_EXACT);
        vm.warp(block.timestamp + escrow.APPROVAL_WINDOW());
        attacker.arm(ReenteringBorrower.Mode.CLAIM_EXPIRED);
        vm.prank(OTHER_USER);
        escrow.claimExpiredRefund(req2);
        require(!attacker.reentrySucceeded(), "claim reentry blocked");
        require(attacker.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "claim error");
        require(attacker.observedState() == 3, "claim state updated before call");

        // 3. Reenter during settleReturn
        bytes32 req3 = keccak256("REENTER-RETURN");
        attacker.placeDeposit{value: DEPOSIT_WEI}(escrow, req3, BOOK_EXACT);
        vm.prank(LIBRARIAN);
        escrow.approve(req3);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(req3);
        attacker.arm(ReenteringBorrower.Mode.SETTLE_RETURN);
        vm.prank(LIBRARIAN);
        escrow.settleReturn(req3, 1 ether);
        require(!attacker.reentrySucceeded(), "return reentry blocked");
        require(attacker.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "return error");
        require(attacker.observedState() == 4, "return state updated before call");

        // 4. Reenter during settleLost
        bytes32 req4 = keccak256("REENTER-LOST");
        attacker.placeDeposit{value: DEPOSIT_WEI}(escrow, req4, BOOK_CHEAP);
        vm.prank(LIBRARIAN);
        escrow.approve(req4);
        attacker.arm(ReenteringBorrower.Mode.SETTLE_LOST);
        vm.prank(LIBRARIAN);
        escrow.settleLost(req4);
        require(!attacker.reentrySucceeded(), "lost reentry blocked");
        require(attacker.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "lost error");
        require(attacker.observedState() == 6, "lost state updated before call");

        // 5. Reenter from treasury during settleReturn, settleLost, payShortfall
        ReenteringTreasury badTreasury = new ReenteringTreasury();
        LibraryDepositEscrow treasuryEscrow = new LibraryDepositEscrow(ADMIN, LIBRARIAN, address(badTreasury));
        vm.prank(ADMIN);
        treasuryEscrow.seedBookTerms(BOOK_EXPENSIVE, DEPOSIT_WEI, 80 ether);
        vm.prank(ADMIN);
        treasuryEscrow.sealBookTerms(BOOK_EXPENSIVE);

        bytes32 req5 = keccak256("REENTER-TREASURY-RETURN");
        vm.prank(BORROWER);
        treasuryEscrow.deposit{value: DEPOSIT_WEI}(req5, BOOK_EXPENSIVE);
        vm.prank(LIBRARIAN);
        treasuryEscrow.approve(req5);
        vm.prank(LIBRARIAN);
        treasuryEscrow.confirmPhysicalReturn(req5);
        badTreasury.arm(treasuryEscrow, req5, ReenteringTreasury.Mode.SETTLE_RETURN);
        vm.prank(LIBRARIAN);
        treasuryEscrow.settleReturn(req5, 5 ether);
        require(!badTreasury.reentrySucceeded(), "treasury return reentry blocked");
        require(badTreasury.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "treasury return error");
        require(badTreasury.observedState() == 4, "treasury return state before call");

        bytes32 req6 = keccak256("REENTER-TREASURY-LOST");
        vm.prank(BORROWER);
        treasuryEscrow.deposit{value: DEPOSIT_WEI}(req6, BOOK_EXPENSIVE);
        vm.prank(LIBRARIAN);
        treasuryEscrow.approve(req6);
        badTreasury.arm(treasuryEscrow, req6, ReenteringTreasury.Mode.SETTLE_LOST);
        vm.prank(LIBRARIAN);
        treasuryEscrow.settleLost(req6);
        require(!badTreasury.reentrySucceeded(), "treasury lost reentry blocked");
        require(badTreasury.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "treasury lost error");
        require(badTreasury.observedState() == 5, "treasury lost state before call");

        badTreasury.arm(treasuryEscrow, req6, ReenteringTreasury.Mode.PAY_SHORTFALL);
        vm.prank(BORROWER);
        treasuryEscrow.payShortfall{value: 30 ether}(req6);
        require(!badTreasury.reentrySucceeded(), "treasury shortfall reentry blocked");
        require(badTreasury.reentryError() == LibraryDepositEscrow.ReentrantCall.selector, "treasury shortfall error");
        require(badTreasury.observedState() == 6, "treasury shortfall state before call");
    }

    function testFuzzExpiryClaimantCannotDivertRefund(address claimant, uint64 extraDelay) public {
        if (claimant == address(0) || claimant == BORROWER || claimant.code.length != 0) {
            claimant = OTHER_USER;
        }
        uint256 cappedDelay = extraDelay % 365 days;
        bytes32 reqId = keccak256(abi.encodePacked("FUZZ-EXP", claimant, cappedDelay));
        _deposit(reqId, BOOK_EXACT, BORROWER);
        vm.warp(block.timestamp + escrow.APPROVAL_WINDOW() + cappedDelay);

        uint256 borrowerBefore = BORROWER.balance;
        uint256 claimantBefore = claimant.balance;
        vm.prank(claimant);
        escrow.claimExpiredRefund(reqId);

        require(BORROWER.balance == borrowerBefore + DEPOSIT_WEI, "borrower receives full deposit");
        require(claimant.balance == claimantBefore, "claimant receives zero");
        require(address(escrow).balance == 0, "escrow zero");
    }

    function testFuzzReturnAndLostAccountingConservesDeposit(
        uint32 elapsedAfterDue,
        uint256 repairRequestedWei,
        uint256 replacementPriceWei
    ) public {
        uint256 clampedPrice = (replacementPriceWei % 200 ether) + 1;
        bytes32 fuzzBook = keccak256(abi.encodePacked("FUZZ-BOOK", clampedPrice, elapsedAfterDue));
        _seedAndSeal(fuzzBook, clampedPrice);

        bytes32 reqReturn = keccak256(abi.encodePacked("FUZZ-RET", elapsedAfterDue, repairRequestedWei));
        (, uint64 dueAt) = _depositAndApprove(reqReturn, fuzzBook, BORROWER);
        uint256 confirmAt = uint256(dueAt) + uint256(elapsedAfterDue);
        vm.warp(confirmAt);
        vm.prank(LIBRARIAN);
        escrow.confirmPhysicalReturn(reqReturn);
        vm.warp(confirmAt + (repairRequestedWei % 15 days) + 1);

        uint256 treasuryBefore = TREASURY.balance;
        uint256 borrowerBefore = BORROWER.balance;
        vm.prank(LIBRARIAN);
        escrow.settleReturn(reqReturn, repairRequestedWei);

        uint256 retained = TREASURY.balance - treasuryBefore;
        uint256 refunded = BORROWER.balance - borrowerBefore;
        require(retained + refunded == DEPOSIT_WEI, "return conserves deposit");
        (,,,,,,, uint8 retState,, uint64 storedReturnedAt) = escrow.requestInfo(reqReturn);
        require(retState == 4 && storedReturnedAt == uint64(confirmAt), "fuzz return preserves confirmation timestamp");
        if (uint256(elapsedAfterDue) > escrow.FULL_DEPOSIT_RETENTION_AFTER()) {
            require(retained == DEPOSIT_WEI && refunded == 0, "overdue retains full deposit");
        }

        bytes32 reqLost = keccak256(abi.encodePacked("FUZZ-LOST", clampedPrice, repairRequestedWei));
        _depositAndApprove(reqLost, fuzzBook, BORROWER);
        treasuryBefore = TREASURY.balance;
        borrowerBefore = BORROWER.balance;
        vm.prank(LIBRARIAN);
        escrow.settleLost(reqLost);

        retained = TREASURY.balance - treasuryBefore;
        refunded = BORROWER.balance - borrowerBefore;
        (,,,,,,, uint8 state, uint256 shortfall,) = escrow.requestInfo(reqLost);
        require(retained + refunded == DEPOSIT_WEI, "lost deposit split conserves deposit");
        require(retained + shortfall == clampedPrice, "lost settlement matches replacement price");
        require(state == (shortfall > 0 ? 5 : 6), "lost state matches shortfall");
    }
}

contract LibraryDepositEscrowDeployTest {
    EscrowVm private constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant DEPLOYER = address(0x0000000000000000000000000000000000001000);
    address private constant LIBRARIAN = address(0x0000000000000000000000000000000000001001);
    address private constant TREASURY = address(0x0000000000000000000000000000000000002000);

    DeployLibrary private deployScript;
    SeedLibraryBooks private seedScript;

    function setUp() public {
        vm.chainId(20261);
        deployScript = new DeployLibrary();
        seedScript = new SeedLibraryBooks();
        vm.setEnv("DEPLOYER_ADDRESS", "0x0000000000000000000000000000000000001000");
        vm.setEnv("LIBRARY_ADMIN_ADDRESS", "0x0000000000000000000000000000000000001000");
        vm.setEnv("LIBRARY_LIBRARIAN_ADDRESS", "0x0000000000000000000000000000000000001001");
        vm.setEnv("LIBRARY_TREASURY_ADDRESS", "0x0000000000000000000000000000000000002000");
        vm.setEnv(
            "LIBRARY_BOOK_IDS",
            "0x1111111111111111111111111111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222222222222222222222222222"
        );
        vm.setEnv("LIBRARY_BOOK_REPLACEMENT_PRICES_WEI", "30000000000000000000,80000000000000000000");
    }

    function testDeployLibraryDeploysSeedsSealsAndVerifiesReadback() public {
        LibraryDepositEscrow escrow = deployScript.run();
        require(escrow.administrator() == DEPLOYER, "admin readback");
        require(escrow.librarian() == LIBRARIAN, "librarian readback");
        require(escrow.treasury() == TREASURY, "treasury readback");

        bytes32 book1 = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 book2 = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        (uint256 dep1, uint256 price1, bool sealed1) = escrow.bookTerms(book1);
        (uint256 dep2, uint256 price2, bool sealed2) = escrow.bookTerms(book2);
        require(dep1 == 50 ether && price1 == 30 ether && sealed1, "book1 sealed");
        require(dep2 == 50 ether && price2 == 80 ether && sealed2, "book2 sealed");
    }

    function testDeployLibraryRefusesWrongChainBeforeBroadcast() public {
        vm.chainId(43113);
        uint64 nonce = vm.getNonce(DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(LibraryScriptBase.WrongChain.selector, uint256(43113)));
        deployScript.run();
        require(vm.getNonce(DEPLOYER) == nonce, "no deployment on wrong chain");
    }

    function testDeployLibraryRefusesDistinctAdministratorBeforeBroadcast() public {
        DeployLibrary.Config memory cfg = _validConfig();
        cfg.administrator = LIBRARIAN;
        uint64 nonce = vm.getNonce(DEPLOYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployLibrary.DistinctDeployerAndAdministratorUnsupported.selector, DEPLOYER, LIBRARIAN
            )
        );
        deployScript.runWithConfig(cfg);
        require(vm.getNonce(DEPLOYER) == nonce, "no deployment when deployer != administrator");
    }

    function testDeployLibraryRejectsInvalidRolesTreasuryAndTerms() public {
        DeployLibrary.Config memory cfg = _validConfig();
        cfg.administrator = LIBRARIAN;
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployLibrary.DistinctDeployerAndAdministratorUnsupported.selector, DEPLOYER, LIBRARIAN
            )
        );
        deployScript.validate(cfg);

        cfg = _validConfig();
        cfg.treasury = address(0);
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        deployScript.validate(cfg);

        cfg = _validConfig();
        cfg.treasury = cfg.librarian;
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        deployScript.validate(cfg);

        cfg = _validConfig();
        cfg.books[0].depositWei = 49 ether;
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        deployScript.validate(cfg);

        cfg = _validConfig();
        cfg.books[0].replacementPriceWei = 0;
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        deployScript.validate(cfg);

        cfg = _validConfig();
        cfg.books[1].bookId = cfg.books[0].bookId;
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        deployScript.validate(cfg);
    }

    function testSeedBooksRerunIsIdempotentAndRejectsMismatchedSealedTerms() public {
        LibraryDepositEscrow escrow = deployScript.run();
        LibraryScriptBase.BookTermSeed[] memory books = new LibraryScriptBase.BookTermSeed[](2);
        bytes32 book1 = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 book2 = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        books[0] = LibraryScriptBase.BookTermSeed(book1, 50 ether, 30 ether);
        books[1] = LibraryScriptBase.BookTermSeed(book2, 50 ether, 80 ether);

        // Re-running with identical sealed terms emits zero transactions and succeeds via env entrypoint.
        vm.setEnv("LIBRARY_ESCROW_ADDRESS", _toHexAddress(address(escrow)));
        vm.recordLogs();
        seedScript.run();
        EscrowVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 0, "idempotent rerun emits no events");

        // Wrong signer/administrator must be rejected before broadcast.
        vm.expectRevert(LibraryScriptBase.InvalidDeploymentConfig.selector);
        seedScript.runWithConfig(address(escrow), LIBRARIAN, books);

        // Changing a sealed replacement price in config must fail closed without overwriting.
        books[0].replacementPriceWei = 31 ether;
        vm.expectRevert(
            abi.encodeWithSelector(
                SeedLibraryBooks.SealedBookTermsMismatch.selector, book1, 50 ether, 30 ether, 50 ether, 31 ether
            )
        );
        seedScript.runWithConfig(address(escrow), DEPLOYER, books);
    }

    function _validConfig() private pure returns (DeployLibrary.Config memory) {
        LibraryScriptBase.BookTermSeed[] memory books = new LibraryScriptBase.BookTermSeed[](2);
        books[0] = LibraryScriptBase.BookTermSeed(keccak256("A"), 50 ether, 30 ether);
        books[1] = LibraryScriptBase.BookTermSeed(keccak256("B"), 50 ether, 80 ether);
        return DeployLibrary.Config(DEPLOYER, DEPLOYER, LIBRARIAN, TREASURY, books);
    }

    function _toHexAddress(address value) private pure returns (string memory) {
        bytes20 data = bytes20(value);
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i; i < 20; ++i) {
            str[2 + i * 2] = hexChars[uint8(data[i] >> 4)];
            str[3 + i * 2] = hexChars[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
