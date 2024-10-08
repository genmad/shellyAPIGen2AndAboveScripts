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


// virtualPowerMeters_oDoB_parallel.js

/**
	*
	* Virtual powermeter for open DTU on Battery (oDoB)
	*
	* This scripts runs on any shelly with api 2 or greater.
	* This script reads in the current power comsuption and 
	* divides it up between n virtual powermeter. The powermeter 
	* are then used to feed an controller of oDoB.
	* 
	* The multiple controller will be either cascaded or the power will be proportionally distributed so that at each 
	* point in time only one controller is working and the others 
	* are independently either at their configured minimum power delivery
	* or at their maximum power delivery. 
	*
	* Minimum required Firmware version of oDoB controller is 2024.09.11 
	* 
	* To achieve a fast response (DELAY = 0.9), set DTU and power meter interval at 1 sec.
	* Make sure the WiFi connection is good enough and both the DTU receiving quality and sending power are such that
	* the DTU achieves the 1/sec interval polling rate.
	*
	* With this all said, it is noteworthy, that all controllers 
	* are connected to the same DC power supply system 
	* ( solarpanels and batteries).
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

/** Changelog
	* version 0.1.4 dated October 4th, 2024 by gitisgreat2023
	* - added parallel functionality
	* - added interverter set/get mismatch compensation (controllers reach target consumption)
	* - allowing negative values for inverter 1 (assuming a Huawei charger is connected to oDoB1 with inverter 1 and none to oDoB2 with inverter 2)
	* - formatted virtual power meter output like the Shelly output (making switching back and forth from Shelly to this virtual power meter script easier)
	* - removed minRequiredPower_Watt (not required, oDoB takes care of that already)
	*
	* version 0.1.3 by genmad
	*
**/

// Testlinks
// http://oob.fritz.box/api/livedata/status?inv=116183773414
// http://odob.fritz.box/api/livedata/status?inv=138291601012
// http://shelly.fritz.box/script/2/pwr2

// set this value to the target grid consumption as defined in odob controller instead of spreadig up the values across all your odob Controllers 
// set in each of the odob controller the target grid consumption then to 0
// negative values feed power to th net positive values recieve power from the net
let targetGridConsumption_Watt = 10;

// Cascade or parallel mode
if (0){
	let algo_mode = "cascade";
}
else {
	let algo_mode = "parallel"; 
}

// Power threshold in Watt to switch parallel usage, below the threshold only inverter 1 is utilized
let powerSplitThreshold = 115;

// Distribution over inverters
let powerSplitWeight = [0.412, 0.588];


// set unique script ID here !!! be aware no other script on your shelly can have the same id !!! ( It does not matter whether they are running or not)
let scriptId=2;

// configuration for each controller, add as many as you have controller ( there is an upper limit off 5 controllers defined by the
//  shelly, because you can only be registered up to 5 HTTP endpoints (at the time of writing this code)
// the order in which the controller are added reflects the cascade order, first controller added is the first 
// in the cascade, the later are following then
// nominalPower_Watt : the maximum power the controller can provide
// minRequiredPower_Watt: the minimum Power required to run the controller/inverter,
// controllerIp: the ip of the odob controller ( inverter needs to be the first/only one registered (e.g.: position 0) at the given controller)
// inverterSerialNumber: the serial number of the inverter to control as shown in oDoB ( settings -> inverter -> serial number)

// http://oob.fritz.box/api/livedata/status?inv=116183773414
let configs=[
	{ nominalPower_Watt: 1500, controllerIp: '192.168.178.204', inverterSerialNumber: 116183773414} //http://shelly.fritz.box/script/2/pwr1
	, 	{ nominalPower_Watt: 2250, controllerIp: '192.168.178.31', inverterSerialNumber: 138291601012} //http://shelly.fritz.box/script/2/pwr2
];

//power measuring device
// choose between "local" e.g. this script is running on a gen2 device which can measure net power ( nothing else needs to be configured for the powerreading)
// or "http" e.g. pulls the power readings by http requests ( configure http settings in httpConfig underneath)
let netPowerConfig = "local" // choose one: "local" or "http"

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
// the Json path is always '/em:0/total_act_power', just like with the Shelly.




// -------------------------------------------------- configure above this line, don't touch anything underneath this line !!! -------------------------------------------

// factor to influence the waiting till the next call for NetPower and InverterPower
let DELAY = 0.9;

// Counter for the number of updates on the inverter
let COUNTER = []; 

// Settling time inverter, at this timescale difference between set and get are most probably constant
let COUNTER_CHG = Math.round(3/DELAY); 

// Difference set limit and actual produced power, after settling time
let wr_set_get_mismatch = [];

// THreshold for successively not repsnding devices ( threshold for each individually)
let TIMEOUT_THRESHOLD = 10;

// Threshold for no HTTP responses [minutes]
let TIMEOUT_NETWORK = 1;

// the last power reading off each controller
let previousPower = [];

// Power output of Huawei charger
let huaweiPower = [];

// the defined start power of each controller
let startPower = [];

// power brought to you by the grid
let netPower = 0;

//power generated by all the controllers/inverters
let generatedPower = 0;

let ONE_SECOND = 1000;

let ONE_MINUTE = 60 * ONE_SECOND;

let TimeOutCounter = [];

let TimerHandles = [];

// initialize the previous step power for each controller,
// register to mqtt topics 
// create http endpoints
// and configure power readings
function initialize(){  
	TimeOutCounter[0] =0;
	var cumulatedPower =0;
	// configure virtualPowerMeter readings
	for (var i = 0; i < configs.length; i++) {
		COUNTER[i] = 0;
		TimeOutCounter[i+1] =0;
		startPower[i] = cumulatedPower;
		cumulatedPower = cumulatedPower + configs[i].nominalPower_Watt;
		previousPower[i] = 0;
		wr_set_get_mismatch[i] = 0;
		// call twice during a normal hoymiles cycle (5 seconds)
		dict = {url: "http://" + configs[i].controllerIp + "/api/livedata/status?inv=" + configs[i].inverterSerialNumber, index: i}
		controllerCall( dict);
		HTTPServer.registerEndpoint( "pwr" + (i+1) , VirtualPowerMeterReadings, i)
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
		default:
		print('No netPower configured!!')
		print(netPowerConfig.toLowerCase()=='local')
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
		print(error);
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
		//print("NetPower: " + netPower);
	}
	Timer.set( DELAY * ONE_SECOND, false, powerMeterCall);
}

// process the http Response of the power Meter configured with http polling
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
		newLimit = body.inverters[0].limit_absolute;
		huawei_active = body.huawei.enabled;
		if (huawei_active){
			huawei_power = body.huawei.Power.v;
			} else {
			huawei_power = 0; 
		}
		//print("Huawei power " + huawei_power)
		huaweiPower[dict.index] = huawei_power;
		TimeOutCounter[dict.index+1] =0;
		UpdateControllerPower( newPower, dict.index);
	}
	Timer.set( DELAY * ONE_SECOND, false, controllerCall, dict);
}

// send the virtual power meter reading to the requester
function VirtualPowerMeterReadings( request, response, index){
	//	print("function VirtualPowerMeterReadings " + index);
	var virtualPowerMeter = calculateVirtualPowerReadings( index);
	//  print("VPM: " + virtualPowerMeter);
	response.body = JSON.stringify( {"em:0":{"total_act_power":virtualPowerMeter}} );
	response.code = 200;
	response.send();
}

// recieve new controller Power values 
function UpdateControllerPower( newPower, index){
	generatedPower = generatedPower - previousPower[index] + newPower;
	previousPower[index] = newPower;
	//print("Update for index " + index + ":" + Math.round(generatedPower) + " :" + Math.round(previousPower[index]) + " :" + Math.round(newPower));
}

// calculate the power which is seen by the virtual power meter of index
// virtualPowerMeter = measured net-power - required StartPower + over all produced power off all other contorllers
function calculateVirtualPowerReadings( index){
	switch (algo_mode.toLowerCase()){
		case 'cascade':
		var powerOffAllOtherInverters = generatedPower - previousPower[index];
		//	print([generatedPower, previousPower[index]])
		var virtualPowerMeter = netPower - targetGridConsumption_Watt + powerOffAllOtherInverters - startPower[index];
		
		//  limiting the power so that at least each controller recieves its minimum power configured
		//	var limitedPowerMeter = Math.max( configs[index].minRequiredPower_Watt - previousPower[index], virtualPowerMeter);
		if (index == 1){
			var limitedPowerMeter = Math.max(-previousPower[index], virtualPowerMeter);
		}
		else{
			var limitedPowerMeter = virtualPowerMeter;
		}	
		break;
		case 'parallel':
		var powersplit = netPower - targetGridConsumption_Watt + generatedPower; // this load has to be distributed over the inverters
		// Distribute 0.33, 0.67 to WR1 and WR2. Use startPower for powersplit: 0.67 for the 2250W WR2, 0.33 for the 1500W WR1, threshold at 100W: WR1 33W, WR2 67W
		
		//print("Powersplit " + Math.round(powersplit) + " gen " + Math.round(generatedPower) + " net " + Math.round(netPower))
		//	print([generatedPower, previousPower[index]])
		var limitedPowerMeter = 0; 
		if (index == 1 && huaweiPower[0] == 0 && powersplit > powerSplitThreshold){
			limitedPowerMeter = powersplit*powerSplitWeight[1] - previousPower[index];
			//print("WR1 " + Math.round(limitedPowerMeter) + " powersplit*"+powerSplitWeight[1] + " " + Math.round(powersplit*powerSplitWeight[1])+ " current " + Math.round(previousPower[index]))
		}
		else{
			if (index == 0){
				if (powersplit <= powerSplitThreshold){
					limitedPowerMeter = powersplit*1.00 - previousPower[index];
					} else {
					limitedPowerMeter = powersplit*powerSplitWeight[0] - previousPower[index]; // otherwise no negative values! So no charging enabled. Cap WR1 to powerlimit, to have WR2 the rest in the other loop
				}
				//print("WR0 " + Math.round(limitedPowerMeter) + " powersplit*"+powerSplitWeight[0] + " " + Math.round(powersplit*powerSplitWeight[0])+ " current " + Math.round(previousPower[index]))
				}else{
				if((index == 1 && huaweiPower[0] != 0) || ((index == 1) && (powersplit <= powerSplitThreshold))){
					limitedPowerMeter = -2250;
				}
			}
		}
		break;
		default:
		print(algo_mode.toLowerCase()+': no valid algorithm mode!!')
	}
	
	// Inverter set/get mismatch compensation
	if (newPower != 0 && huaweiPower[0] == 0) {
		COUNTER[index] = COUNTER[index] + 1;
		//print("Index: " + index + " Power:Limit " + Math.round(newPower) + ":" + Math.round(newLimit) + " delta: " + Math.round(newLimit - newPower))
		if (COUNTER[index] % COUNTER_CHG == 0){
			wr_set_get_mismatch[index] = Math.round(Math.max(Math.min(newLimit - newPower,250),-250));
			//print("WR"+index+" set/get comp: "+wr_set_get_mismatch[index])    	
			COUNTER[index] = 0;
		}
		limitedPowerMeter = limitedPowerMeter + wr_set_get_mismatch[index];
	}
	//print("Output WR" + index + ": " + Math.round(limitedPowerMeter))
	return Math.round(limitedPowerMeter);
}

initialize();
