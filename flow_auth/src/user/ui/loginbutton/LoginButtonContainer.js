import { connect } from 'react-redux'
import LoginButton from './LoginButton'
import { loginUser, transferSpread } from './LoginButtonActions'

const mapStateToProps = (state, ownProps) => {
  return {}
}

const mapDispatchToProps = (dispatch) => {
  return {
    onLoginUserClick: (event) => {
      event.preventDefault();
      dispatch(loginUser())
    },
    onTransferSubmit: (from, to, quantity) => {
      //event.preventDefault();
      dispatch(transferSpread(from, to, quantity))
    }
  }
}

const LoginButtonContainer = connect(
  mapStateToProps,
  mapDispatchToProps
)(LoginButton)

export default LoginButtonContainer
