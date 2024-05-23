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
* Virtual powermeter for open DTU on Battery (oDoB) (https://github.com/helgeerbe/OpenDTU-OnBattery)
*
* This scripts runs on any shelly with api 2 or greater.
* This script reads in the current power comsuption and 
* divides it up between n virtual powermeter. The powermeter 
* are then used to feed an controller of oDoB.
* The multiple controller will be controlled in parallel so that at each 
* point in time every controller is working at the same percentage of its full power
* except everyone is running at their minimum power delivery
*
* Minimum required Firmware version of oDoB controller is 24.02.12
*
* Please be also aware, that when observing the system with MQTT values,
* that there will be issues that not always will everything fit together 
* properly. MQTT values will be delayed by the odob controller. So do not 
* assume that an MQTT reading will reflect the timely correct status of 
* the system. We tested it and found out that they only match approximately
* because different values might be posted in different time slices, so that
* what you see might not be what you really have.
*
* We recommend to set on each odob controller in the dynamic power limiter settings
* the target grid consumption to 0 and set the variable targetGridConsumption_Watt 
* in this skript to achieve the same thing.
*
**/

// version 0.1.0


// set unique script ID here !!! be aware no other script on your shelly can have the same id !!! ( It does not matter whether they are running or not)
let scriptId=4;
 
// configuration for each controller, add as many as you have controller ( there is an upper limit off 5 controllers defined by the
//  shelly, because you can only be registered up to 5 HTTP endpoints (at the time of writing this code)
// nominalPower_Watt : the maximum power the controller can provide
// minRequiredPower_Watt: the minimum Power required to run the controller/inverter,
// controllerIp: the ip of the odob controller ( inverter needs to be the first/only one registered (e.g.: position 0) at the given controller)
// inverterSerialNumber: the serial number of the inverter to control as shown in oDoB ( settings -> inverter -> serial number)
let configs=[
  		{ nominalPower_Watt: 100, minRequiredPower_Watt: 50, controllerIp: '192.168.178.67', inverterSerialNumber: 116182803975}
	, 	{ nominalPower_Watt: 800, minRequiredPower_Watt: 80, controllerIp: '192.168.178.68', inverterSerialNumber: 000}
];

//power measuring device
	// choose between "local" e.g. this script is running on a gen2 device which can measure net power ( nothing else needs to be configured for the powerreading)
	// or "http" e.g. pulls the power readings by http requests ( configure http settings in httpConfig underneath)
let netPowerConfig = "http" // choose one: "local" or "http"

// configure http access ( path to the power reading)
let httpConfig = {
		 address: "http://192.168.178.67/api/livedata/status?inv=116182803975" // the address of the http powerreading required
		, jsonPath: "inverters/0/AC/0/Power/v" // jsonPath for parsing the message for the powerreading, seperate every field by a '/'
		// e.g.: inverters[0].name needs to be represented as: inverters.0.name
	};

	
// Configuration of your oDoB contorller i ( on position i) in the configs variable (see above) (i=1..n)
//
// define in Powermeter the mode https + Json and use http://<Shelly ip this script runs on>/script/<scriptId>/pwr<i> 
// e.g. assume the ip of the shelly on which this script runs on to be: 1.2.3.4, 
// the script id of this script to be 7 and you want to configure the 2nd  odob controller
// then use:  http://1.2.3.4/script/7/pwr2
// the Json path is always 'PWR'

// set this value to the target grid consumption as defined in odob controller instead of spreadig up the values across all your odob Controllers 
// set in each of the odob controller the target grid consumption then to 0
// negative values feed power to the net, positive values recieve power from the net
let targetGridConsumption_Watt = 0;


// -------------------------------------------------- configure above this line, don't touch anything underneath this line !!! -------------------------------------------

// factor to influence the waiting till the next call for NetPower and InverterPower
let DELAY = 5;

// THreshold for successively not repsnding devices ( threshold for each individually)
let TIMEOUT_THRESHOLD = 10;

// Threshold for no HTTP responses [minutes]
let TIMEOUT_NETWORK = 1;

// power brought to you by the grid
let netPower = 0;

// the last power reading off each controller
let previousPower = [];

let ONE_SECOND = 1000;

let ONE_MINUTE = 60 * ONE_SECOND;

let TimeOutCounter = [];

let TimerHandles = [];

// calculate the power distributionFactor for each controller,
// create http endpoints
// and configure power readings
function initialize(){  
	TimeOutCounter[0] =0;
	var cumulatedPower =0;
	for (var i = 0; i < configs.length; i++) {
		cumulatedPower = cumulatedPower + configs[i].nominalPower_Watt;
	}
	// configure virtualPowerMeter readings
	for (var i = 0; i < configs.length; i++) {
		print(" Configs: " + i);
		TimeOutCounter[i+1] =0;
		previousPower[i] =0;
		dict = {url: "http://" + configs[i].controllerIp + "/api/livedata/status?inv=" + configs[i].inverterSerialNumber, index: i}
		controllerCall( dict);
		HTTPServer.registerEndpoint( "pwr" + (i+1) , VirtualPowerMeterReadings, i)
		configs[i].powerQutient =  configs[i].nominalPower_Watt/cumulatedPower;
	}
	// configure netPower readings
	switch (netPowerConfig.toLowerCase()){
		case 'local':
			Shelly.addStatusHandler( 
				function(event, userdata){
					// Runs when a new Power reading is comming in
					if (typeof event.delta.total_act_power !== "undefined") {
						netPower = event.delta.total_act_power;
					}
				}
				, null);
			break;
		case 'http':
			// calls repeatedly, the httpTimer function
			powerMeterCall();
			httpConfig.jsonPath = httpConfig.jsonPath.split("/");
			break;
	}
}

// cyclicly update the net power when http is configured
function powerMeterCall( userdata){
	// safeguarding No HTTP calls -> kill yourself if not updated 
	Timer.clear(TimerHandles[configs.length]);	
	TimerHandles[configs.length] = Timer.set(TIMEOUT_NETWORK * ONE_MINUTE, false, kill, configs.length);
	Shelly.call("HTTP.GET", {url: httpConfig.address}, processHttpResponseForNetPower);
	
}

// cyclicly update the inverter power when http is configured
function controllerCall( dict){
	// safeguarding No HTTP calls -> kill yourself if not updated 
	print("ControllerCall: " + dict.index );
	Timer.clear(TimerHandles[dict.index]);	
	TimerHandles[dict.index] = Timer.set(TIMEOUT_NETWORK * ONE_MINUTE, false, kill, dict.index);
	Shelly.call("HTTP.GET", {url: dict.url}, processHttpResponseForInverterPower, dict);
}

function kill( index){
	var message = "";
	if ( configs.length == index ){
		message = "No response off Power Reading for " + TIMEOUT_NETWORK + " minutes.";
	}else{
		message = "No response off " + configs[index].controllerIp + " for " + TIMEOUT_NETWORK + " minutes.";
	}
	throw new Error(message);	
}


// process the http Response of the power Meter configured with http polling
function processHttpResponseForNetPower( result, error_code, error) {
	if (TimeOutCounter[0] > TIMEOUT_THRESHOLD){
		throw {name : "NetPowerNotResponding", message : "Your net power provider did not answer for a while. This script will be terminated now."};
	}
	if (error_code != 0) {
		netPower = 0;
		// something went wrong ... what shall we do?? ( with a drunken sailor?)
		print("function processHttpResponseForNetPower HttpRequest to powerMeter Failed with error code: ");
		print(error_code);
		print("\nand Error: ")
		if( typeof error !== 'undefined'){
			print(error);
		}
		TimeOutCounter[0]++;
	} else {
		// no try catch here! let them crash on start immediately and if ever somethig changes let them also crash!!! So the user will faster know something is wrong
		body = JSON.parse(result.body);
		// dynamically parse the unknown body from a split up string
		for(i=0; i < httpConfig.jsonPath.length; i++){
			body = body[httpConfig.jsonPath[i]];
		}
		netPower = body;
		TimeOutCounter[0] = 0;
//		print("NetPower: " + netPower);
	}
}

// process the http Response of the inverter configured with http polling
function processHttpResponseForInverterPower( result, error_code, error, dict) {
	if (TimeOutCounter[dict.index + 1 ] > TIMEOUT_THRESHOLD){
		throw {name : "ControllerNotResponding", message : "Your Controller: " + dict.index + " did not answer for a while. This script will be terminated now."};
	}

	if (error_code != 0) {
		// something went wrong ... what shall we do?? ( with a drunken sailor?)
		print("function processHttpResponseForInverterPower: HttpRequest to controller '" + configs[dict.index].controllerIp + "'' Failed with error code: ");
		print(error_code);
		print("\nand Error: ")
		print(error);
		TimeOutCounter[dict.index+1]++;
	} else {
		// no try catch here! let them crash on start immediately and if ever somethig changes let them also crash!!! So the user will faster know something is wrong
		body = JSON.parse(result.body);
		newPower = body.inverters[0].AC[0].Power.v;
		TimeOutCounter[dict.index+1] =0;
		UpdateControllerPower( newPower, dict.index);
	}
}

// send the virtual power meter reading to the requester
function VirtualPowerMeterReadings( request, response, index){
//	print("function VirtualPowerMeterReadings " + index);
	var virtualPowerMeter = calculateVirtualPowerReadings( index);
//  print("VPM: " + virtualPowerMeter);
	response.body = JSON.stringify( { PWR : virtualPowerMeter } );
	response.code = 200;
	response.send();
}

// recieve new controller Power values 
function UpdateControllerPower( newPower, index){
	previousPower[index] = newPower;
//	print(" NewPower: " + newPower);
}

// calculate the power which is seen by the virtual power meter of index
function calculateVirtualPowerReadings( index){
	var virtualPowerMeter = (netPower - targetGridConsumption_Watt) * configs[index].powerQutient;
//  limiting the power so that at least each controller recieves its minimum power configured
	var limitedPowerMeter = Math.max( configs[index].minRequiredPower_Watt - previousPower[index], virtualPowerMeter);
//  limitedPowerMeter values tell odob 
//. when negative: reduce the power of the inverter by that ammount, 
//  when positive: increase the power of the inverter by that ammount

//	print("Index: " + index);
//	print("Netpower: " + netPower);
//	print("VirtualPowerMeter: " + virtualPowerMeter)
//	print("limitedPowerMeter: " + limitedPowerMeter)
	return limitedPowerMeter;
}

initialize();