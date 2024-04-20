// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


/**
*
* Virtual powermeter for open DTU on Battery (oDoB)
*
* This scripts runs on any shelly with api 2 or greater.
* This script reads in the current power comsuption and 
* divides it up between n virtual powermeter. The powermeter 
* are then used to feed an controller of oDoB.
* The multiple controller will be cascaded so that at each 
* point in time only one controller is working and the others 
* are independently either at their configured minimum power delivery
* or at their maximum power delivery. 
*
* With this all said, it is noteworthy, that all controllers 
* are connected to the same DC power supply system 
* ( solarpanels and batteries).
*
**/

// version 0.1


// set script ID here
let scriptId=3;
 
// configuration for each controller, add as many as you have controller ( there is an upper limit off 5 controllers defined by the
//  shelly, because you can only be registered up to 5 HTTP endpoints (at the time of writing this code)
// the order in which the controller are added reflects the cascade order, first controller added is the first 
// in the cascade, the later are following then
// nominalPower_Watt : the maximum power the controller can provide
// minRequiredPower_Watt: the minimum Power required to run the controller/inverter,
// mqttControllerBasicTopic : the basic topic of the controller given under mqtt
let configs=[
  		{ nominalPower_Watt: 100, minRequiredPower_Watt: 50, mqttControllerBasicTopic: 'solar/dtuOnBattery/'}
	, 	{ nominalPower_Watt: 800, minRequiredPower_Watt: 80, mqttControllerBasicTopic: 'solar/dtuOnBattery2/'}
];

//power measuring device
let netPowerConfig = {
		type: "local" // choose between local e.g. this script is running on a gen2 device which can measure net power	
					  // or http e.g. this script is running on a gen2 device which can not measure net power and pulls the power readings by http requests	 -- not yet supported/implemented
					  // or mqtt get the power readings delivered by mqtt topic ( provide the topic in address)
		, address: "solar/dtuOnBattery/ac/power" // the address of the powerreading required for http or mqtt
	};
	
// Configuration of hardware:
// in your oDoB contorller i ( on position i) in the configs variable (see above) (i=1..n)
// define in Powermeter the mode https + Json and use http://<Shelly ip this script runs on>/script/<scriptId>/pwr<i> 
// e.g. assume the ip of the shelly on which this script runs on to be: 1.2.3.4, 
// the script id of this script to be 7 and you want to configure the 2nd  odob controller
// then use:  http://1.2.3.4/script/7/pwr2
// the Json path is always PWR


// -------------------------------------------------- configure above this line, don't touch anything underneath this line !!! -------------------------------------------

// the last power reading off each controller
let previousPower = [];

// the defined start power of each controller
let startPower = [];

// power brought to you by the grid
let netPower = 0;

//power generated by all the controllers/inverters
let generatedPower = 0;

// initialize the previous step power for each controller,
// register to mqtt topics 
// create http endpoints
// and configure power readings
function initialize(){  
	var cumulatedPower =0;
	// configure virtualPowerMeter readings
	for (var i = 0; i < configs.length; i++) {
		startPower[i] = cumulatedPower;
		cumulatedPower = cumulatedPower + configs[i].nominalPower_Watt;
		previousPower[i] =0;
		if (configs[i].mqttControllerBasicTopic.substr(-1) != '/') configs[i].mqttControllerBasicTopic += '/';
		MQTT.subscribe(configs[i].mqttControllerBasicTopic + "ac/power", UpdateControllerPower, i);
		HTTPServer.registerEndpoint( "pwr" + (i+1) , VirtualPowerMeterReadings, i)
	}
	// configure netPower readings
	switch (netPowerConfig.type){
		case 'local':	
			Shelly.addStatusHandler( function(event, userdata){
	  			    // Runs when a new Power reading is comming in  					
				    if (typeof event.delta.total_act_power !== "undefined") {
						netPower = event.delta.total_act_power;
  					}
				}, null);
			break;
		case 'mqtt':
			MQTT.subscribe(netPowerConfig.address, UpdateNetPower);	
			break;
	}
}

// update the netPower from mqtt message
function UpdateNetPower( topic, message){
    netPower = message;
}


// send the virtual power meter reading to the requester
function VirtualPowerMeterReadings( request, response, index){
//    print(index);
	var virtualPowerMeter = calculateVirtualPowerReadings( index);
//	print("VPM: " + virtualPowerMeter);
    response.body = JSON.stringify( { PWR : virtualPowerMeter } );
	response.code = 200;
    response.send();
}

// recieve new controller Power values 
function UpdateControllerPower( topic, message, index){
	var newPower = message;
	generatedPower = generatedPower - previousPower[index] + newPower;
//	print("GenPower: " + generatedPower);
	previousPower[index] = 	newPower;	
}

// calculate the power which is seen by the virtual power meter of index
// virtualPowerMeter = measured net-power - required StartPower + over all produced power off all other contorllers
function calculateVirtualPowerReadings( index){
	var powerOffAllOtherInverters = generatedPower - previousPower[index];
//	print([generatedPower, previousPower[index]])
	var virtualPowerMeter = netPower + powerOffAllOtherInverters - startPower[index];
//  limiting the power so that at least each controller recieves its minimum power configured
	var limitedPowerMeter = Math.max( configs[index].minRequiredPower_Watt - previousPower[index], virtualPowerMeter);
//	print("Index: " + index);
//	print("Netpower: " + netpower);
//	print("VirtualPowerMeter: " + virtualPowerMeter)
//	print("limitedPowerMeter: " + limitedPowerMeter)
	return limitedPowerMeter;
}

initialize();