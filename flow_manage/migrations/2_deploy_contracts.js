var SpreadToken = artifacts.require("SpreadToken");

module.exports = function(deployer) {
  deployer.deploy(SpreadToken);
};