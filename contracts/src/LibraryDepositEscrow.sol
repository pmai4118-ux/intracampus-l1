// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @notice Native CAMPUS escrow holding 50 CAMPUS deposits and settling library loan lifecycles.
contract LibraryDepositEscrow {
    enum EscrowState {
        NONE,
        DEPOSITED,
        ACTIVE,
        REFUNDED,
        RETURN_SETTLED,
        LOST_SHORTFALL_DUE,
        LOST_SETTLED,
        RETURN_RECEIVED
    }

    struct BookTerms {
        uint256 depositWei;
        uint256 replacementPriceWei;
        bool isSealed;
    }

    struct RequestRecord {
        address borrower;
        bytes32 bookId;
        uint256 depositWei;
        uint256 replacementPriceWei;
        uint64 depositedAt;
        uint64 approvedAt;
        uint64 dueAt;
        EscrowState state;
        uint256 shortfallWei;
        uint64 returnReceivedAt;
    }

    event DepositReceived(
        bytes32 indexed requestId, address indexed borrower, bytes32 indexed bookId, uint256 amount, uint64 depositedAt
    );
    event LoanApproved(
        bytes32 indexed requestId,
        address indexed borrower,
        uint64 approvedAt,
        uint64 dueAt,
        uint256 replacementPriceWei
    );
    event RequestRejected(bytes32 indexed requestId, address indexed borrower, uint256 refundWei);
    event ExpiredRefundClaimed(bytes32 indexed requestId, address indexed borrower, uint256 refundWei);
    event PhysicalReturnConfirmed(bytes32 indexed requestId, address indexed borrower, uint64 returnedAt);
    event ReturnSettled(
        bytes32 indexed requestId,
        address indexed borrower,
        uint64 returnedAt,
        uint256 lateFeeWei,
        uint256 repairFeeWei,
        uint256 overdueForfeitWei,
        uint256 totalRetainedWei,
        uint256 refundWei,
        bool maintenanceRequired
    );
    event LostSettled(
        bytes32 indexed requestId,
        address indexed borrower,
        uint256 replacementPriceWei,
        uint256 retainedWei,
        uint256 refundWei,
        uint256 shortfallWei
    );
    event ShortfallPaid(bytes32 indexed requestId, address indexed borrower, uint256 amount);
    event BookTermsSeeded(bytes32 indexed bookId, uint256 depositWei, uint256 replacementPriceWei);
    event BookTermsSealed(bytes32 indexed bookId);

    error InvalidConfiguration();
    error UnauthorizedAdministrator();
    error UnauthorizedLibrarian();
    error UnauthorizedBorrower();
    error InvalidBookTerms();
    error BookTermsAlreadySealed(bytes32 bookId);
    error BookTermsNotSealed(bytes32 bookId);
    error RequestAlreadyUsed(bytes32 requestId);
    error RequestNotFound(bytes32 requestId);
    error InvalidRequestState(bytes32 requestId, uint8 state);
    error ApprovalWindowExpired(uint64 deadline);
    error ApprovalWindowOpen(uint64 deadline);
    error InvalidPayment(uint256 expectedWei, uint256 receivedWei);
    error TransferFailed(address recipient, uint256 amountWei);
    error ReentrantCall();

    uint256 private constant REQUIRED_DEPOSIT_WEI = 50 ether;
    uint64 public constant APPROVAL_WINDOW = 86_400;
    uint64 public constant LOAN_DURATION = 1_209_600;
    uint64 public constant GRACE_PERIOD = 259_200;
    uint64 public constant LATE_FEE_INTERVAL = 86_400;
    uint256 public constant LATE_FEE_PER_INTERVAL = 0.1 ether;
    uint256 public constant MAX_LATE_FEE = 25 ether;
    uint64 public constant FULL_DEPOSIT_RETENTION_AFTER = 2_592_000;

    address public immutable administrator;
    address public immutable librarian;
    address public immutable treasury;

    mapping(bytes32 bookId => BookTerms terms) private _bookTerms;
    mapping(bytes32 requestId => RequestRecord record) private _requests;
    bool private entered;

    constructor(address administrator_, address librarian_, address treasury_) {
        if (
            administrator_ == address(0) || librarian_ == address(0) || treasury_ == address(0)
                || administrator_ == address(this) || librarian_ == address(this) || treasury_ == address(this)
        ) {
            revert InvalidConfiguration();
        }
        administrator = administrator_;
        librarian = librarian_;
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    /// @notice Seeds or updates unsealed book terms with the fixed 50 CAMPUS deposit and positive replacement price.
    function seedBookTerms(bytes32 bookId, uint256 depositWei, uint256 replacementPriceWei) external {
        if (msg.sender != administrator) revert UnauthorizedAdministrator();
        BookTerms storage terms = _bookTerms[bookId];
        if (terms.isSealed) revert BookTermsAlreadySealed(bookId);
        if (bookId == bytes32(0) || depositWei != REQUIRED_DEPOSIT_WEI || replacementPriceWei == 0) {
            revert InvalidBookTerms();
        }

        terms.depositWei = depositWei;
        terms.replacementPriceWei = replacementPriceWei;
        emit BookTermsSeeded(bookId, depositWei, replacementPriceWei);
    }

    /// @notice Permanently seals previously seeded book terms so active/future requests use immutable amounts.
    function sealBookTerms(bytes32 bookId) external {
        if (msg.sender != administrator) revert UnauthorizedAdministrator();
        BookTerms storage terms = _bookTerms[bookId];
        if (terms.isSealed) revert BookTermsAlreadySealed(bookId);
        if (bookId == bytes32(0) || terms.depositWei != REQUIRED_DEPOSIT_WEI || terms.replacementPriceWei == 0) {
            revert InvalidBookTerms();
        }

        terms.isSealed = true;
        emit BookTermsSealed(bookId);
    }

    function bookTerms(bytes32 bookId)
        external
        view
        returns (uint256 depositWei, uint256 replacementPriceWei, bool isSealed)
    {
        BookTerms storage terms = _bookTerms[bookId];
        return (terms.depositWei, terms.replacementPriceWei, terms.isSealed);
    }

    /// @notice Escrows the exact sealed deposit for a never-before-used request ID.
    function deposit(bytes32 requestId, bytes32 bookId) external payable nonReentrant {
        if (msg.sender == address(0) || msg.sender == address(this)) revert UnauthorizedBorrower();
        if (requestId == bytes32(0)) revert InvalidRequestState(requestId, uint8(EscrowState.NONE));

        RequestRecord storage req = _requests[requestId];
        if (req.state != EscrowState.NONE) revert RequestAlreadyUsed(requestId);

        BookTerms memory terms = _bookTerms[bookId];
        if (!terms.isSealed) revert BookTermsNotSealed(bookId);
        if (msg.value != terms.depositWei) revert InvalidPayment(terms.depositWei, msg.value);

        uint64 nowTs = _timestamp();
        req.borrower = msg.sender;
        req.bookId = bookId;
        req.depositWei = terms.depositWei;
        req.replacementPriceWei = terms.replacementPriceWei;
        req.depositedAt = nowTs;
        req.state = EscrowState.DEPOSITED;

        emit DepositReceived(requestId, msg.sender, bookId, terms.depositWei, nowTs);
    }

    /// @notice Approves a pending request strictly before the 24-hour approval deadline.
    function approve(bytes32 requestId) external nonReentrant {
        if (msg.sender != librarian) revert UnauthorizedLibrarian();
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.DEPOSITED) revert InvalidRequestState(requestId, uint8(req.state));

        uint64 deadline = req.depositedAt + APPROVAL_WINDOW;
        uint64 nowTs = _timestamp();
        if (nowTs >= deadline) revert ApprovalWindowExpired(deadline);

        uint64 dueAt = nowTs + LOAN_DURATION;
        req.approvedAt = nowTs;
        req.dueAt = dueAt;
        req.state = EscrowState.ACTIVE;

        emit LoanApproved(requestId, req.borrower, nowTs, dueAt, req.replacementPriceWei);
    }

    /// @notice Rejects a pending request and returns the full deposit to the original borrower.
    function reject(bytes32 requestId) external nonReentrant {
        if (msg.sender != librarian) revert UnauthorizedLibrarian();
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.DEPOSITED) revert InvalidRequestState(requestId, uint8(req.state));

        address borrower = req.borrower;
        uint256 refundWei = req.depositWei;
        req.state = EscrowState.REFUNDED;

        _transferNative(borrower, refundWei);
        emit RequestRejected(requestId, borrower, refundWei);
    }

    /// @notice Refunds an unapproved deposit at or after the 24-hour deadline exclusively to the original borrower.
    function claimExpiredRefund(bytes32 requestId) external nonReentrant {
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.DEPOSITED) revert InvalidRequestState(requestId, uint8(req.state));

        uint64 deadline = req.depositedAt + APPROVAL_WINDOW;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < deadline) revert ApprovalWindowOpen(deadline);

        address borrower = req.borrower;
        uint256 refundWei = req.depositWei;
        req.state = EscrowState.REFUNDED;

        _transferNative(borrower, refundWei);
        emit ExpiredRefundClaimed(requestId, borrower, refundWei);
    }

    /// @notice Confirms physical return in chain time and freezes late-fee accrual prior to settlement.
    function confirmPhysicalReturn(bytes32 requestId) external nonReentrant {
        if (msg.sender != librarian) revert UnauthorizedLibrarian();
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.ACTIVE) revert InvalidRequestState(requestId, uint8(req.state));

        uint64 returnedAt = _timestamp();
        req.returnReceivedAt = returnedAt;
        req.state = EscrowState.RETURN_RECEIVED;

        emit PhysicalReturnConfirmed(requestId, req.borrower, returnedAt);
    }

    /// @notice Settles a confirmed physical return using stored returnReceivedAt, capped fees, and full retention past day 30.
    function settleReturn(bytes32 requestId, uint256 repairRequestedWei) external nonReentrant {
        if (msg.sender != librarian) revert UnauthorizedLibrarian();
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.RETURN_RECEIVED) revert InvalidRequestState(requestId, uint8(req.state));

        uint64 returnedAt = req.returnReceivedAt;
        uint256 depositWei = req.depositWei;
        uint256 elapsedSinceDue = returnedAt > req.dueAt ? returnedAt - req.dueAt : 0;
        uint256 lateFeeWei = _calculateLateFee(elapsedSinceDue);
        if (lateFeeWei > depositWei) lateFeeWei = depositWei;

        bool maintenanceRequired = repairRequestedWei > 0;
        uint256 repairFeeWei;
        uint256 overdueForfeitWei;
        uint256 totalRetainedWei;
        uint256 refundWei;

        if (elapsedSinceDue > FULL_DEPOSIT_RETENTION_AFTER) {
            overdueForfeitWei = depositWei - lateFeeWei;
            repairFeeWei = 0;
            totalRetainedWei = depositWei;
            refundWei = 0;
        } else {
            uint256 remaining = depositWei - lateFeeWei;
            repairFeeWei = repairRequestedWei < remaining ? repairRequestedWei : remaining;
            overdueForfeitWei = 0;
            totalRetainedWei = lateFeeWei + repairFeeWei;
            refundWei = depositWei - totalRetainedWei;
        }

        address borrower = req.borrower;
        req.state = EscrowState.RETURN_SETTLED;

        if (totalRetainedWei > 0) _transferNative(treasury, totalRetainedWei);
        if (refundWei > 0) _transferNative(borrower, refundWei);

        emit ReturnSettled(
            requestId,
            borrower,
            returnedAt,
            lateFeeWei,
            repairFeeWei,
            overdueForfeitWei,
            totalRetainedWei,
            refundWei,
            maintenanceRequired
        );
    }

    /// @notice Settles an active loan as lost using the snapshotted replacement price without separate late fees.
    function settleLost(bytes32 requestId) external nonReentrant {
        if (msg.sender != librarian) revert UnauthorizedLibrarian();
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.ACTIVE) revert InvalidRequestState(requestId, uint8(req.state));

        uint256 depositWei = req.depositWei;
        uint256 replacementPriceWei = req.replacementPriceWei;
        uint256 retainedWei = replacementPriceWei < depositWei ? replacementPriceWei : depositWei;
        uint256 refundWei = depositWei - retainedWei;
        uint256 shortfallWei = replacementPriceWei > depositWei ? replacementPriceWei - depositWei : 0;

        address borrower = req.borrower;
        req.shortfallWei = shortfallWei;
        req.state = shortfallWei > 0 ? EscrowState.LOST_SHORTFALL_DUE : EscrowState.LOST_SETTLED;

        if (retainedWei > 0) _transferNative(treasury, retainedWei);
        if (refundWei > 0) _transferNative(borrower, refundWei);

        emit LostSettled(requestId, borrower, replacementPriceWei, retainedWei, refundWei, shortfallWei);
    }

    /// @notice Collects the exact remaining replacement shortfall from the original borrower.
    function payShortfall(bytes32 requestId) external payable nonReentrant {
        RequestRecord storage req = _requests[requestId];
        if (req.state == EscrowState.NONE) revert RequestNotFound(requestId);
        if (req.state != EscrowState.LOST_SHORTFALL_DUE) revert InvalidRequestState(requestId, uint8(req.state));
        if (msg.sender != req.borrower) revert UnauthorizedBorrower();

        uint256 dueWei = req.shortfallWei;
        if (msg.value != dueWei) revert InvalidPayment(dueWei, msg.value);

        req.shortfallWei = 0;
        req.state = EscrowState.LOST_SETTLED;

        _transferNative(treasury, dueWei);
        emit ShortfallPaid(requestId, req.borrower, dueWei);
    }

    function requestInfo(bytes32 requestId)
        external
        view
        returns (
            address borrower,
            bytes32 bookId,
            uint256 depositWei,
            uint256 replacementPriceWei,
            uint64 depositedAt,
            uint64 approvedAt,
            uint64 dueAt,
            uint8 state,
            uint256 shortfallWei,
            uint64 returnReceivedAt
        )
    {
        RequestRecord storage req = _requests[requestId];
        return (
            req.borrower,
            req.bookId,
            req.depositWei,
            req.replacementPriceWei,
            req.depositedAt,
            req.approvedAt,
            req.dueAt,
            uint8(req.state),
            req.shortfallWei,
            req.returnReceivedAt
        );
    }

    function _calculateLateFee(uint256 elapsedSinceDue) private pure returns (uint256) {
        if (elapsedSinceDue <= GRACE_PERIOD) return 0;
        uint256 intervals = (elapsedSinceDue - GRACE_PERIOD) / LATE_FEE_INTERVAL;
        uint256 maxIntervals = MAX_LATE_FEE / LATE_FEE_PER_INTERVAL;
        if (intervals >= maxIntervals) return MAX_LATE_FEE;
        return intervals * LATE_FEE_PER_INTERVAL;
    }

    function _transferNative(address recipient, uint256 amountWei) private {
        (bool sent,) = recipient.call{value: amountWei}("");
        if (!sent) revert TransferFailed(recipient, amountWei);
    }

    function _timestamp() private view returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > type(uint64).max - LOAN_DURATION) revert InvalidConfiguration();
        // forge-lint: disable-next-line(block-timestamp)
        return uint64(block.timestamp);
    }
}
