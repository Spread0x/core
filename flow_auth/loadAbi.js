var fs = require('fs');
var Web3 = require('web3');
var json = JSON.parse(fs.readFileSync('./build/contracts/SpreadToken.json', 'utf-8'));
console.log(json.abi);

var web3 = new Web3(new Web3.providers.HttpProvider("http://127.0.0.1:8545"));
var MyContract = web3.eth.contract(json.abi);
var MyContractInstance = MyContract.at('0x56a121a308490b015ee881794f5c4a570684d275');


const IPFS = require('ipfs')

const node = new IPFS()

node.on('ready', () => {
  // Your node is now ready to use \o/
  console.log('node ready')
  

node.files.cat('Qme75koLQzAbF6feCCAK8Tgza923fvqJSUEw2xqF3AkzPH', function (err, file) {
  if (err) {
    console.log(err)
    throw err
  }
  console.log(file);
  console.log(file.toString('utf8'))
})	


// stopping a node
})
