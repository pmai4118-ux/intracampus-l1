// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Deploy, DeploymentVm} from "../script/Deploy.s.sol";
import {StudentSBTIdentity} from "../src/StudentSBTIdentity.sol";
import {CampusPaymentRegistry} from "../src/CampusPaymentRegistry.sol";
import {PurposeBoundGrantVault} from "../src/PurposeBoundGrantVault.sol";

interface DeployTestVm {
    function chainId(uint256 chain) external;
    function setEnv(string calldata key, string calldata value) external;
    function expectRevert(bytes calldata data) external;
    function expectRevert(bytes4 selector) external;
    function getNonce(address account) external view returns (uint64);
}

contract DeployTest {
    DeployTestVm private constant vm = DeployTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Deploy private script;

    function setUp() public {
        script = new Deploy();
        vm.chainId(20261);
        vm.setEnv("DEPLOYER_ADDRESS", "0x0000000000000000000000000000000000001000");
        vm.setEnv("SBT_ISSUER_ADDRESS", "0x0000000000000000000000000000000000001001");
        vm.setEnv("GRANT_ISSUER_ADDRESS", "0x0000000000000000000000000000000000001002");
        vm.setEnv("POS_SIGNER_ADDRESS", "0x0000000000000000000000000000000000001003");
        vm.setEnv("PARKING_MERCHANT_ADDRESS", "0x0000000000000000000000000000000000002000");
        vm.setEnv("CANTEEN_MERCHANT_ADDRESS", "0x0000000000000000000000000000000000002001");
    }

    function testDeployOrderRolesAndAllowlistReadback() public {
        (StudentSBTIdentity sbt, CampusPaymentRegistry registry, PurposeBoundGrantVault vault) = script.run();
        require(sbt.issuer() == address(0x1001), "sbt issuer");
        require(registry.admin() == address(0x1000), "admin");
        require(registry.posSigner() == address(0x1003), "signer");
        require(address(registry.studentSbt()) == address(sbt), "sbt wiring");
        require(vault.issuer() == address(0x1002), "grant issuer");
        require(address(vault.merchantRegistry()) == address(registry), "registry wiring");
        require(registry.allowedMerchantCategories(address(0x2000), keccak256("PARKING")), "parking");
        require(registry.allowedMerchantCategories(address(0x2001), keccak256("FOOD")), "canteen");
        require(!registry.allowedMerchantCategories(address(0x2000), keccak256("FOOD")), "parking cannot food");
    }

    function testWrongChainRefusesBeforeBroadcast() public {
        vm.chainId(43113);
        uint64 nonce = vm.getNonce(address(0x1000));
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, uint256(43113)));
        script.run();
        require(vm.getNonce(address(0x1000)) == nonce, "no deployment");
    }

    function testZeroRoleRefusesBeforeBroadcast() public {
        Deploy.Config memory config = validConfig();
        config.grantIssuer = address(0);
        vm.expectRevert(Deploy.InvalidDeploymentConfig.selector);
        script.validate(config);
        require(vm.getNonce(address(0x1000)) == 0, "no deployment");
    }

    function testMerchantCannotBeSigningOperator() public {
        Deploy.Config memory config = validConfig();
        config.canteenMerchant = config.posSigner;
        vm.expectRevert(Deploy.InvalidDeploymentConfig.selector);
        script.validate(config);
    }

    function testMerchantWalletsMustBeDistinct() public {
        Deploy.Config memory config = validConfig();
        config.canteenMerchant = config.parkingMerchant;
        vm.expectRevert(Deploy.InvalidDeploymentConfig.selector);
        script.validate(config);
    }

    function validConfig() private pure returns (Deploy.Config memory) {
        return Deploy.Config(
            address(0x1000), address(0x1001), address(0x1002), address(0x1003), address(0x2000), address(0x2001)
        );
    }
}
