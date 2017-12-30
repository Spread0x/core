const initialState = {
  data: null
}

const userReducer = (state = initialState, action) => {
  if (action.type === 'USER_LOGGED_IN' || action.type === 'USER_UPDATED')
  {
    return Object.assign({}, state, {
      data: action.payload
    })
  }

  if (action.type === 'USER_LOGGED_OUT')
  {
    return Object.assign({}, state, {
      data: null
    })
  }
  if (action.type === 'BALANCE_FETCHED')
  {
    console.log('BALANCE_FETCHED', action, state);
    console.log('BALANCE_FETCHED', Object.assign({}, state, {
      data: Object.assign(state.data, {spread: action.payload})
    }));
    return Object.assign({}, state, {
      data: Object.assign(state.data, {spread: action.payload})
    })
  }

  return state
}

export default userReducer
