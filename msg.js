//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Nov 2014
//

var util = require('util');
var fs = require('fs');
var repl = require('repl');
var path = require('path');
var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var lib = require(__dirname + '/lib');
var aws = require(__dirname + '/aws');
var ipc = require(__dirname + '/ipc');
var cluster = require('cluster');
var apnagent = require("apnagent");
var gcm = require('node-gcm');

// Messaging and push notifications for mobile and other clients, supports Apple, Google and AWS/SNS push notifications.
var msg = {
    args: [ { name: "apn-cert", type: "list", descr: "Path to a certificate(s) for APN service, pfx format, .p12 ext, the mode is derived from the certificate name, presence of the word 'production' in the cert file name will enable production mode, the file name can be appended with @app to separate different applications, app is a bundle identifier of the app" },
            { name: "gcm-key", type:"list", descr: "Google Cloud Messaging API key(s), a key can be appended with @app for different applications similar to APN certificate file names" },
            { name: "queue-key", descr: "A queue key to subscribe for clients and listen for servers so messages can be exchanged in the queue environment where multiple queue exist" },
            { name: "server-queue-host", descr: "A queue to create for receiving messages from the clients and forwarding to the actual gateways" },
            { name: "server-queue-options", type: "json", descr: "JSON object with options to the queue server" },
            { name: "client-queue-host", descr: "A queue to create where to send all messages instead of actual gateways" },
            { name: "client-queue-options", type: "json", descr: "JSON object with options to the queue client" },
            { name: "shutdown-timeout", type:" int", min: 500, descr: "How long to wait for messages draining out in ms on shutting down before exiting" },],
    apnAgents: {},
    gcmAgents: {},
    shutdownTimeout: 2000,
};

module.exports = msg;

// Initialize supported notification services, this must be called before sending any push notifications
msg.init = function(callback)
{
    var self = this;
    if (typeof callback != "function") callback = lib.noop;

    // Explicitly configured notification client queue, send all messages there
    if (this.clientQueue) {
        this.clientQueue = ipc.createClient(this.clientQueue, this.clientQueueOptions);
        if (this.clientQueue) return callback();
    }

    // Explicitely configured notification server queue
    if (this.serverQueue) {
        this.serverQueue = ipc.createClient(this.serverQueue, this.serverQueueOptions);
        this.serverQueue.subscribe(this.queueKey || "", function(arg, key, data) {
            self.send(lib.jsonParse(data, { obj: 1 }));
        });
    }

    // Direct access to the gateways
    this.initAPN();
    this.initGCM();
    callback();
}

// Shutdown notification services, wait till all pending messages are sent before calling the callback
msg.shutdown = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    // Wait a little just in case for some left over tasks
    setTimeout(function() {
        lib.parallel([
           function(next) {
               self.closeAPN(next);
           },
           function(next) {
               self.closeGCM(next);
           },
        ], callback);
    }, options.timeout || self.shutdownTimeout);
}

// Gracefully drain all message queues on worker exit
msg.shutdownWorker = function(options, callback)
{
    this.shutdown(options, callback);
}

// Gracefully drain all message queues on web process exit
msg.shutdownWeb = function(options, callback)
{
    this.shutdown(options, callback);
}

// Deliver a notification using the specified service, apple is default.
// Options may contain the following properties:
//  - device_id - device(s) where to send the message to, can be multiple ids separated by , or |
//  - service - which service to use for delivery: sns, apn, gcm
//  - msg - text message to send
//  - badge - badge number to show if supported by the service
//  - type - set type of the message, service specific
//  - id - send id with the notification, this is application specific data, sent as is
msg.send = function(options, callback)
{
    var self = this;
    if (typeof callback != "function") callback = lib.noop;
    if (!options || !options.device_id) return callback ? callback(new Error("invalid device or options")) : null;

    // Queue to the server instead of sending directly
    if (this.clientQueue) return this.clientQueue.publish(this.queueKey || "", options, callback);

    logger.info("send:", options.id, options.device_id, options.msg);

    // Determine the service to use from the device token
    var service = options.service || "";
    var devices = lib.strSplit(options.device_id, null, "string");
    lib.forEachSeries(devices, function(device, next) {
        var device_id = device;
        var dev = self.parseDevice(device_id);
        if (!dev.id) return next();
        logger.dev("send:", dev, options.id || "");
        switch (dev.service) {
        case "gcm":
            self.sendGCM(device_id, options, function(err) {
                if (err) logger.error("send:", device_id, err);
                next();
            });
            break;

        case "sns":
            self.sendSNS(device_id, options, function(err) {
                if (err) logger.error("send:", device_id, err);
                next();
            });
            break;

        case "apn":
            self.sendAPN(device_id, options, function(err) {
                if (err) logger.error("send:", device_id, err);
                next();
            });
            break;

        default:
            logger.error("send:", device, "invalid service");
        }
    }, callback);
}

// Parse device URN and returns an object with all parts into separate properties. A device URN can be in the following format:
//    [service://]device_token[@app]
//
//  - service is optional and defaults to `apn`, other options are `gcm`, `aws`
//  - app is optional and can define an application id which is used by APN for routing to the devices with corresponding APS certificate.
msg.parseDevice = function(device)
{
    var dev = { id: "", service: "apn", app: "default" };
    var d = String(device || "").match(/^([a-z]+\:\/\/)?([^@]+)@?([a-z0-9\.\_-]+)?/);
    if (d) {
        if (d[2] && d[2] != "undefined") dev.id = d[2];
        if (d[1]) dev.service = d[1].replace("://", "");
        if (d[3]) dev.app = d[3];
    }
    return dev;
}

// Initiaize Apple Push Notification service in the current process, Apple supports multiple connections to the APN gateway but
// not too many so this should be called on the dedicated backend hosts, on multi-core servers every spawn web process will initialize a
// connection to APN gateway.
msg.initAPN = function()
{
    var self = this;

    if (!this.apnCert || !this.apnCert.length) return;
    for (var i = 0; i < this.apnCert.length; i++) {
        var file = this.apnCert[i], app = "default";
        if (file.indexOf("@") > -1) {
            var d = file.split("@");
            file = d[0];
            app = d[1];
        }
        var agent = new apnagent.Agent();
        agent.set('pfx file', file);
        agent.enable(file.indexOf("production") > -1 ? 'production' : 'sandbox');
        agent.on('message:error', function(err, msg) { logger[err && err.code != 10 && err.code != 8 ? "error" : "log"]('apn:message:', err.stack) });
        agent.on('gateway:error', function(err) { logger[err && err.code != 10 && err.code != 8 ? "error" : "log"]('apn:gateway:', err.stack) });
        agent.on('gateway:close', function(err) { logger.info('apn: closed') });
        agent.connect(function(err) { logger[err ? "error" : "log"]('apn:', err || "connected"); });
        agent.decoder.on("error", function(err) { logger.error('apn:decoder:', err.stack); });

        // A posible workaround for the queue being stuck and not sending anything
        agent._timeout = setInterval(function() { agent.queue.process() }, 3000);
        agent._sent = 0;
        logger.debug("initAPN:", agent.settings);

        agent.feedback = new apnagent.Feedback();
        agent.feedback.set('interval', '1h');
        agent.feedback.set('pfx file', file);
        agent.feedback.connect(function(err) { if (err) logger.error('apn: feedback:', err);  });
        agent.feedback.use(function(device, timestamp, next) {
            logger.log('apn: feedback:', device, timestamp);
            next();
        });
        this.apnAgents[app] = agent;
    }
}

// Close APN agent, try to send all pending messages before closing the gateway connection
msg.closeAPN = function(callback)
{
    var self = this;
    lib.forEachSeries(Object.keys(this.apnAgents), function(key, next) {
        var agent = self.apnAgents[key];
        delete self.apnAgents[key];
        logger.info('closeAPN:', key, agent.settings, 'connected:', agent.connected, 'queue:', agent.queue.length, 'sent:', agent._sent);
        clearInterval(agent._timeout);
        agent.close(function() {
            agent.feedback.close();
            agent.feedback = null;
            logger.info('closeAPN: done', key);
            next();
        });
    }, callback);
}

// Send push notification to an Apple device, returns true if the message has been queued.
//
// The options may contain the following properties:
//  - msg - message text
//  - badge - badge number
//  - type - set type of the packet
//  - id - send id in the user properties
msg.sendAPN = function(device_id, options, callback)
{
    var dev = this.parseDevice(device_id);
    if (!dev.id) return typeof callback == "function" && callback("invalid device:" + device_id);

    // Catch invalid devices before they go into the queue where is it impossible to get the exact source of the error
    try {
        device_id = new Buffer(dev.id, "hex");
    } catch(e) {
        return typeof callback == "function" && callback(e);
    }

    var agent = this.apnAgents[dev.app] || this.apnAgents.default;
    if (!agent) return typeof callback == "function" && callback("APN is not initialized for " + device_id);

    var pkt = agent.createMessage().device(device_id);
    if (options.msg) pkt.alert(options.msg);
    if (options.badge) pkt.badge(options.badge);
    if (options.type) pkt.set("type", options.type);
    if (options.id) pkt.set("id", options.id);
    pkt.send(function(err) { if (!err) agent._sent++; });
    if (typeof callback == "function") process.nextTick(callback);
    return true;
}

// Initialize Google Cloud Messaginh servie to send push notifications to mobile devices
msg.initGCM = function()
{
    var self = this;
    if (!this.gcmKey || !this.gcmKey.length) return;
    for (var i = 0; i < this.gcmKey.length; i++) {
        var key = this.gcmKey[i], app = "default";
        if (key.indexOf("@") > -1) {
            var d = key.split("@");
            key = d[0];
            app = d[1];
        }
        var agent = new gcm.Sender(key);
        agent._sent = 0;
        agent._queue = 0;
        this.gcmAgents[app] = agent;
    }
}

// Close GCM connection, flush the queue
msg.closeGCM = function(callback)
{
    var self = this;
    lib.forEachSeries(Object.keys(this.gcmAgents), function(key, next) {
        var agent = self.gcmAgents[key];
        delete self.gcmAgents[key];
        logger.info('closeGCM:', key, 'queue:', agent._queue, 'sent:', agent._sent);

        var n = 0;
        function check() {
            if (!agent._queue || ++n > 30) {
                logger.info('closeGCM: done', key);
                next();
            } else {
                setTimeout(check, 1000);
            }
        }
        check();
    }, callback);
}

// Send push notification to an Android device, return true if queued.
msg.sendGCM = function(device_id, options, callback)
{
    var self = this;

    var dev = this.parseDevice(device_id);
    if (!dev.id) return typeof callback == "function" && callback("invalid device:" + device_id);

    var agent = this.gcmAgents[dev.app] || this.gcmAgents.default;
    if (!agent) return typeof callback == "function" && callback("GCM is not initialized for " + device_id);

    agent._queue++;
    var pkt = new gcm.Message();
    if (options.msg) pkt.addData('msg', options.msg);
    if (options.id) pkt.addData('id', options.id);
    if (options.type) pkt.addData("type", options.type);
    if (options.badge) pkt.addData('badge', options.badge);
    agent.send(pkt, [dev.id], 2, function() {
        agent._queue--;
        agent._sent++;
        if (typeof callback == "function") process.nextTick(callback);
    });
    return true;
}

// Send push notification to a device using AWS SNS service, device_id must be a valid SNS endpoint ARN.
//
// The options may contain the following properties:
//  - msg - message text
//  - badge - badge number
//  - type - set type of the packet
//  - id - send id in the user properties
msg.sendSNS = function(device_id, options, callback)
{
    var self = this;
    var pkt = {};
    var dev = this.parseDevice(device_id);
    if (!dev.id) return typeof callback == "function" && callback("invalid device:" + device_id);

    // Format according to the rules per platform
    if (dev.id.match("/APNS/")) {
        if (options.msg) pkt.alert = options.msg;
        ["id","type","badge"].forEach(function(x) { if (options[x]) pkt[x] = options[x]; });
        pkt = { APNS: JSON.stringify({ aps: pkt }) };
    } else
    if (dev.id.match("/GCM/")) {
        if (options.msg) pkt.message = options.msg;
        ["id","type","badge"].forEach(function(x) { if (options[x]) pkt[x] = options[x]; });
        pkt = { GCM: JSON.stringify({ data: pkt }) };
    }
    aws.snsPublish(dev.id, pkt, function(err) {
        if (typeof callback == "function") callback(err);
    });
    return true;
}
