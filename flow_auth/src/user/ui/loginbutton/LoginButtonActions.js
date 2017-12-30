import AuthenticationContract from '../../../../build/contracts/Authentication.json'
import SpreadTokenArtifact from '../../../../build/contracts/SpreadToken.json'

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

export function loginUser(addr) {
  let web3 = store.getState().web3.web3Instance

  // Double-check web3's status.
  if (typeof web3 !== 'undefined') {

    return function(dispatch) {
      // Using truffle-contract we create the authentication object.
      const authentication = contract(AuthenticationContract)
      authentication.setProvider(web3.currentProvider)

      // Declaring this for later so we can chain functions on Authentication.
      var authenticationInstance

/***************************************************************************************************
 * Spread token logic 
 ***************************************************************************************************/
      var spreadToken, SpreadTokenInstance;
      spreadToken = contract(SpreadTokenArtifact);
      spreadToken.setProvider(web3.currentProvider);
      const account = addr;
      var balance;
      var amount = parseInt($('#TTTransferAmount').val());
      var toAddress = $('#TTTransferAddress').val();

      const getBalances = function(adopters, account) {
        console.log('Getting balances...');
        var SpreadTokenInstance;
        web3.eth.getAccounts(function(error, accounts) {
          if (error) {
            console.log(error);
          }
          var account = addr;
          console.log('accounts', accounts);
          console.log('coinbase account', account);
          console.log('contract', spreadToken.deployed());
          spreadToken.deployed().then(function(instance) {
            SpreadTokenInstance = instance;
            console.log(SpreadTokenInstance.balanceOf(account));
            return SpreadTokenInstance.balanceOf(account);
          }).then(function(result) {
            console.log('result of balance', result);
            balance = result.c[0];

            $('#TTAccount').text(account);
            $('#TTBalance').text(balance);
          }).catch(function(err) {
            console.log(err.message);
          });
        });
      };






      spreadToken.deployed().then(function(instance) {
        SpreadTokenInstance = instance;
        return SpreadTokenInstance.transfer(toAddress, amount, {from: account});
      }).then(function(result) {
        alert('Transfer Successful!');
        return getBalances();
      }).catch(function(err) {
        console.log(err.message);
      });








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
              dispatch(userLoggedIn({"name": userName, "address": coinbase, "balance": web3.fromWei(blc,"ether")}))

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
