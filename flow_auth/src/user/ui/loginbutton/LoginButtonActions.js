import AuthenticationContract from '../../../../build/contracts/Authentication.json'
import SpreadTokenArtifact from '../../../../build/contracts/SpreadToken.json'
import HelloWorldArtifact from '../../../../build/contracts/HelloWorld.json'



import { browserHistory } from 'react-router'
import store from '../../../store'
const $ = require('jquery');
const contract = require('truffle-contract')

export const USER_LOGGED_IN = 'USER_LOGGED_IN'
function userLoggedIn(user) {
  return {
    type: USER_LOGGED_IN,
    payload: user
  }
}
function spreadTokenTransfered(from,to,quantity) {
  return {
    type: 'SPREAD_TOKEN_TRANSFERED',
    payload: [from,to,quantity]
  }
}
function balanceFetched(spread) {
  return {
    type: 'BALANCE_FETCHED',
    payload: spread
  }
}
const web3 = store.getState().web3.web3Instance


/***************************************************************************************************
 * Spread token logic 
 ***************************************************************************************************/

export var getBalances = (addr, adopters, account) => {
    let web3 = store.getState().web3.web3Instance
    var spreadToken, SpreadTokenInstance;
    spreadToken = contract(SpreadTokenArtifact);
    spreadToken.setProvider(web3.currentProvider);
    var balance;
    if (typeof web3 !== 'undefined') {
      return function(dispatch) {
      console.log('Getting balances...');
      //console.log('coinbase account', account);
      return spreadToken.deployed().then(function(instance) {
        SpreadTokenInstance = instance;
        console.log('account for balanceOf', account);
        //console.log('balanceOf',SpreadTokenInstance.balanceOf(account));
        return SpreadTokenInstance.balanceOf(account);
      }).then(function(result) {
        console.log('result of balance', result.c[0]);
        balance = result.c[0];
        console.log('result for spread token', account, balance);
        return dispatch(balanceFetched(balance));
        //$('#TTAccount').text(account);
        //$('#TTBalance').text(balance);
      }).catch(function(err) {
        console.log(err.message);
        return err.message;
      });
    }
  } else {
    console.error('Web3 is not initialized.');
  }
};


export function contractTesting() {
  authentication.setProvider(web3.currentProvider);
  var helloWorld, HelloWorldInstance;
  helloWorld = contract(HelloWorldArtifact);
  helloWorld.setProvider(web3.currentProvider);

  web3.eth.getAccounts(function(error, accounts) {
    if (error) {console.log(error)}
    var account = accounts[0];
    helloWorld.deployed().then((instance) => {
      HelloWorldInstance = instance;
      return HelloWorldInstance.transfer(toAddress, amount, {from: account});
    }).then(function(result) {
      alert('Transfer Successful!');
      return getBalances(account,account,account);
    }).catch(function(err) {
      console.log(err.message);
    });
  });
}



export function transferSpread(from, to, quantity) {
  // Double-check web3's status.
  if (typeof web3 !== 'undefined') {

    return function(dispatch) {
      // Using truffle-contract we create the authentication object.
      const authentication = contract(AuthenticationContract)
      authentication.setProvider(web3.currentProvider);
      // Declaring this for later so we can chain functions on Authentication.
      var authenticationInstance
      var spreadToken, SpreadTokenInstance;
      spreadToken = contract(SpreadTokenArtifact);
      spreadToken.setProvider(web3.currentProvider);
      const account = from;
      var amount = parseInt(quantity);
      var toAddress = to;
      console.log('Transfer ' + amount + ' TT to ' + toAddress);
      var SpreadTokenInstance;
      web3.eth.getAccounts(function(error, accounts) {
        if (error) {console.log(error)}
        var account = accounts[0];
        spreadToken.deployed().then((instance) => {
          SpreadTokenInstance = instance;
          return SpreadTokenInstance.transfer(toAddress, amount, {from: account});
        }).then(function(result) {
          alert('Transfer Successful!');
          return getBalances(account,account,account);
        }).catch(function(err) {
          console.log(err.message);
        });
      });
      return dispatch(spreadTokenTransfered({from, to, quantity}))
    }
  }
}

export function loginUser(addr) {
  let web3 = store.getState().web3.web3Instance
  // Double-check web3's status.
  if (typeof web3 !== 'undefined') {
    return function(dispatch) {
      // Using truffle-contract we create the authentication object.
      const authentication = contract(AuthenticationContract)
      authentication.setProvider(web3.currentProvider);
      // Declaring this for later so we can chain functions on Authentication.
      var authenticationInstance

      // Get current ethereum wallet.
      web3.eth.getCoinbase((error, coinbase) => {
        // Log errors, if any.
        if (error) {
          console.error(error);
        }
          web3.eth.getBalance(coinbase, (e, blc) => {
          authentication.deployed().then(function(instance) {
            authenticationInstance = instance
            // Attempt to login user.
            authenticationInstance.login({from: coinbase})
            .then(function(result) {
              // If no error, login user.
              var userName = web3.toUtf8(result)

              console.log('balance(error, result)', e, blc, web3.fromWei(blc, "ether") );
              //const spreadBalance = getBalances(coinbase, coinbase,coinbase);
              dispatch(userLoggedIn({"name": userName, "address": coinbase, "balance": web3.fromWei(blc,"ether"), "spread": null}))
              // Used a manual redirect here as opposed to a wrapper.
              // This way, once logged in a user can still access the home page.
              var currentLocation = browserHistory.getCurrentLocation()

              if ('redirect' in currentLocation.query)
              {return browserHistory.push(decodeURIComponent(currentLocation.query.redirect))}

              return browserHistory.push('/dashboard')


            })
            .catch(function(result) {
              // If error, go to signup page.
              console.error('Wallet ' + coinbase + ' does not have an account!')

              return browserHistory.push('/signup')
            })
          })
        })
      })
    }
  } else {
    console.error('Web3 is not initialized.');
  }
}
