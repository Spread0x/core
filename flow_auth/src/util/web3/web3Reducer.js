const initialState = {
  web3Instance: null
}

const web3Reducer = (state = initialState, action) => {
  if (action.type === 'WEB3_INITIALIZED')
  {
    let newState = Object.assign({}, state, {
      web3Instance: action.payload.web3Instance,
      network: action.payload.network
    });
    console.log('WEB3_INITIALIZED', newState);
    return newState;
  }
  return state
}

export default web3Reducer
