import React, { Component } from 'react'

class Dashboard extends Component {
  constructor(props, { authData }) {
    super(props)
    console.log('auth data', this.props, authData);
    authData = this.props
  }

  render() {
    let balance = `${this.props.authData.balance.c[0]}.${this.props.authData.balance.c[1]}`
    return(
      <main className="container">
        <div className="pure-g">
          <div className="pure-u-1-1">
            <h1>Dashboard</h1>
            <p><strong>Congratulations {this.props.authData.name}! <code>{this.props.authData.address}</code> </strong> If you're seeing this page, you've logged in with your own smart contract successfully.</p>
          </div>
          <div className="pure-u-1-1">
            <h4>Balance</h4>
            {balance}
          </div>
          <div className="spread-token-balance">
          <p>
              <h4>Balance</h4>: <span id="TTBalance"></span> SPRE<br/><br/>
              <h4>Account</h4>: <span id="TTAccount"></span> <br/><br/>
          </p>
          </div>
        </div>
      </main>
    )
  }
}

export default Dashboard
