// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {StudentSBTIdentity} from "../src/StudentSBTIdentity.sol";
import {CampusPaymentRegistry} from "../src/CampusPaymentRegistry.sol";
import {PurposeBoundGrantVault} from "../src/PurposeBoundGrantVault.sol";

interface DeploymentVm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Deploy with an external Forge keystore signer; this script never reads a private key.
contract Deploy {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant CHAIN_ID = 20261;
    bytes32 public constant PARKING = keccak256("PARKING");
    bytes32 public constant FOOD = keccak256("FOOD");

    struct Config {
        address deployer;
        address sbtIssuer;
        address grantIssuer;
        address posSigner;
        address parkingMerchant;
        address canteenMerchant;
    }

    error WrongChain(uint256 actual);
    error InvalidDeploymentConfig();
    error DeploymentReadbackFailed();

    function run()
        external
        returns (StudentSBTIdentity sbt, CampusPaymentRegistry registry, PurposeBoundGrantVault vault)
    {
        // Check before even reading signer configuration, and again immediately before broadcast.
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        Config memory config = Config({
            deployer: vm.envAddress("DEPLOYER_ADDRESS"),
            sbtIssuer: vm.envAddress("SBT_ISSUER_ADDRESS"),
            grantIssuer: vm.envAddress("GRANT_ISSUER_ADDRESS"),
            posSigner: vm.envAddress("POS_SIGNER_ADDRESS"),
            parkingMerchant: vm.envAddress("PARKING_MERCHANT_ADDRESS"),
            canteenMerchant: vm.envAddress("CANTEEN_MERCHANT_ADDRESS")
        });
        validate(config);
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        vm.startBroadcast(config.deployer);
        (sbt, registry, vault) = deployContracts(config);
        vm.stopBroadcast();
        verify(config, sbt, registry, vault);
    }

    function validate(Config memory config) public pure {
        if (
            config.deployer == address(0) || config.sbtIssuer == address(0) || config.grantIssuer == address(0)
                || config.posSigner == address(0) || config.parkingMerchant == address(0)
                || config.canteenMerchant == address(0) || config.parkingMerchant == config.canteenMerchant
        ) revert InvalidDeploymentConfig();
        // Administrative roles may share one demo operator; merchant wallets stay separate from signing roles.
        address[4] memory roles = [config.deployer, config.sbtIssuer, config.grantIssuer, config.posSigner];
        for (uint256 i; i < roles.length; i++) {
            if (config.parkingMerchant == roles[i] || config.canteenMerchant == roles[i]) {
                revert InvalidDeploymentConfig();
            }
        }
    }

    function deployContracts(Config memory config)
        internal
        returns (StudentSBTIdentity sbt, CampusPaymentRegistry registry, PurposeBoundGrantVault vault)
    {
        sbt = new StudentSBTIdentity(config.sbtIssuer);
        registry = new CampusPaymentRegistry(config.deployer, config.posSigner, address(sbt));
        vault = new PurposeBoundGrantVault(config.grantIssuer, address(registry));
        registry.setMerchantCategory(config.parkingMerchant, PARKING, true);
        registry.setMerchantCategory(config.canteenMerchant, FOOD, true);
    }

    function verify(
        Config memory config,
        StudentSBTIdentity sbt,
        CampusPaymentRegistry registry,
        PurposeBoundGrantVault vault
    ) public view {
        if (
            sbt.issuer() != config.sbtIssuer || registry.admin() != config.deployer
                || registry.posSigner() != config.posSigner || address(registry.studentSbt()) != address(sbt)
                || vault.issuer() != config.grantIssuer || address(vault.merchantRegistry()) != address(registry)
                || !registry.allowedMerchantCategories(config.parkingMerchant, PARKING)
                || !registry.allowedMerchantCategories(config.canteenMerchant, FOOD)
        ) revert DeploymentReadbackFailed();
    }
}
