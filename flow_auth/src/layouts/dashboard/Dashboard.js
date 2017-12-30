import React, { Component } from 'react'
import { loginUser, transferSpread, getBalances } from '../../user/ui/loginbutton/LoginButtonActions'
import { connect } from 'react-redux'


const mapStateToProps = (state, ownProps) => {return {}}

const mapDispatchToProps = (dispatch) => {
  return {
    onTransferSubmit: (from, to, quantity) => {
      dispatch(transferSpread(from, to, quantity))
    },
    getBalance: (from) => {
      dispatch(getBalances(from,from,from))
    }
  }
}


class Dashboard extends Component {
  constructor(props, { authData }) {
    super(props)
    this.state = {transfer_addr: '', quantity: 0};
    console.log('auth data', this.props, authData);
    authData = this.props
    this.props.getBalance(this.props.authData.address, this.props.authData.address,this.props.authData.address);
  };

  handleSubmit = (e) => {
    e.preventDefault();
    console.log('onTransferSubmit', transferSpread, this.props.onTransferSubmit);
    console.log(e);
    this.props.onTransferSubmit(this.props.authData.address, this.state.transfer_addr, this.state.quantity);
    this.props.getBalance(this.props.authData.address,this.props.authData.address,this.props.authData.address);
    console.log('this.props.authData', this.props.authData);
  };

  handleChange = (event) => {
    console.log('target', event.target);
    const name = event.target.name;
    this.setState({
      [name]: event.target.value
    });
    console.log('state', this.state);
  };



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
            {balance} <b>ETH</b>
            <hr />
            {this.props.authData.spread} <b>SPRE</b>
          </div>


          <form className="pure-u-1-1 transfer-spread" onSubmit={this.handleSubmit}>
              <input type="text" 
                     name="transfer_addr"
                     value={this.state.transfer_addr} 
                     onChange={this.handleChange} 
                     className="form-control" 
                     id="TTTransferAddress" 
                     placeholder="Address" />
              <input type="number" 
                     name="quantity"
                     value={this.state.quantity} 
                     onChange={this.handleChange} 
                     className="form-control" 
                     id="TTTransferAmount" 
                     placeholder="Amount" />
              <input className="btn btn-primary" type="submit" value="Transfer" />
          </form>

        </div>
      </main>
    )
  }
}
const DashboardContainer = connect(
  mapStateToProps,
  mapDispatchToProps
)(Dashboard)

export default DashboardContainer
