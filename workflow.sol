pragma solidity ^0.4.2;
/*
This file is part of the SPREAD Pivot 0.

The SPREAD Pivot 0 is free software: you can redistribute it and/or
modify it under the terms of the GNU lesser General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

The CRUB Contract is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU lesser General Public License for more details.

You should have received a copy of the GNU lesser General Public License
along with the CRUB Contract. If not, see <http://www.gnu.org/licenses/>.

@author Stanislav Sobolev <imajacke@gmail.com>

*/


// Someone should define workflow(elements)

contract Workflow {
	// sequences of elements
    mapping (uint => flow_elem) public elements;
    address public owner;
	string public name;

}



// Action will change state
contract WorkflowAction {

}

contract WorkflowElement {

}
contract Element {
   string public name; 
   mapping (uint => wf_state) public states;

}

/**
 * The WorkflowState contract does this and that...
 */
contract WorkflowState {
    // boolean return
    // numeric return

    /*
       -100
       0
       ______
       0
       100
    /*
	/*
	float return
       -100.0
       0.0
       ______
       0.0
       100.0
    /*



	function WorkflowState () {
		
	}	
}


/**
 * The workflow contract does this and that...
 */
contract workflowExecutor {
	 function executeByAction() public returns (address) {
        balances[msg.sender] += msg.value;



        LogDepositMade(msg.sender, msg.value); // fire event

        return balances[msg.sender];
    }
    private replicateForInstace() public return (instantiatedWorkflow) {

    }
}


/**
 * The workflowAction contract does this and that...
 */
contract workflowAction {
	function workflowAction () {
		// will change state 
	}	
}














