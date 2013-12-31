//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var path = require('path');
var util = require('util');
var fs = require('fs');
var http = require('http');
var url = require('url');
var crypto = require('crypto');
var async = require('async');
var express = require('express');
var domain = require('domain');
var core = require(__dirname + '/core');
var printf = require('printf');
var logger = require(__dirname + '/logger');
var backend = require(__dirname + '/backend');

// HTTP API to the server from the clients
var api = {

    // No authentication for these urls
    allow: /(^\/$|[a-zA-Z0-9\.-]+\.(gif|png|jpg|js|ico|css|html)$|(^\/public\/)|(^\/images\/)|(^\/image\/[a-z]+\/|^\/account\/add))/,

    // Refuse access to these urls
    deny: null,
    
    // Where images are kept
    imagesUrl: '',
    imagesS3: '',
    
    tables: { 
        // Authentication by email and secret
        auth: [ { name: 'email', primary: 1 },
                { name: 'id', unique: 1 },
                { name: 'secret' },
                { name: 'api_deny' },
                { name: 'api_allow' },
                { name: 'account_allow' },                        // list of public columns
                { name: "expires", type: "int" },
                { name: "mtime", type: "int" } ],
                 
        // Basic account information
        account: [ { name: "id", primary: 1, pub: 1 },
                   { name: "email", unique: 1 },
                   { name: "name" },
                   { name: "alias", pub: 1 },
                   { name: "status", pub: 1 },
                   { name: "phone" },
                   { name: "website" },
                   { name: "birthday", semipub: 1 },
                   { name: "gender", pub: 1 },
                   { name: "icons" },
                   { name: "address" },
                   { name: "city" },
                   { name: "state" },
                   { name: "zipcode" },
                   { name: "country" },
                   { name: "latitude", type: "real" },
                   { name: "longitude", type: " real" },
                   { name: "location" },
                   { name: "ltime", type: "int" },
                   { name: "ctime", type: "int" },
                   { name: "mtime", type: "int" } ],
                   
       // Locations for all accounts to support distance searches
       location: [ { name: "hash", primary: 1 },                     // geohash(first part), the biggest radius expected
                   { name: "range", primary: 1 },                    // geohash(second part), the rest of the geohash
                   { name: "id" },
                   { name: "latitude", type: "real" },
                   { name: "longitude", type: "real" },
                   { name: "mtime", type: "int" }],

       // All connections between accounts: like,dislike,friend...
       connection: [ { name: "id", primary: 1 },                    // account_id
                     { name: "type", primary: 1 },                  // type:connection_id
                     { name: "state" },
                     { name: "mtime", type: "int" }],
                   
       // References from other accounts, likes,dislikes...
       reference: [ { name: "id", primary: 1 },                    // connection_id
                    { name: "type", primary: 1 },                  // type:account_id
                    { name: "state" },
                    { name: "mtime", type: "int" }],
                     
       // All accumulated counters for accounts
       counter: [ { name: "id", primary: 1 },                                         // account_id
                  { name: "like", type: "int", value: 0, pub: 1, incr: 1 },           // who i liked
                  { name: "r_like", type: "int", value: 0, pub: 1 },                  // reversed like, who liked me
                  { name: "dislike", type: "int", value: 0, pub: 1, incr: 1 },
                  { name: "r_dislike", type: "int", value: 0, pub: 1 },
                  { name: "follow", type: "int", value: 0, pub: 1, incr: 1 },
                  { name: "r_follow", type: "int", value: 0, pub: 1 },
                  { name: "mtime", type: "int" }],
                                  
       // Keep historic data about an account, data can be JSON depending on the type
       history: [{ name: "id", primary: 1 },
                 { name: "mtime", type: "int", primary: 1 },
                 { name: "type" } ]
    },
    
    // Upload limit, bytes
    uploadLimit: 10*1024*1024,
    
    // Minimal distance in km between updates of account location, this is to avoid 
    // too many location updates with very high resolution is not required
    minDistance: 5,
    // Max distance in km for location searches
    maxDistance: 50, 
    
    // Geohash ranges for different lenghts in km
    geoRange: [ [8, 0.019], [7, 0.076], [6, 0.61], [5, 2.4], [4, 20], [3, 78], [2, 630], [1, 2500], [1, 99999]],
    
    // Config parameters
    args: [{ name: "images-url", descr: "URL where images are stored, for cases of central image server(s)" },
           { name: "images-s3", descr: "S3 bucket name where to image store instead of data/images directory on the filesystem" },
           { name: "access-log", descr: "File for access logging" },
           { name: "min-distance", type: "int", descr: "Min distance for location updates, if smaller updates will be ignored"  },
           { name: "max-distance", type: "int", max: 40000, min: 1, descr: "Max distance for locations searches"  },
           { name: "allow", type: "regexp", descr: "Regexp for URLs that dont need credentials" },
           { name: "deny", type: "regexp", descr: "Regexp for URLs that will be denied access"  },
           { name: "upload-limit", type: "number", min: 1024*1024, max: 1024*1024*10, descr: "Max size for uploads, bytes"  }],

    // Cutomization hooks/callbacks, always run within api context
    onInit: function() {},
           
    // Initialize API layer with the active HTTP server
    init: function(callback) {
        var self = this;

        // Access log via file or syslog
        if (logger.syslog) {
            this.accesslog = new stream.Stream();
            this.accesslog.writable = true;
            this.accesslog.write = function(data) { logger.printSyslog('info:local5', data); return true; }
        } else
        if (this.accessLog) {
            this.accesslog = fs.createWriteStream(path.join(core.path.log, this.accessLog), { flags: 'a' });
            this.accesslog.on('error', function(err) { logger.error('accesslog:', err); })
        } else {
            this.accesslog = logger;
        }

        this.app = express();
        // Wrap all calls in domain to catch exceptions
        this.app.use(function(req, res, next) {
            var d = domain.create();
            d.add(req);
            d.add(res);
            d.on('error', function(err) { req.next(err); });
            d.run(next);
        });
        this.app.use(express.bodyParser({ uploadDir: core.path.tmp, keepExtensions: true, limit: self.uploadLimit }));
        this.app.use(express.methodOverride());
        this.app.use(express.cookieParser());
        this.app.use(function(req, res, next) {
            res.header('Server', core.name + '/' + core.version);
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'v-signature');
            next();
        });
        this.app.use(this.accessLogger());
        this.app.use(function(req, res, next) { return self.checkRequest(req, res, next); });
        this.app.use(express.static(path.resolve(core.path.web)));
        this.app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
        this.app.listen(core.port, core.bind, function(err) {
            if (err) logger.error('startExpress:', core.port, err);
        });

        // Return images by prefix, id and possibly type, serves from local images folder, 
        // this is generic access without authentication, depends on self.allow regexp
        this.app.all(/^\/image\/([a-z]+)\/([a-z0-9-]+)\/?([0-9])?/, function(req, res) {
            self.getIcon(req, res, req.params[1], { prefix: req.params[0], type: req.params[2] });
        });

        // Direct access to the images by exact file name
        this.app.all(/^\/images\/(.+)/, function(req, res) {
            self.sendFile(req, res, path.join(core.path.images, req.params[0].replace(/\.\./g, "")));
        });
        
        // Managing accounts, basic functionality
        this.initAccountAPI();
        this.initConnectionAPI();
        this.initLocationAPI();
        this.initHistoryAPI();
        this.initCounterAPI();
        this.initIconAPI();

        // Provisioning access to the database
        this.initBackendAPI();

        // Post init or other application routes
        this.onInit.call(this);

        // Create account tables if dont exist
        core.context.db.initTables({ tables: self.tables }, callback);
        if (self.accountPool) core.context.db.initTables({ tables: self.tables }, callback);
        if (self.historyPool) core.context.db.initTables({ tables: self.tables }, callback);
    },
        
    // Perform authorization of the incoming request for access and permissions
    checkRequest: function(req, res, next) {
        var self = this;
        self.checkAccess(req, function(rc1) {
            // Status is given, return an error or proceed to the next module
            if (rc1) return (rc1.status == 200 ? next() : res.json(rc1));

            // Verify account access for signature
            self.checkSignature(req, function(rc2) {
                res.header("cache-control", "no-cache");
                res.header("pragma", "no-cache");
                // The account is verified, proceed with the request
                if (rc2.status == 200) return next();
                // Something is wrong, return an error
                res.json(rc2.status, rc2);
            });
        });
    },

    // Perform URL based access checks
    // Check access permissions, calls the callback with the following argument:
    // - nothing if checkSignature needs to be called
    // - an object with status: 200 to skip authorization and proceed with the next module
    // - an object with status other than 200 to return the status and stop request processing
    checkAccess: function(req, callback) {
        if (this.deny && req.path.match(this.deny)) return callback({ status: 401, message: "Access denied" });
        if (this.allow && req.path.match(this.allow)) return callback({ status: 200, message: "" });
        callback();
    },

    // Verify request signature from the request object, uses properties: .host, .method, .url or .originalUrl, .headers
    checkSignature: function(req, callback) {
        // Make sure we will not crash on wrong object
        if (!req || !req.headers) req = { headers: {} };
        if (!callback) callback = function(x) { return x; }

        // Extract all signatuee components from the request
        var sig = core.parseSignature(req);
        
        // Show request in the log on demand for diagnostics
        if (logger.level >= 1 || req.query._debug) {
            logger.log('checkSignature:', sig, 'hdrs:', req.headers);
        }

        // Sanity checks, required headers must be present and not empty
        if (!sig.method || !sig.host || !sig.expires || !sig.id || !sig.signature) {
            return callback({ status: 401, message: "Invalid request: " + (!sig.method ? "no method" :
                                                                           !sig.host ? "no host" :
                                                                           !sig.id ? "no email" :
                                                                           !sig.expires ? "no expires" :
                                                                           !sig.signature ? "no signature" : "") });
        }

        // Make sure it is not expired, it may be milliseconds or ISO date
        if (sig.expires <= Date.now()) {
            return callback({ status: 400, message: "Expired request" });
        }

        // Verify if the access key is valid, they all are cached so a bad cache may result in rejects
        core.context.db.getCached("auth", { email: sig.id }, function(err, account) {
            if (err) return callback({ status: 500, message: String(err) });
            if (!account) return callback({ status: 404, message: "No account" });

            // Account expiration time
            if (account.expires && account.expires < Date.now()) {
                return callback({ status: 404, message: "Expired account" });
            }

            // Verify ACL regex if specified, test the whole query string as it appear in GET query line
            if (account.api_deny && sig.url.match(account.api_deny)) {
                return callback({ status: 401, message: "Access denied" });
            }
            if (account.api_allow && !sig.url.match(account.api_allow)) {
                return callback({ status: 401, message: "Not permitted" });
            }

            // Verify the signature with account secret
            if (!core.checkSignature(sig, account)) {
                return callback({ status: 401, message: "Bad signature, signed string is: " + sig.str + ", calculated signature is " + sig.hash });
            }

            // Deal with encrypted body, we have to decrypt it before checking checksum, use
            // out account secret to decrypt
            if (req.body && req.get("content-encoding") == "encrypted") {
                req.body = core.decrypt(account.secret, req.body);
            }

            // Check body checksum now
            if (sig.checksum) {
                var chk = core.hash(typeof req.body == "object" ? JSON.stringify(req.body) : String(req.body));
                if (sig.checksum != chk) {
                    return callback({ status: 401, message: "Bad checksum, calculated checksum is " + chk });
                }
            }
            // Save components of signature verification, it will be used later for profile password check as well
            req.signature = sig;
            // Save current account in the request
            req.account = account;
            return callback({ status: 200, message: "Ok" });
        });
    },

    // Account management
    initAccountAPI: function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;
        
        this.app.all(/^\/account\/([a-z]+)$/, function(req, res) {
            logger.debug(req.path, req.account.id, req.query);
            
            switch (req.params[0]) {
            case "get":
                db.get("account", { id: req.account.id }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    if (!rows.length) return self.sendReply(res, 404);
                    res.json(self.prepareAccount(rows[0]));
                });
                break;

            case "list":
                if (!req.query.id) return self.sendReply(res, 400, "id is required");
                self.listAccounts(req, req.query, { select: req.query._select }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    res.json(rows);
                });
                break;
                
            case "search":
                // Search is limited to specific columns only
                db.select("account", req.query, { select: req.query._select }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    rows.forEach(function(row) {
                        self.prepareAccount(row);
                        db.publicPrepare('account', rows[0], { columns: self.tables.account, allowed: req.account.account_allow });
                    });
                    res.json(rows);
                });
                break;
                
            case "add":
                // Verify required fields
                if (!req.query.secret) return self.sendReply(res, 400, "secret is required");
                if (!req.query.name) return self.sendReply(res, 400, "name is required");
                if (!req.query.email) return self.sendReply(res, 400, "email is required");
                req.query.id = backend.uuid().replace(/-/g, '');
                req.query.mtime = req.query.ctime = now;
                // Add new auth record with only columns we support, noSQL db can add any columns on
                // the fly and we want to keep auth table very small
                db.add("auth", req.query, { columns: db.convertColumns(self.tables.auth) }, function(err) {
                    if (err) return self.sendReply(res, err);
                    ["secret","icons","ctime","ltime","latitude","longitude","location"].forEach(function(x) { delete req.query[x] });
                    db.add("account", req.query, function(err) {
                        if (err) {
                            db.del("auth", req.query);
                            return self.sendReply(res, err);
                        }
                        // Even if it fails here it will be created on first usage
                        db.add("counter", { id: req.query.id, mtime: now });
                        res.json(self.prepareAccount(req.query));
                    });
                });
                break;

            case "update":
                req.query.mtime = now;
                req.query.id = req.account.id;
                req.query.email = req.account.email;
                // Make sure we dont add extra properties in case of noSQL database or update columns we do not support here
                ["secret","icons","ctime","ltime","latitude","longitude","location"].forEach(function(x) { delete req.query[x] });
                db.update("account", req.query, { columns: db.convertColumns(self.tables.account) }, function(err) {
                    if (err) return self.sendReply(res, err);
                    res.json(self.prepareAccount(req.query));
                });
                break;

            case "del":
                db.del("auth", { email: req.account.email }, { cached: 1 }, function(err) {
                    self.sendReply(res, err);
                    if (err) return;
                    db.del("account", { id: req.account.id });
                });
                break;
                
            case "secret":
                if (!req.query.secret) return self.sendReply(res, 400, "secret is required");
                db.put("auth", { email: req.account.email, secret: req.query.secret }, { cached: 1 }, function(err) {
                    self.sendReply(res, err);
                    if (err) return;
                    // Keep history of all changes
                    if (req.query._history) {
                        db.add("history", { id: req.account.id, type: req.params[0], mtime: now, secret: core.sign(req.account.id, req.query.secret) });
                    }
                });
                break;
            }
        });
    },
    
    // Connections management
    initIconAPI: function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;
            
        this.app.all(/^\/icon\/([a-z]+)$/, function(req, res) {
            logger.debug(req.path, req.account.id, req.query);
                
            switch (req.params[0]) {
            case "get":
                self.getIcon(req, res, req.account.id, { prefix: 'account', type: req.query.type });
                break;
                
            case "del":
            case "put":
                // Add icon to the account, support any number of additonal icons using req.query.type, any letter or digit
                // The type can be the whole url of the icon, we need to parse it and extract only type
                var type = self.getIconType(req.account.id, req.body.type || req.query.type);
                self[req.params[0] + 'Icon'](req, req.account.id, { prefix: 'account', type: type }, function(err) {
                    if (err) return self.sendReply(res, err);
                    
                    // Get current account icons
                    db.get("account", { id: req.account.id }, { select: 'id,icons' }, function(err, rows) {
                        if (err) return self.sendReply(res, err);
                        
                        // Add/remove given type from the list of icons
                        rows[0].icons = core.strSplitUnique((rows[0].icons || '') + "," + type);
                        if (req.params[0] == 'del') rows[0].icons = rows[0].icons.filter(function(x) { return x != type } );
                            
                        var obj = { id: req.account.id, email: req.account.email, mtime: now, icons: rows[0].icons };
                        db.update("account", obj, function(err) {
                            if (err) return self.sendReply(res, err);
                            res.json(self.prepareAccount(rows[0]));
                        });
                    });
                });
                break;
            }
        });
    },
        
    // Connections management
    initHistoryAPI: function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;

        this.app.all(/^\/history\/([a-z]+)$/, function(req, res) {
            logger.debug('history:', req.params[0], req.account, req.query);

            switch (req.params[0]) {
            case "add":
                self.sendReply(res);
                req.query.id = req.account.id;
                req.query.mtime = now();
                db.add("history", req.query);
                break;
                    
            case "get":
                db.select("history", { id: req.account.id, type: req.query.type }, function(err, rows) {
                    res.json(rows);
                });
                break;
            }
        });
    },

    // Counters management
    initCounterAPI: function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;
            
        this.app.all(/^\/counter\/([a-z]+)$/, function(req, res) {
            logger.debug(req.path, req.account.id, req.query);
            
            switch (req.params[0]) {
            case "add":
            case "put":
            case "incr":
                self.sendReply(res);
                req.query.mtime = now();
                req.query.id = req.account.id;
                db[req.params[0]]("counter", req.query, { cached: 1 });
                break;
                
            case "get":
                db.getCached("counter", { id: req.query.id }, function(err, rows) {
                    db.publicPrepare('counter', rows[0], { columns: self.tables.counter });
                    res.json(rows[0]);
                });
                break;
                
            default:
                self.sendReply(res, 400, "Invalid operation");
            }
        });
    },

    // Connections management
    initConnectionAPI : function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;
        
        this.app.all(/^\/connection\/([a-z]+)$/, function(req, res) {
            logger.debug(req.path, req.account.id, req.query);
            
            switch (req.params[0]) {
            case "add":
            case "put":
            case "update":
                var id = req.query.id, type = req.query.type;
                if (!id || !type) return self.sendReply(res, 400, "id and type are required");
                if (id == req.account.id) return self.sendReply(res, 400, "cannot connect to itself");
                // Override primary key properties, the rest of the properties will be added as is
                req.query.id = req.account.id;
                req.query.type = type + ":" + id;
                req.query.mtime = now;
                db[req.params[0]]("connection", req.query, function(err) {
                    if (err) return self.sendReply(res, err);
                    // Reverse reference to the same connection
                    req.query.id = id;
                    req.query.type = type + ":"+ req.account.id;
                    db[req.params[0]]("reference", req.query, function(err) {
                        if (err) db.del("connection", { id: req.account.id, type: type + ":" + id });
                        self.sendReply(res, err);
                    });
                });
                
                // Update history on connections update
                if (req.query._history) {
                    db.add("history", { id: req.account.id, type: req.path, mtime: now, cid: id, ctype: type });
                }

                // Update accumulated counter if we support this column and do it automatically
                if (req.params[0] != 'add') break;
                var col =  self.tables.counter[req.query.type];
                if (col && col.incr) {
                    db.incr("counter", core.newObj('id', req.account.id, 'mtime', now, type, 1, 'r_' + type, 1), { cached: 1 });
                    db.incr("counter", core.newObj('id', req.query.id, 'mtime', now, type, 1, 'r_' + type, 1), { cached: 1 });
                }
                break;

            case "del":
                var id = req.query.id, type = req.query.type;
                if (!id || !type) return self.sendReply(res, 400, "id and type are required");
                db.del("connection", { id: req.account.id, type: type + ":" + id }, function(err) {
                    if (err) return self.sendReply(res, err);
                    db.del("reference", { id: id, type: type + ":" + req.account.id }, function(err) {
                        self.sendReply(res, err);
                    });
                });
                
                // Update history on connections update
                if (req.query._history) {
                    db.add("history", { id: req.account.id, type: req.path, mtime: now, cid: id, ctype: type });
                }
                
                // Update accumulated counter if we support this column and do it automatically
                var col =  self.tables.counter[req.query.type];
                if (col && col.incr) {
                    db.incr("counter", core.newObj('id', req.account.id, 'mtime', now, type, -1, 'r_' + type, -1), { cached: 1 });
                    db.incr("counter", core.newObj('id', req.query.id, 'mtime', now, type, -1, 'r_' + type, -1), { cached: 1 });
                }
                break;

            case "list":
            case "reference":
                var table = req.params[0] == "list" ? "connection" : "reference";
                // Only one connection record to be returned if id and type specified
                if (req.query.id && req.query.type) req.query.type += ":" + req.query.id;
                db.select(table, { id: req.account.id, type: req.query.type }, { ops: { type: "begins_with" }, select: req.query._select }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    // Collect account ids
                    rows = rows.map(function(row) { return row.type.split(":")[1]; });
                    if (!req.query._details) return res.json(rows);
                    
                    // Get all account records for the id list
                    self.listAccounts(req, rows, { select: req.query._select }, function(err, rows) {
                        if (err) return self.sendReply(res, err);
                        res.json(rows);
                    });
                });
                break;
            }
        });
        
    },
    
    // Geo locations management
    initLocationAPI: function() {
        var self = this;
        var now = core.now();
        var db = core.context.db;
        
        this.app.all(/^\/location\/([a-z]+)$/, function(req, res) {
            logger.debug(req.path, req.account.id, req.query);
            
            switch (req.params[0]) {
            case "put":
                var latitude = req.query.latitude, longitude = req.query.longitude;
                if (!latitude || !longitude) return self.sendReply(res, 400, "latitude/longitude are required");
                // Get current location
                db.get("account", { id: req.account.id }, { select: 'latitude,longitude' }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    var row = rows[0];
                    // Skip if within minimal distance
                    var distance = backend.geoDistance(row.latitude, row.longitude, latitude, longitude);
                    logger.debug(req.params[0], req.account, req.query, 'distance:', distance);
                    if (distance < self.minDistance) return self.sendReply(res, 305, "ignored, min distance: " + self.minDistance);
                    
                    var obj = { id: req.account.id, email: req.account.email, mtime: now, ltime: now, latitude: latitude, longitude: longitude, location: req.query.location };
                    db.update("account", obj, function(err) {
                        if (err) return self.sendReply(res, err);
                        res.json(self.prepareAccount(obj));
                        
                        // Delete current location
                        var geo = self.prepareGeohash(row.latitude, row.longitude, req.account);
                        geo.id = req.account.id;
                        db.del("location", geo);
                        
                        // Insert new location
                        geo = self.prepareGeohash(latitude, longitude, req.account);
                        geo.mtime = now;
                        geo.id = req.account.id;
                        db.put("location", geo);
                    });
                        
                    // Keep history of all changes
                    if (req.query._history) {
                        db.add("history", { id: req.account.id, type: req.path, mtime: now, lat: obj.latitude, lon: obj.longitude });
                    }
                });
                break;
                
            case "search":
                var latitude = req.query.latitude, longitude = req.query.longitude;
                // Perform location search based on hash key that covers the whole region for our configured max distance
                if (!latitude || !longitude) return self.sendReply(res, 400, "latitude/longitude are required");
                // Limit the distance within our configured range
                req.query.distance = core.toNumber(req.query.distance, 0, self.minDistance, self.minDistance, self.maxDistance);
                // Prepare geo search key
                var geo = self.prepareGeohash(latitude, longitude, req.query);
                // Start comes as full geohash, split it into search hash and range
                var start = req.query._start || "";
                if (start) start = { hash: start.substr(0, geo.hash.length), range: start.substr(geo.hash.length) }
                
                var options = { ReturnConsumedCapacity: 'TOTAL', ops: { range: "begins_with" }, start: start, count: req.query._count || 25 };
                options.filter = function(x) { x.distance = backend.geoDistance(latitude, longitude, x.latitude, x.longitude); return x.distance <= distance; }
                db.select("location", { hash: geo.hash, range: geo.range }, options, function(err, rows, info) {
                    var list = {}, ids = [];
                    rows = rows.map(function(row) { 
                        delete row.hash;
                        delete row.range;
                        ids.push({ id: row.id });
                        list[row.id] = row;
                        return row;
                    });
                    // Return back not just a list with rows but pagination info as well, stop only if last property is empty even if no rows returned
                    var last = info.last_evaluated_key;
                    // Combine last key hash and range into single geohash
                    if (last) last = last.hash + last.range;
                    
                    // Return accounts with locations
                    if (req.query._details) {
                        self.listAccounts(req, ids, { select: req.query._select }, function(err, rows) {
                            if (err) return self.sendReply(res, err);
                            // Keep all connecton properties in separate object
                            rows.forEach(function(row) {
                                row.account = list[row.id];
                            })
                            res.json({ geohash: geo.geohash, start: start, last: last, items: rows });
                        });
                    } else {
                        // Return just locations
                        res.json({ geohash: geo.geohash, start: start, last: last, items: rows });
                    }            
                });
                break;
            }
        });
    },
    
    // Return object with geohash for given coordinates to be used for location search
    // options may contain the follwong properties:
    // - distance - limit the range key by the minimum distance, this will reduce the range key length, 
    //              if not specified the full geohash will be produced
    prepareGeohash: function(latitude, longitude, options) {
        var self = this;
        var hbits = this.geoRange.filter(function(x) { return x[1] > self.maxDistance })[0][0];
        var rbits = (options || {}).distance ? this.geoRange.filter(function(x) { return x[1] > options.distance })[0][0] : 22;
        var geohash = backend.geoHashEncode(latitude, longitude);
        return { hash: geohash.substr(0, hbits), range: geohash.substr(hbits, rbits - hbits), geohash: geohash, latitude: latitude, longitude: longitude };
    },
    
    // Prepare an account record for response, set required fields, icons
    prepareAccount: function(row) {
        if (row.birthday) row.age = Math.floor((Date.now() - core.toDate(row.birthday))/(86400000*365));
        // List all available icons, on icon put, we save icon type in the icons property
        core.strSplitUnique(row.icons).forEach(function(x) {
            row['icon' + x] = self.imagesUrl + '/image/account/' + row.id + '/' + x;
        });
        return row;
    },
    
    // Collect accounts by id or list of ids
    listAccounts: function(req, obj, options, callback) {
        var self = this;
        var pubcols = db.publicColumns('account', { columns: self.tables.account });
        // Provided list of columns must be a subset of public columns
        var cols = obj._select ? core.strSplit(options.select).filter(function(x) { return pubcols.indexOf(x) > -1 }) : pubcols;
        // List of account ids can be provided to retrieve all accounts at once, for DynamoDB it means we may iterate over all 
        // pages in order to get all items until we reach our limit.
        var ids = core.strSplit(obj.id);
        ids = ids.length > 1 ? ids.map(function(x) { return { id: x } }) : { id: ids[0] };
        db.select("account", ids, { select: cols }, function(err, rows) {
            if (err) return callback(err, []);
            rows.forEach(function(row) {
                self.prepareAccount(row);
                db.publicPrepare('account', rows[0], { columns: self.tables.account, allowed: req.account.account_allow });
            });
            callback(null, rows);
        });
    },
    
    // API for internal provisioning, by default supports access to all tables
    initBackendAPI: function() {
        var self = this;
        
        // Return current statistics
        this.app.all("/backend/stats", function(req, res) {
            res.json(db.getPool(self.pool).stats);
        });

        // Load columns into the cache
        this.app.all(/^\/backend\/columns$/, function(req, res) {
            db.cacheColumns({}, function() {
                res.json(db.getPool(self.pool).dbcolumns);
            });
        });

        // Return table columns
        this.app.all(/^\/backend\/columns\/([a-z_0-9]+)$/, function(req, res) {
            res.json(db.getColumns(req.params[0]));
        });

        // Return table keys
        this.app.all(/^\/backend\/keys\/([a-z_0-9]+)$/, function(req, res) {
            res.json(db.getKeys(req.params[0]));
        });

        // Basic operations on a table
        this.app.all(/^\/backend\/(select|get|add|put|update|del|replace)\/([a-z_0-9]+)$/, function(req, res) {
            var dbcols = db.getColumns(req.params[1]);
            if (!dbcols) return res.json([]);
            var options = {};
            // Convert values into actual arrays if separated by pipes
            // Set options from special properties
            for (var p in req.query) {
                if (p[0] != '_' && req.query[p].indexOf("|") > 0) req.query[p] = req.query[p].split("|");
                if (p[0] == '_') options[p.substr(1)] = req.query[p];
            }
            options.pool = self.pool;
            db[req.params[0]](req.params[1], req.query, options, function(err, rows) {
                return self.sendReply(res, err);
            });
        });
        
    },
    
    // Add columns to account tables, makes sense in case of SQL database for extending supported properties and/or adding indexes
    initTables: function(table, columns) {
        var self = this;
        if (!Array.isArray(columns)) return;
        if (!self.tables[table]) self.tables[table] = []; 
        columns.forEach(function(x) {
            if (typeof x == "object" && x.name && !self.tables[table].some(function(y) { return y.name == x.name })) {
                self.tables[table].push(x);
            } 
        });
    },

    // Send formatted reply to API clients, if status is an instance of Error then error message with status 500 is sent back
    sendReply: function(res, status, msg) {
        if (status instanceof Error) msg = status, status = 500;
        if (!status) status = 200, msg = "";
        res.json(status, { status: status, message: String(msg || "").replace(/SQLITE_CONSTRAINT:/g, '') });
        return false;
    },

    // Send file back to the client, res is Express response object
    sendFile: function(req, res, file, redirect) {
        fs.exists(file, function(yes) {
            if (req.method == 'HEAD') return res.send(yes ? 200 : 404);
            if (yes) return res.sendfile(file);
            if (redirect) return res.redirect(redirect);
            res.send(404);
        });
    },

    // Return type of the icon, this can be type itself or full icon url
    getIconType: function(id, type) {
        var d = (type || "").match(/\/image\/account\/([a-z0-9-]+)\/?(([0-9])$|([0-9])\?)?/);
        return d && d[1] == id ? (d[3] || d[4]) : "0";
    },
    
    // Return icon to the client
    getIcon: function(req, res, id, options) {
        var self = this;
        
        var icon = core.iconPath(id, options);
        if (this.imagesS3) {
            var aws = core.context.aws;
            aws.queryS3(this.imagesS3, icon, options, function(err, params) {
                if (err) return self.sendReply(res, err);
                res.type("image/" + (options.ext || "jpeg")); 
                res.send(200, params.data);
            });
        } else {
            this.sendFile(req, res, icon);
        }
    },
    
    // Store an icon for account, .type defines icon prefix
    putIcon: function(req, id, options, callback) {
        var self = this;
        // Multipart upload can provide more than one icon, file name can be accompanied by file_type property
        // to define type for each icon
        if (req.files) {
            async.forEachSeries(Object.keys(req.files), function(f, next) {
                var opts = core.extendObj(options, 'type', req.body[f + '_type']);
                if (self.imagesS3) {
                    self.putIconS3(req.files[f].path, id, opts, next);
                } else {
                    core.putIcon(req.files[f].path, id, opts, next);
                }
            }, function(err) {
                callback(err);
            });
        } else 
        // JSON object submitted with .icon property
        if (typeof req.body == "object") {
            req.body = new Buffer(req.body.icon, "base64");
            if (self.imagesS3) {
                self.putIconS3(req.body, id, options, callback);
            } else {
                core.putIcon(req.body, id, options, callback);
            }
        } else {
            return callback(new Error("no icon"));
        }
    },
    
    // Delete an icon for account, .type defines icon prefix
    delIcon: function(req, id, options, callback) {
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};
        
        var icon = core.iconPath(id, options);
        if (this.imagesS3) { 
            var aws = core.context.aws;
            aws.queryS3(this.imagesS3, icon, { method: "DELETE" }, function(err) {
                logger.edebug(err, 'delIcon:', id, options);
                if (callback) callback();
            });
        } else {
            fs.unlink(icon, function(err) {
                logger.edebug(err, 'delIcon:', id, options);
                if (callback) callback();
            });
        }
    },
    
    // Same as putIcon but store the icon in the S3 bucket, icon can be a file or a buffer with image data
    putIconS3: function(file, id, options, callback) {
        var self = this;
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};
        
        var aws = core.context.aws;
        var icon = core.iconPath(id, options);
        core.scaleIcon(file, "", options, function(err, data) {
            if (err) return callback ? callback(err) : null;
            var headers = { 'content-type': 'image/' + (options.ext || "jpeg") };
            aws.queryS3(self.imagesS3, icon, { method: "PUT", postdata: data, headers: headers }, function(err) {
                if (callback) callback(err);
            });
        });
    },
    
    // Custom access logger
    accessLogger: function() {
        var self = this;

        var format = function(req, res) {
            var now = new Date();
            return (req.ip || (req.socket.socket ? req.socket.socket.remoteAddress : "-")) + " - " +
                   (logger.syslog ? "-" : '[' +  now.toUTCString() + ']') + " " +
                   req.method + " " +
                   (req.originalUrl || req.url) + " " +
                   "HTTP/" + req.httpVersionMajor + '.' + req.httpVersionMinor + " " +
                   res.statusCode + " " +
                   ((res._headers || {})["content-length"] || '-') + " - " +
                   (now - req._startTime) + " ms - " +
                   (req.headers['user-agent'] || "-") + " " +
                   (req.headers['version'] || "-") + " " +
                   (req.account ? req.account.email : "-") + "\n";
        }

        return function logger(req, res, next) {
            req._startTime = new Date;
            res._end = res.end;
            res.end = function(chunk, encoding) {
                res._end(chunk, encoding);
                if (!self.accesslog || req._skipAccessLog) return;
                var line = format(req, res);
                if (!line) return;
                self.accesslog.write(line);
            }
            next();
        }
    },

};

module.exports = api;
core.addContext('api', api);
