// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {PurposeBoundGrantVault} from "../src/PurposeBoundGrantVault.sol";

interface GrantVm {
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata errorData) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

/// @dev Implements the exact L04 getter while permitting failed/unavailable registry tests.
contract GrantRegistryStub {
    mapping(address merchant => mapping(bytes32 category => bool)) public allowedMerchantCategories;

    function setMerchantCategory(address merchant, bytes32 category, bool allowed) external {
        allowedMerchantCategories[merchant][category] = allowed;
    }
}

contract UnavailableGrantRegistry {
    function allowedMerchantCategories(address, bytes32) external pure returns (bool) {
        revert("registry unavailable");
    }
}

contract RejectingGrantMerchant {
    receive() external payable {
        revert("merchant unavailable");
    }
}

contract ReenteringGrantMerchant {
    PurposeBoundGrantVault private vault;
    bytes32 private category;
    address private target;
    address private beneficiary;
    bool public reentrySucceeded;
    bytes4 public reentryError;
    uint256 public observedBalance;
    uint256 public observedTotal;

    function configure(PurposeBoundGrantVault vault_, bytes32 category_, address target_, address beneficiary_)
        external
    {
        vault = vault_;
        category = category_;
        target = target_;
        beneficiary = beneficiary_;
    }

    receive() external payable {
        observedBalance = vault.balances(beneficiary, category);
        observedTotal = vault.totalAllocated();
        bytes memory data;
        (reentrySucceeded, data) = address(vault).call(abi.encodeCall(vault.spend, (target, category, 1 ether)));
        if (data.length >= 4) {
            // forge-lint: disable-next-line(unsafe-typecast)
            reentryError = bytes4(data);
        }
    }
}

contract PurposeBoundGrantVaultTest {
    GrantVm private constant vm = GrantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ISSUER = address(0x5000);
    address private constant STUDENT = address(0x5001);
    address private constant OTHER_STUDENT = address(0x5002);
    address private constant CANTEEN = address(0x5003);
    address private constant PARKING = address(0x5004);
    address private constant PERSONAL = address(0x5005);
    bytes32 private constant FOOD = keccak256("FOOD");
    bytes32 private constant PARKING_CATEGORY = keccak256("PARKING");
    uint256 private constant INITIAL_GRANT = 5000 ether;
    GrantRegistryStub private registry;
    PurposeBoundGrantVault private vault;

    function setUp() public {
        registry = new GrantRegistryStub();
        registry.setMerchantCategory(CANTEEN, FOOD, true);
        registry.setMerchantCategory(PARKING, PARKING_CATEGORY, true);
        vault = new PurposeBoundGrantVault(ISSUER, address(registry));
        vm.deal(ISSUER, 20000 ether);
        _grant(STUDENT, FOOD, INITIAL_GRANT);
    }

    function testConfigurationAndFullyBackedGrant() public view {
        require(vault.issuer() == ISSUER, "issuer");
        require(address(vault.merchantRegistry()) == address(registry), "registry");
        require(vault.balances(STUDENT, FOOD) == INITIAL_GRANT, "allocation");
        require(vault.totalAllocated() == INITIAL_GRANT, "total allocation");
        require(address(vault).balance == INITIAL_GRANT, "fully backed");
        require(vault.balances(OTHER_STUDENT, FOOD) == 0, "other student");
    }

    function testOnlyIssuerCanFundGrant() public {
        vm.deal(OTHER_STUDENT, 1 ether);
        vm.expectRevert(PurposeBoundGrantVault.UnauthorizedIssuer.selector);
        vm.prank(OTHER_STUDENT);
        vault.grant{value: 1 ether}(OTHER_STUDENT, FOOD);
        require(OTHER_STUDENT.balance == 1 ether, "sender rollback");
        _unchanged();
    }

    function testConstructorRejectsInvalidConfiguration() public {
        vm.expectRevert(PurposeBoundGrantVault.InvalidConfiguration.selector);
        new PurposeBoundGrantVault(address(0), address(registry));
        vm.expectRevert(PurposeBoundGrantVault.InvalidConfiguration.selector);
        new PurposeBoundGrantVault(ISSUER, address(0));
        vm.expectRevert(PurposeBoundGrantVault.InvalidConfiguration.selector);
        new PurposeBoundGrantVault(ISSUER, PERSONAL);
    }

    function testGrantRejectsInvalidBeneficiaryCategoryAndZeroValue() public {
        vm.expectRevert(PurposeBoundGrantVault.InvalidBeneficiary.selector);
        vm.prank(ISSUER);
        vault.grant{value: 1 ether}(address(0), FOOD);
        vm.expectRevert(PurposeBoundGrantVault.InvalidBeneficiary.selector);
        vm.prank(ISSUER);
        vault.grant{value: 1 ether}(address(vault), FOOD);
        vm.expectRevert(PurposeBoundGrantVault.InvalidCategory.selector);
        vm.prank(ISSUER);
        vault.grant{value: 1 ether}(STUDENT, bytes32(0));
        vm.expectRevert(PurposeBoundGrantVault.InvalidAmount.selector);
        vm.prank(ISSUER);
        vault.grant(STUDENT, FOOD);
        _unchanged();
    }

    function testGrantAccumulatesAndEmitsExactAmount() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit PurposeBoundGrantVault.GrantIssued(STUDENT, FOOD, ISSUER, 1000 ether, 6000 ether);
        _grant(STUDENT, FOOD, 1000 ether);
        require(vault.balances(STUDENT, FOOD) == 6000 ether, "accumulated");
        require(vault.totalAllocated() == 6000 ether && address(vault).balance == 6000 ether, "backing");
    }

    function testSpendPaysCanteenAndEmitsRemainingBudget() public {
        uint256 studentBalance = STUDENT.balance;
        uint256 merchantBalance = CANTEEN.balance;
        vm.expectEmit(true, true, true, true, address(vault));
        emit PurposeBoundGrantVault.GrantSpent(STUDENT, CANTEEN, FOOD, 1000 ether, 4000 ether);
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, 1000 ether);
        require(vault.balances(STUDENT, FOOD) == 4000 ether, "remaining grant");
        require(vault.totalAllocated() == 4000 ether, "total allocation");
        require(address(vault).balance == 4000 ether, "vault native balance");
        require(CANTEEN.balance == merchantBalance + 1000 ether, "merchant native balance");
        require(STUDENT.balance == studentBalance, "no personal withdrawal");
    }

    function testPersonalWalletAndWrongMerchantCategoryAreRejected() public {
        _expectInvalidMerchant(PERSONAL, FOOD);
        _expectInvalidMerchant(PARKING, FOOD);
        _expectInvalidMerchant(CANTEEN, PARKING_CATEGORY);
        _unchanged();
        require(PERSONAL.balance == 0 && PARKING.balance == 0 && CANTEEN.balance == 0, "no recipient paid");
    }

    function testChangingCategoryCannotUseFoodGrantForAllowedParking() public {
        vm.expectRevert(abi.encodeWithSelector(PurposeBoundGrantVault.InsufficientGrantBalance.selector, 0, 1 ether));
        vm.prank(STUDENT);
        vault.spend(PARKING, PARKING_CATEGORY, 1 ether);
        _unchanged();
    }

    function testRemovedMerchantIsBlockedImmediately() public {
        registry.setMerchantCategory(CANTEEN, FOOD, false);
        _expectInvalidMerchant(CANTEEN, FOOD);
        _unchanged();
        require(CANTEEN.balance == 0, "removed merchant unpaid");
    }

    function testSelfRecipientIsRejectedEvenIfRegistryAllowsIt() public {
        registry.setMerchantCategory(STUDENT, FOOD, true);
        _expectInvalidMerchant(STUDENT, FOOD);
        registry.setMerchantCategory(address(vault), FOOD, true);
        _expectInvalidMerchant(address(vault), FOOD);
        registry.setMerchantCategory(address(0), FOOD, true);
        _expectInvalidMerchant(address(0), FOOD);
        _unchanged();
    }

    function testOverspendAndEmptyBeneficiaryAreRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(PurposeBoundGrantVault.InsufficientGrantBalance.selector, INITIAL_GRANT, 6000 ether)
        );
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, 6000 ether);
        vm.expectRevert(abi.encodeWithSelector(PurposeBoundGrantVault.InsufficientGrantBalance.selector, 0, 1 ether));
        vm.prank(OTHER_STUDENT);
        vault.spend(CANTEEN, FOOD, 1 ether);
        _unchanged();
    }

    function testZeroSpendAndCategoryAreRejected() public {
        vm.expectRevert(PurposeBoundGrantVault.InvalidAmount.selector);
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, 0);
        vm.expectRevert(PurposeBoundGrantVault.InvalidCategory.selector);
        vm.prank(STUDENT);
        vault.spend(CANTEEN, bytes32(0), 1 ether);
        _unchanged();
    }

    function testRejectedTransferRollsBackEntireAllocation() public {
        RejectingGrantMerchant rejector = new RejectingGrantMerchant();
        registry.setMerchantCategory(address(rejector), FOOD, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                PurposeBoundGrantVault.MerchantTransferFailed.selector, address(rejector), 1000 ether
            )
        );
        vm.prank(STUDENT);
        vault.spend(address(rejector), FOOD, 1000 ether);
        _unchanged();
        require(address(rejector).balance == 0, "failed recipient unpaid");
        // A rejected recipient must not leave the guard locked.
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, 1000 ether);
        require(vault.balances(STUDENT, FOOD) == 4000 ether, "retry after failed recipient");
    }

    function testReentrancyBlockedAndMerchantSeesDebitedState() public {
        ReenteringGrantMerchant attacker = new ReenteringGrantMerchant();
        attacker.configure(vault, FOOD, CANTEEN, STUDENT);
        registry.setMerchantCategory(address(attacker), FOOD, true);
        _grant(address(attacker), FOOD, 10 ether);
        vm.prank(STUDENT);
        vault.spend(address(attacker), FOOD, 1000 ether);
        require(!attacker.reentrySucceeded(), "reentry blocked");
        require(attacker.reentryError() == PurposeBoundGrantVault.ReentrantGrant.selector, "guard error");
        require(attacker.observedBalance() == 4000 ether, "debit before call");
        require(attacker.observedTotal() == 4010 ether, "total debit before call");
        require(vault.balances(address(attacker), FOOD) == 10 ether, "attacker grant untouched");
        require(address(attacker).balance == 1000 ether && CANTEEN.balance == 0, "one payment only");
        require(address(vault).balance == 4010 ether && vault.totalAllocated() == 4010 ether, "backing");
    }

    function testBudgetsAreSeparatedByBeneficiaryAndCategory() public {
        _grant(OTHER_STUDENT, FOOD, 20 ether);
        _grant(STUDENT, PARKING_CATEGORY, 30 ether);
        vm.prank(OTHER_STUDENT);
        vault.spend(CANTEEN, FOOD, 20 ether);
        vm.prank(STUDENT);
        vault.spend(PARKING, PARKING_CATEGORY, 30 ether);
        _unchanged();
        require(vault.balances(OTHER_STUDENT, FOOD) == 0, "other budget spent");
        require(vault.balances(STUDENT, PARKING_CATEGORY) == 0, "parking budget spent");
    }

    function testEntireBudgetCanBeSpentOnce() public {
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, INITIAL_GRANT);
        require(vault.balances(STUDENT, FOOD) == 0, "empty budget");
        require(address(vault).balance == 0 && vault.totalAllocated() == 0, "empty vault");
        vm.expectRevert(abi.encodeWithSelector(PurposeBoundGrantVault.InsufficientGrantBalance.selector, 0, 1));
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, 1);
        require(CANTEEN.balance == INITIAL_GRANT, "no repeat payout");
    }

    function testRegistryFailureFailsClosed() public {
        UnavailableGrantRegistry unavailable = new UnavailableGrantRegistry();
        PurposeBoundGrantVault unavailableVault = new PurposeBoundGrantVault(ISSUER, address(unavailable));
        vm.prank(ISSUER);
        unavailableVault.grant{value: 10 ether}(STUDENT, FOOD);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "registry unavailable"));
        vm.prank(STUDENT);
        unavailableVault.spend(CANTEEN, FOOD, 1 ether);
        require(unavailableVault.balances(STUDENT, FOOD) == 10 ether, "failed registry budget");
        require(unavailableVault.totalAllocated() == 10 ether, "failed registry allocation");
        require(address(unavailableVault).balance == 10 ether, "failed registry native backing");
    }

    function testDirectNativeTransferCannotCreateUnallocatedGrant() public {
        vm.deal(PERSONAL, 1 ether);
        vm.prank(PERSONAL);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        require(!ok && PERSONAL.balance == 1 ether, "direct transfer rejected");
        _unchanged();
    }

    function testFuzzSpendConservesNativeBalances(uint96 requested) public {
        uint256 amount = uint256(requested) % INITIAL_GRANT + 1;
        vm.prank(STUDENT);
        vault.spend(CANTEEN, FOOD, amount);
        require(vault.balances(STUDENT, FOOD) == INITIAL_GRANT - amount, "fuzz budget");
        require(vault.totalAllocated() == INITIAL_GRANT - amount, "fuzz allocation");
        require(address(vault).balance == INITIAL_GRANT - amount, "fuzz vault");
        require(CANTEEN.balance == amount, "fuzz merchant");
    }

    function _grant(address beneficiary, bytes32 category, uint256 amount) private {
        vm.prank(ISSUER);
        vault.grant{value: amount}(beneficiary, category);
    }

    function _expectInvalidMerchant(address merchant, bytes32 category) private {
        vm.expectRevert(abi.encodeWithSelector(PurposeBoundGrantVault.InvalidMerchant.selector, merchant, category));
        vm.prank(STUDENT);
        vault.spend(merchant, category, 1 ether);
    }

    function _unchanged() private view {
        require(vault.balances(STUDENT, FOOD) == INITIAL_GRANT, "original budget unchanged");
        require(vault.totalAllocated() == INITIAL_GRANT, "total unchanged");
        require(address(vault).balance == INITIAL_GRANT, "vault balance unchanged");
    }
}
