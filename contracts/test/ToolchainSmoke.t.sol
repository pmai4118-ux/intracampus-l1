// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

contract PayableFixture {
    receive() external payable {}
}

contract ToolchainSmokeTest {
    function testNativeValueReachesDeployedContract() public {
        PayableFixture recipient = new PayableFixture();
        (bool sent,) = address(recipient).call{value: 1 wei}("");
        require(sent && address(recipient).balance == 1 wei, "native value was not received");
    }
}
