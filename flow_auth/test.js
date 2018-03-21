const HttpProvider = require('ethjs-provider-http')
const BlockTracker = require('eth-block-tracker')
const ethjsUtil = require('ethjs-util')


const provider = new HttpProvider('https://mainnet.infura.io')
const blockTracker = new BlockTracker({ provider })
blockTracker.on('block', (newBlock) => console.log(parseInt(newBlock.number+'', 16)));
blockTracker.start()

