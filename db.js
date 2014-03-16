//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var util = require('util');
var url = require('url');
var net = require('net');
var fs = require('fs');
var path = require('path');
var backend = require(__dirname + '/build/backend');
var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var aws = require(__dirname + '/aws');
var cluster = require('cluster');
var printf = require('printf');
var gpool = require('generic-pool');
var async = require('async');
var os = require('os');
var helenus = require('helenus');
var metrics = require(__dirname + "/metrics");

// The Database API, a thin abstraction layer on top of SQLite, PostgreSQL, DynamoDB and Cassandra.
// The idea is not to introduce new abstraction layer on top of all databases but to make
// the API usable for common use cases. On the source code level access to all databases will be possible using
// this API but any specific usage like SQL queries syntax or data types available only for some databases will not be
// unified or automatically converted but passed to the database directly. Only conversion between Javascript types and
// database types is unified to some degree meaning Javascript data type will be converted into the corresponding
// data type supported by any particular database and vice versa.
//
// Basic operations are supported for all database and modelled after NoSQL usage, this means no SQL joins are supported
// by the API, only single table access. SQL joins can be passed as SQL statements directly to the database using low level db.query
// API call, all high level operations like add/put/del perform SQL generation for single table on the fly.

var db = {
    name: 'db',

    // Default database pool for the backend
    pool: 'sqlite',

    // Database connection pools, sqlite default pool is called sqlite, PostgreSQL default pool is pg, DynamoDB is ddb
    dbpool: {},

    // Pools by table name
    tblpool: {},

    // Config parameters
    args: [{ name: "pool", descr: "Default pool to be used for db access without explicit pool specified" },
           { name: "no-pools", type:" bool", descr: "Do not use other db pools except default sqlite" },
           { name: "sqlite-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool" },
           { name: "sqlite-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "sqlite-tables", type: "list", descr: "Sqlite tables, list of tables that belong to this pool only" },
           { name: "pgsql-pool", descr: "PostgreSQL pool access url or options string" },
           { name: "pgsql-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool"  },
           { name: "pgsql-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "pgsql-tables", type: "list", descr: "PostgreSQL tables, list of tables that belong to this pool only" },
           { name: "mysql-pool", descr: "MySQL pool access url in the format: myql://user:pass@host/db" },
           { name: "mysql-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool"  },
           { name: "mysql-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "mysql-tables", type: "list", descr: "PostgreSQL tables, list of tables that belong to this pool only" },
           { name: "dynamodb-pool", descr: "DynamoDB endpoint url" },
           { name: "dynamodb-tables", type: "list", descr: "DynamoDB tables, list of tables that belong to this pool only" },
           { name: "cassandra-pool", descr: "Casandra endpoint url" },
           { name: "cassandra-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool"  },
           { name: "cassandra-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "cassandra-tables", type: "list", descr: "DynamoDB tables, list of tables that belong to this pool only" },
    ],

    // Default tables
    tables: {
        bk_property: { name: { primary: 1 },
                       value: {},
                       mtime: { type: "int" }
        },

        bk_cookies: { id: { primary: 1 },
                      name: { index: 1 },
                      domain: {},
                      path: {},
                      value: { type: "text" },
                      expires: { type:" bigint" }
        },

        bk_queue: { id: { primary: 1 },
                    url: {},
                    postdata: { type: "text" },
                    counter: { type: 'int' },
                    mtime: { type: "int" }
        },

        bk_jobs: { id: { primary: 1 },
                   tag: { primary: 1 },
                   type: { value: "local" },
                   job: { type: "json" },
                   cron: {},
                   args: {},
                   mtime: { type: 'int'}
        },
    }, // tables
};

module.exports = db;

// Initialize database pools
db.init = function(callback)
{
	var self = this;

	if (!this.nopool) this.nopool = this.createPool("none");

	// Internal Sqlite database is always open
	self.sqliteInitPool({ pool: 'sqlite', db: core.name, readonly: false, max: self.sqliteMax, idle: self.sqliteIdle });
	(self['sqliteTables'] || []).forEach(function(y) { self.tblpool[y] = 'sqlite'; });

	// Optional pools for supported databases
	if (!self.noPools) {
	    self.args.filter(function(x) { return x.name.match(/\-pool$/) }).map(function(x) { return x.name.replace('-pool', '') }).forEach(function(pool) {
			if (!self[pool + 'Pool']) return;
			self[pool + 'InitPool']({ pool: pool, db: self[pool + 'Pool'], max: self[pool + 'Max'], idle: self[pool + 'Idle'] });
                (self[pool + 'Tables'] || []).forEach(function(y) { self.tblpool[y] = pool; });
	    });
	}

	// Initialize all pools with common tables
	self.initTables(self.tables, callback);
}

// Create tables in all pools
db.initTables = function(tables, callback)
{
	var self = this;
	async.forEachSeries(Object.keys(self.dbpool), function(name, next) {
    	self.initPoolTables(name, tables, next);
	}, function(err) {
        if (callback) callback(err);
    });
}


// Init the pool, create tables and columns:
// - name - db pool to create the tables in
// - tables - an object with list of tables to create or upgrade
db.initPoolTables = function(name, tables, callback)
{
    var self = this;

    logger.debug('initPoolTables:', name, Object.keys(tables));

    // Add tables to the list of all tables this pool supports
    var pool = self.getPool('', { pool: name });
    if (!pool.tables) pool.tables = {};
    // Collect all tables in the pool to be merged with the actual tables later
    for (var p in tables) pool.tables[p] = tables[p];
    var options = { pool: name, tables: tables };
    self.cacheColumns(options, function() {
    	// Workers do not manage tables, only master process
    	if (cluster.isWorker || core.worker) {
    		return callback ? callback() : null;
    	}
        var changes = 0;
        async.forEachSeries(Object.keys(options.tables || {}), function(table, next) {
            // We if have columns, SQL table must be checked for missing columns and indexes
            var cols = self.getColumns(table, options);
            if (!cols || Object.keys(cols).every(function(x) { return cols[x].fake })) {
                self.create(table, options.tables[table], options, function(err, rows) { changes++; next() });
            } else {
                self.upgrade(table, options.tables[table], options, function(err, rows) { if (rows) changes++; next() });
            }
        }, function() {
            logger.debug('db.initPoolTables:', options.pool, 'changes:', changes);
            if (!changes) return callback ? callback() : null;
            self.cacheColumns(options, function() {
            	if (callback) callback();
            });
        });
    });
}

// Remove all registered tables from the pool
db.dropPoolTables = function(name, tables, callback)
{
    var self = this;
    var pool = self.getPool('', { pool: name });
    async.forEachSeries(Object.keys(tables || {}), function(table, next) {
        self.drop(table, { pool: name }, function() { next() });
    }, function() {
        if (callback) callback();
    });
}

// Return all tables know to the given pool, returned tables are in the object with
// column information merged from cached columns from the database with descrpition columns
// given by the application. Property fake: 1 in any column signifies not a real column but
// a column described by the application and not yet c reated by the database driver or could not be added
// due to some error.
db.getPoolTables = function(name)
{
    var pool = this.getPool('', { pool: name });
    return pool.dbcolumns || {};
}

// Create a database pool
// - options - an object defining the pool, the following properties define the pool:
//     - pool - pool name/type, of not specified sqlite is used
//     - max - max number of clients to be allocated in the pool
//     - idle - after how many milliseconds an idle client will be destroyed
// - createcb - a callback to be called when actual database client needs to be created, the callback signature is
//     function(options, callback) and will be called with first arg an error object and second arg is the database instance, required
db.initPool = function(options, createcb)
{
    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "sqlite";

    var pool = gpool.Pool({
        name: options.pool,
        max: options.max || 5,
        idleTimeoutMillis: options.idle || 86400 * 1000,

        create: function(callback) {
            var me = this;
            createcb.call(self, options, function(err, client) {
                if (err) return callback(err, client);
                self.dbpool[me.name].watch(client);
                self.dbpool[me.name].setup(client, callback);
            });
        },
        validate: function(client) {
            return self.dbpool[this.name].serial == client.pool_serial;
        },
        destroy: function(client) {
            logger.log('pool:', 'destroy', client.pool_name, "#", client.pool_serial);
            client.close(function(err) { logger.log("pool: closed", client.pool_name, err || "") });
        },
        log: function(str, level) {
            if (level == 'info') logger.debug('pool:', str);
            if (level == 'warn') logger.log('pool:', str);
            if (level == 'error') logger.error('pool:', str);
        }
    });

    // Translation map for similar operators from different database drivers
    this.createPool(options.pool, pool, { sql: true, dboptions: { schema: [],
                                                                  typesMap: { counter: "int", bigint: "int" },
                                                                  opsMap: { begins_with: 'like%', eq: '=', le: '<=', lt: '<', ge: '>=', gt: '>' } } });

    // Aquire a connection with error reporting
    pool.get = function(callback) {
        this.acquire(function(err, client) {
            if (err) logger.error('pool:', err);
            callback(err, client);
        });
    }
    // Release or destroy a client depending on the database watch counter
    pool.free = function(client) {
        if (this.serial != client.pool_serial) {
            this.destroy(client);
        } else {
            this.release(client);
        }
    }
    // Execute initial statements to setup the environment, like pragmas
    pool.setup = function(client, callback) {
        var init = Array.isArray(options.init) ? options.init : [];
        async.forEachSeries(init, function(sql, next) {
            client.query(sql, next);
        }, function(err) {
            if (err) logger.error('db.setup:', err);
            callback(err, client);
        });
    }
    // Watch for changes or syncs and reopen the database file
    pool.watch = function(client) {
        var me = this;
        if (options.watch && options.file && !this.serial) {
            me.serial = 1;
            fs.watch(options.file, function(event, filename) {
                logger.log('pool:', 'changed', me.name, event, filename, options.file, "#", me.serial);
                me.serial++;
                me.destroyAllNow();
            });
        }
        // Mark the client with the current db pool serial number, if on release this number differs we
        // need to destroy the client, not return to the pool
        client.pool_serial = this.serial;
        client.pool_name = this.name;
        logger.debug('pool:', 'open', this.name, "#", this.serial);
    }
    // Call column caching callback with our pool name
    pool.cacheColumns = function(opts, callback) {
        self.sqlCacheColumns(opts, callback);
    }
    // Prepare for execution, return an object with formatted or transformed query request for the database driver of this pool
    // For SQL databases it creates a SQL statement with parameters
    pool.prepare = function(op, table, obj, opts) {
        return self.sqlPrepare(op, table, obj, opts);
    }
    // Execute a query, run filter if provided.
    // If req.text is an Array then run all queries in sequence
    pool.query = function(client, req, opts, callback) {
        if (!req.values) req.values = [];

        if (!Array.isArray(req.text)) {
            client.query(req.text, req.values, function(err, rows) {
                pool.nextToken(req, rows, opts);
                if (!err && opts && opts.filter) rows = rows.filter(function(row) { return opts.filter(row, opts); });
                callback(err, rows);
            });
        }  else {
            var rows = [];
            async.forEachSeries(req.text, function(text, next) {
                client.query(text, function(err, rc) { if (rc) rows = rc; next(err); });
            }, function(err) {
                pool.nextToken(req, rows, opts);
                if (!err && opts && opts.filter) rows = rows.filter(function(row) { return opts.filter(row, opts); });
                callback(err, rows);
            });
        }
    }
    // Support for pagination, for SQL this is the OFFSET for the next request
    pool.nextToken = function(req, rows, opts) {
        if (opts.count) this.next_token = core.toNumber(opts.start) + core.toNumber(opts.count);
    }
    return pool;
}

// Create a new database pool with default methods and properties
// - pool - if given it is used as the object prototype, the new database pool will extend this object, otherise new object is created
// - options - an object with defaqult pool properties
db.createPool = function(name, pool, options)
{
    if (!pool) pool = {};
    pool.get = function(callback) { callback(null, this); }
    pool.free = function(client) {}
    pool.setup = function(client, callback) { callback(err, client); };
    pool.watch = function(client) {}
    pool.cacheColumns = function(opts, callback) { callback(); };
    pool.cacheIndexes = function(opts, callback) { callback(); };
    pool.prepare = function(op, table, obj, opts) { return { text: table, op: op, table: table, obj: obj }; };
    pool.query = function(client, req, opts, callback) { callback(null, []); };
    pool.nextToken = function(req, rows, opts) {};
    pool.processRow = [];
    pool.name = name;
    pool.serial = 0;
    pool.tables = {};
    pool.dboptions = {},
    pool.dbcolumns = {};
    pool.dbkeys = {};
    pool.dbindexes = {};
    pool.affected_rows = 0;
    pool.inserted_oid = 0;
    pool.next_token = null;
    pool.metrics = new metrics();
    for (var p in options) pool[p] = options[p];
    this.dbpool[name] = pool;
    return pool;
}

// Execute query using native database driver, the query is passed directly to the driver.
// - req - can be a string or an object with the following properties:
// - text - SQL statement or other query in the format of the native driver, can be a list of statements
// - values - parameter values for sql bindings or other driver specific data
// - options may have the following properties:
//     - filter - function to filter rows not to be included in the result, return false to skip row, args are: (row, options)
// Callback is called with the following params:
// - callback(err, rows, info) where
// - info is an object with information about the last query: inserted_oid,affected_rows,next_token
// - rows is always returned as a list, even in case of error it is an empty list
db.query = function(req, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};
    if (core.typeName(req) != "object") req = { text: req };
    if (!req.text) return callback ? callback(new Error("empty statement"), []) : null;

    var pool = this.getPool(req.table, options);

    // Metrics collection
    var m2 = pool.metrics.Timer('process').start();
    pool.metrics.Histogram('queue').update(pool.metrics.Counter('count').inc());
    pool.metrics.Meter('rate').mark();

    pool.get(function(err, client) {
        if (err) {
            m2.end();
            pool.metrics.Counter('count').dec();
            pool.metrics.Counter("errors").inc();
            return callback ? callback(err, []) : null;
        }
        try {
            var t1 = Date.now();
            var m1 = pool.metrics.Timer('response').start();

            pool.query(client, req, options, function(err2, rows) {
                var info = { affected_rows: client.affected_rows, inserted_oid: client.inserted_oid, next_token: client.next_token || pool.next_token };
                pool.free(client);
                m1.end();
                pool.metrics.Counter('count').dec();
                if (err2) {
                    m2.end();
                    pool.metrics.Counter("errors").inc();
                    logger.error("db.query:", pool.name, req.text, req.values, err2, options);
                    return callback ? callback(err2, rows, info) : null;
                }
                // Prepare a record for returning to the client, cleanup all not public columns using table definition or cached table info
                if (options && options.public_columns) {
                    var col = options.public_key || 'id';
                    var cols = self.getPublicColumns(req.table, options);
                    if (cols.length) {
                        rows.forEach(function(row) {
                            if (row[col] == options.public_columns) return;
                            for (var p in row)  if (cols.indexOf(p) == -1) delete row[p];
                        });
                    }
                }
                // Convert values if we have custom column callback
                self.processRows(pool, req.table, rows, options);
                // Cache notification in case of updates, we must have the request prepared by the db.prepare
                if (options && options.cached && req.table && req.obj && req.op && ['add','put','update','incr','del'].indexOf(req.op) > -1) {
                    self.clearCached(req.table, req.obj, options);
                }
                m2.end();
                logger.debug("db.query:", pool.name, (Date.now() - t1), 'ms', rows.length, 'rows', req.text, req.values || "", 'info:', info, 'options:', options);
                if (callback) callback(err, rows, info);
             });
        } catch(err) {
            pool.metrics.Counter("errors").inc();
            logger.error("db.query:", pool.name, req.text, req.values, err, options);
            if (callback) callback(err, [], {});
        }
    });
}

// Insert new object into the database
// - obj - an Javascript object with properties for the record, primary key properties must be supplied
// - options may contain the following properties:
//      - all_columns - do not check for actual columns defined in the pool tables and add all properties from the obj, only will work for NoSQL dbs,
//        by default all properties in the obj not described in the table definition for the given table will be ignored.
//      - skip_columns - ignore properties by name listed in the this array
//      - mtime - if set, mtime column will be added automatically with the current timestamp, if mtime is a
//        string then it is used as a name of the column instead of default mtime name
//      - skip_null - if set, all null values will be skipped, otherwise will be written into the DB as NULLs
db.add = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var req = this.prepare("add", table, obj, options);
    this.query(req, options, callback);
}

// Add/update an object in the database, if object already exists it will be replaced with all new properties from the obj
// - obj - an object with record properties, primary key properties must be specified
// - options - same properties as for `db.add` method
db.put = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);

    // Custom handler for the operation
    var pool = this.getPool(table, options);
    if (pool.put) return pool.put(table, obj, options, callback);

    var req = this.prepare("put", table, obj, options);
    this.query(req, options, callback);
}

// Update existing object in the database.
// - obj - is an actual record to be updated, primary key properties must be specified
// - options - same properties as for `db.add` method with the following additional properties:
//      - keys - list of properties to use as keys for the update condition, if not specified then primary keys will be used
//      - ops - object for comparison operators for primary key, default is equal operator
//      - opsMap - operator mapping into supported by the database
//      - typesMap - type mapping for properties to be used in the condition
db.update = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var req = this.prepare("update", table, obj, options);
    this.query(req, options, callback);
}

// Counter operation, increase or decrease column values, similar to update but all specified columns except primary
// key will be incremented, use negative value to decrease the value.
//
// *Note: The record must exist already for SQL databases, for DynamoDB and Cassandra a new record will be created
// if does not exist yet.*
db.incr = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    options.counter = Object.keys(obj);

    var req = this.prepare("incr", table, obj, options);
    this.query(req, options, callback);
}

// Delete object in the database, no error if the object does not exist
// - obj - an object with primary key properties only, other properties will be ignored
// - options - same propetties as for `db.update` method
db.del = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var req = this.prepare("del", table, obj, options);
    this.query(req, options, callback);
}

// Add/update the object, check existence by the primary key or by other keys specified.
// - obj is a Javascript object with properties that correspond to the table columns
// - options define additional flags that may
//      - keys - is list of column names to be used as primary key when looking for updating the record, if not specified
//        then default primary keys for the table will be used, only keys columns will be used for condition, i.e. WHERE caluse
//      - check_mtime - defines a column name to be used for checking modification time and skip if not modified, must be a date value
//      - check_data - tell to verify every value in the given object with actual value in the database and skip update if the record is the same,
//        if it is an array then check only specified columns
db.replace = function(table, obj, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = {};
    options = this.getOptions(table, options);
    if (!options.keys || !options.keys.length) options.keys = self.getKeys(table, options) || [];

    var select = options.keys[0];
    // Use mtime to check if we need to update this record
    if (options.check_mtime && obj[options.check_mtime]) {
        select = options.check_mtime;
    } else
    // Check if values are different from existing value, skip if the records are the same by comparing every field
    if (options.check_data) {
        var cols = self.getColumns(table, options);
        var list = Array.isArray(options.check_data) ? options.check_data : Object.keys(obj);
        select = list.filter(function(x) { return x[0] != "_"  && x != 'mtime' && options.keys.indexOf(x) == -1 && (x in cols); }).join(',');
        if (!select) select = options.keys[0];
    }

    var req = this.prepare("get", table, obj, { select: select });
    if (!req) {
        if (options.put_only) return callback ? callback(null, []) : null;
        return self.add(table, obj, options, callback);
    }

    // Create deep copy of the object so we have it complete inside the callback
    obj = core.cloneObj(obj);

    self.query(req, function(err, rows) {
        if (err) return callback ? callback(err, []) : null;

        logger.debug('db.replace:', req, rows.length);
        if (rows.length) {
            // Skip update if specified or mtime is less or equal
            if (options.add_only || (select == options.check_mtime && core.toDate(rows[0][options.check_mtime]) >= core.toDate(obj[options.check_mtime]))) {
                return callback ? callback(null, []) : null;
            }
            // Verify all fields by value
            if (options.check_data) {
                var same = select == "1" || Object.keys(rows[0]).every(function(x) { return String(rows[0][x]) == String(obj[x]) });
                // Nothing has changed
                if (same) return callback ? callback(null, []) : null;
            }
            self.update(table, obj, options, callback);
        } else {
            if (options.put_only) return callback ? callback(null, []) : null;
            self.add(table, obj, options, callback);
        }
    });
}

// Select objects from the database that match supplied conditions.
// - obj - can be an object with primary key properties set for the condition, all matching records will be returned
// - obj - can be a list where each item is an object with primary key condition. Only records specified in the list must be returned.
// - options can use the following special properties:
//      - keys - a list of columns for condition or all primary keys will be used for query condition, only keys will be used in WHERE part of the SQL statement
//      - ops - operators to use for comparison for properties, an object with column name and operator
//      - opsMap - operator mapping between supplied operators and actual operators supported by the db
//      - typesMap - type mapping between supplied and actual column types, an object
//      - select - a list of columns or expressions to return or all columns if not specified
//      - start - start records with this primary key, this is the next_token passed by the previous query
//      - count - how many records to return
//      - sort - sort by this column
//      - public_columns - value to be used to filter non-public columns (marked by .pub property), compared to public_key column or 'id'
//      - public_key - name of the column to be used in public columns filtering, default is 'id'
//      - desc - if sorting, do in descending order
//      - page - starting page number for pagination, uses count to find actual record to start
// On return, the callback can check third argument which is an object with the following properties:
// - affected_rows - how many records this operation affected
// - inserted_oid - last created auto generated id
// - next_token - next primary key or offset for pagination by passing it as .start property in the options
db.select = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var req = this.prepare(Array.isArray(obj) ? "list" : "select", table, obj, options);
    this.query(req, options, callback);
}

// Convenient helper to retrieve all records by primary key, the obj must be a list with key property or a string with list of primary key column
db.list = function(table, obj, options, callback)
{
	switch (core.typeName(obj)) {
	case "string":
		var keys = options && options.keys ? options.keys : this.getKeys(table, options);
		if (!keys || !keys.length) return callback ? callback(new Error("invalid keys"), []) : null;
		obj = core.strSplit(obj).map(function(x) { return core.newObj(keys[0], x) });
	case "array":
	case "object":
		break;
	default:
		return callback ? callback(new Error("invalid list"), []) : null;
	}
    this.select(table, obj, options, callback);
}

// Perform full text search on the given table, the database implementation may ignore table name completely
// in case of global text index. Options takes same properties as in the select method. Without full text support
// this works the sme way as the `select` method.
db.search = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var req = this.prepare("search", table, obj, options);
    this.query(req, options, callback);
}

// Geo locations search, paginate all results until the end.
// table must be defined with the following required columns:
//  - geohash and id as strings, this is the primary key
//    split and saved as property id in the record
//  - latitude and longitude as floating numbers
// On first call, options must contain latitude and longitude of the center and optionally distance for the radius. On subsequent call options.start must contain
// the next_token returned by the previous call
// Specific options properties:
//   - calc_distance - calculate the distance between query and the actual position and save it in distance property for each record
// On return, the callback's third argument contains the object that must be provided for subsequent searches until rows array is empty.
db.getLocations = function(table, options, callback)
{
	var latitude = options.latitude, longitude = options.longitude;
    var distance = core.toNumber(options.distance, 0, 2, 1, 999);
    var count = core.toNumber(options.count, 0, 50, 0, 250);
    if (!options.geohash) {
    	var geo = core.geoHash(latitude, longitude, { distance: distance });
    	for (var p in geo) options[p] = geo[p];
    }
    options.start = null;
    options.nrows = count;
    options.sort = "id";
    options.ops = { id: "gt" };
    db.select(table, { geohash: options.geohash, id: options.id || "" }, options, function(err, rows, info) {
    	if (err) return callback ? callback(err, rows, info) : null;
    	count -= rows.length;
        async.until(
            function() { return count <= 0 || options.neighbors.length == 0; },
            function(next) {
                options.id = "";
                options.count = count;
                options.geohash = options.neighbors.shift();
                db.select(table, { geohash: options.geohash, id: options.id }, options, function(err, items, info) {
                    rows.push.apply(rows, items);
                    count -= items.length;
                    next(err);
                });
            }, function(err) {
                if (options.calc_distance) {
                    rows.forEach(function(row) { row.distance = backend.geoDistance(latitude, longitude, row.latitude, row.longitude); });
                }
                // Restore original count because we pass this whole options object on the next run
                options.count = options.nrows;
                // Make the last row our next starting point
                if (rows.length) options.id = rows[rows.length -1].id;
                if (callback) callback(err, rows, options);
            });
    });
}

// Retrieve one record from the database
// Options can use the following special properties:
//  - keys - a list of columns for condition or all primary keys
//  - select - a list of columns or expressions to return or *
//  - op - operators to use for comparison for properties
//  - cached - if specified it runs getCached version
db.get = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    if (options.cached) {
    	options.cached = 0;
    	return this.getCached(table, obj, options, callback);
    }
    var req = this.prepare("get", table, obj, options);
    this.query(req, options, callback);
}

// Retrieve cached result or put a record into the cache prefixed with table:key[:key...]
// Options accept the same parameters as for the usual get action but it is very important that all the options
// be the same for every call, especially `select` parameters which tells which columns to retrieve and cache.
// Additional options:
// - prefix - prefix to be used for the key instead of table name
db.getCached = function(table, obj, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    options = this.getOptions(table, options);
    var pool = this.getPool(table, options);
    var key = this.getCachedKey(table, obj, options);
    core.ipcGetCache(key, function(rc) {
        // Cached value retrieved
        if (rc) {
            pool.metrics.Counter("hits").inc();
            return callback ? callback(null, JSON.parse(rc)) : null;
        }
        pool.metrics.Counter("misses").inc();
        // Retrieve account from the database, use the parameters like in Select function
        self.get(table, obj, options, function(err, rows) {
            // Store in cache if no error
            if (rows.length && !err) {
                core.ipcPutCache(key, core.stringify(rows[0]));
            }
            callback(err, rows.length ? rows[0] : null);
        });
    });

}

// Notify or clear cached record, this is called after del/update operation to clear cached version by primary keys
db.clearCached = function(table, obj, options)
{
    core.ipcDelCache(this.getCachedKey(table, obj, options));
}

db.getCachedKey = function(table, obj, options)
{
    var prefix = options.prefix || table;
    var keys = options.keys || this.getKeys(table, options) || [];
    return prefix + (this.getKeys(table, options) || []).map(function(x) { return ":" + obj[x] });
}

// Create a table using column definitions represented as a list of objects. Each column definiton can
// contain the following properties:
// - name - column name
// - type - column type, one of: int, real, string, counter or other supported type
// - primary - column is part of the primary key
// - unique - column is part of an unique key
// - index - column is part of an index
// - value - default value for the column
// - len - column length
// - pub - columns is public
// - semipub - column is not public but still retrieved to support other public columns, must be deleted after use
// Some properties may be defined multiple times with number suffixes like: unique1, unique2, index1, index2
db.create = function(table, columns, options, callback)
{
    if (typeof options == "function") callback = options,options = {};
    options = this.getOptions(table, options);
    var req = this.prepare("create", table, columns, options);
    this.query(req, options, callback);
}

// Upgrade a table with missing columns from the definition list
db.upgrade = function(table, columns, options, callback)
{
    if (typeof options == "function") callback = options,options = {};
    options = this.getOptions(table, options);
    var req = this.prepare("upgrade", table, columns, options);
    if (!req.text) return callback ? callback() : null;
    this.query(req, options, callback);
}

// Drop a table
db.drop = function(table, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = {};
    options = this.getOptions(table, options);
    var req = this.prepare("drop", table, {}, options);
    if (!req.text) return callback ? callback() : null;
    this.query(req, options, function(err, rows, info) {
        // Clear table cache
        if (!err) {
            var pool = self.getPool(table, options);
            delete pool.dbcolumns[table];
            delete pool.dbkeys[table];
            delete pool.tables[table];
        }
        if (callback) callback(err, rows, info);
    });
}

// Prepare for execution for the given operation: add, del, put, update,...
// Returns prepared object to be passed to the driver's .query method.
db.prepare = function(op, table, obj, options)
{
    // Add curent timestamp
    if (options.mtime) {
        if (typeof options.mtime == "string") obj[options.mtime] = Date.now(); else obj.mtime = Date.now();
    }
    return this.getPool(table, options).prepare(op, table, obj, options);
}

// Return database pool by name or default pool
db.getPool = function(table, options)
{
    return this.dbpool[(options || {})["pool"] || this.tblpool[table] || this.pool] || this.nopool;
}

// Return combined options for the pool including global pool options
db.getOptions = function(table, options)
{
    var pool = this.getPool(table, options);
    return core.mergeObj(pool.dboptions, options);
}

// Return cached columns for a table or null, columns is an object with column names and objects for definiton
db.getColumns = function(table, options)
{
    return this.getPool(table, options).dbcolumns[table.toLowerCase()] || {};
}

// Return the column definitoon for a table
db.getColumn = function(table, name, options)
{
    return this.getColumns(table, options)[name];
}

// Return list of selected or allowed only columns, empty list of no condition given
db.getSelectedColumns = function(table, options)
{
    var self = this;
    var cols = this.getColumns(table, options);
    if (options.select) options.select = core.strSplitUnique(options.select);
    var select = Object.keys(cols).filter(function(x) { return !self.skipColumn(x, "", options, cols); });
    return select.length ? select : null;
}

// Verify column against common options for inclusion/exclusion into the operation, returns 1 if the column must be skipped
db.skipColumn = function(name, val, options, columns)
{
	var rc = !name || name[0] == '_' || typeof val == "undefined" ||
	         (options.skip_null && val === null) ||
	         (!options.all_columns && (!columns || !columns[name])) ||
	         (options.skip_columns && options.skip_columns.indexOf(name) > -1) ||
	         (options.select && options.select.indexOf(name) == -1) ? true : false;
	logger.dev('skipColumn:', name, val, rc);
	return rc;
}

// Return cached primary keys for a table or null
db.getKeys = function(table, options)
{
    return this.getPool(table, options).dbkeys[table.toLowerCase()];
}

// Return possibly converted value to be used for inserting/updating values in the database,
// is used for SQL parametrized statements
// Parameters:
//  - options - standard pool parameters with pool: property for specific pool
//  - val - the Javascript value to convert into bind parameter
//  - info - column definition for the value from the cached columns
db.getBindValue = function(table, options, val, info)
{
    if (options.noJson) {
        if (info && info.type == "json") return JSON.stringify(val);
    }
	var cb = this.getPool(table, options).bindValue;
	return cb ? cb(val, info) : val;
}

// Return transformed value for the column value returned by the database, same parameters as for getBindValue
db.getColumnValue = function(table, options, val, info)
{
	var cb = this.getPool(table, options).colValue;
	return cb ? cb(val, info) : val;
}

// Convert native database error in some generic human readable string
db.convertError = function(table, err, options)
{
    if (!err || !(err instanceof Error)) return err;
    var cb = this.getPool(table, options).convertError;
    return cb ? cb(table, err, options) : err;
}

// Reload all columns into the cache for the pool
db.cacheColumns = function(options, callback)
{
	var self = this;
	if (typeof options == "function") callback = options, options = null;
	if (!options) options = {};

    var pool = this.getPool('', options);
    pool.cacheColumns.call(pool, options, function(err) {
        if (err) logger.error('cacheColumns:', pool.name, err);
    	self.mergeColumns(pool);
    	pool.cacheIndexes.call(pool, options, function(err) {
    	    if (err) logger.error('cacheIndexes:', pool.name, err);
    	    if (callback) callback(err);
    	});
    });
}

// Merge Javascript column definitions with the db cached columns
db.mergeColumns = function(pool)
{
	var tables = pool.tables;
	var dbcolumns = pool.dbcolumns;
    for (var table in tables) {
		for (var col in tables[table]) {
		    if (!dbcolumns[table]) dbcolumns[table] = {};
			if (!dbcolumns[table][col]) {
			    dbcolumns[table][col] = { fake: 1 };
			} else {
			    delete dbcolumns[table][col].fake;
			}
			for (var p in tables[table][col]) {
				if (!dbcolumns[table][col][p]) dbcolumns[table][col][p] = tables[table][col][p];
			}
		}
	}
}

// Columns that are allowed to be visible, used in select to limit number of columns to be returned by a query
//  - pub property means public column
//  - semipub means not allowed but must be returned for calculations in the select to produce another public column
// options may be used to define the following properties:
// - columns - list of public columns to be returned, overrides the public columns in the definition list
db.getPublicColumns = function(table, options)
{
    if (options && Array.isArray(options.columns)) {
        return options.columns.filter(function(x) { return x.pub || x.semipub }).map(function(x) { return x.name });
    }
    var cols = this.getColumns(table, options);
    return Object.keys(cols).filter(function(x) { return cols[x].pub || cols[x].semipub });
}

// Call custom row handler for every row in the result, this assumes that pool.processRow callback has been assigned previously
db.processRows = function(pool, table, rows, options)
{
	if (!pool.processRow.length && !options.noJson) return;

	var cols = pool.dbcolumns[table.toLowerCase()] || {};
	rows.forEach(function(row) {
	    if (options.noJson) {
	        for (var p in cols) {
	            if (cols[p].type == "json" || typeof row[p] == "string") try { row[p] = JSON.parse(row[p]); } catch(e) {}
	        }
	    }
	    if (Array.isArray(pool.processRow)) {
	        pool.processRow.forEach(function(x) { x.call(pool, row, options, cols); });
	    }
	});
}

// Assign processRow callback for a table, this callback will be called for every row on every result being retrieved from the
// specified table thus providing an opportunity to customize the result.
// All assigned callback to tthis table will be called in the order of the assignment.
db.setProcessRow = function(table, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (!table || !callback) return;
    var pool = this.getPool(table, options);
    if (Array.isArray(pool.processRow)) pool.processRow.push(callback);
}

// Cache columns using the information_schema
db.sqlCacheColumns = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    var pool = this.getPool('', options);
    pool.get(function(err, client) {
        if (err) return callback ? callback(err, []) : null;

        // Use current database name for schema if not specified
        if (!pool.dboptions.schema.length) pool.dboptions.schema.push(client.name);
        client.query("SELECT c.table_name,c.column_name,LOWER(c.data_type) AS data_type,c.column_default,c.ordinal_position,c.is_nullable " +
                     "FROM information_schema.columns c,information_schema.tables t " +
                     "WHERE c.table_schema IN (" + self.sqlValueIn(pool.dboptions.schema) + ") AND c.table_name=t.table_name " +
                     "ORDER BY 5", function(err, rows) {
            pool.dbcolumns = {};
            for (var i = 0; i < rows.length; i++) {
                var table = rows[i].table_name.toLowerCase()
                if (!pool.dbcolumns[table]) pool.dbcolumns[table] = {};
                // Split type cast and ignore some functions in default value expressions
                var isserial = false, val = rows[i].column_default ? String(rows[i].column_default).replace(/'/g,"").split("::")[0] : null;
                if (val && val.indexOf("nextval") == 0) val = null, isserial = true;
                if (val && val.indexOf("ARRAY") == 0) val = val.replace("ARRAY", "").replace("[", "{").replace("]", "}");
                var db_type = "";
                switch (rows[i].data_type) {
                case "array":
                case "json":
                    db_type = rows[i].data_type;
                    break;

                case "numeric":
                case "bigint":
                case "real":
                case "integer":
                case "smallint":
                case "double precision":
                    db_type = "number";
                    break;

                case "boolean":
                    db_type = "bool";
                    break;

                case "date":
                case "time":
                case "timestamp with time zone":
                case "timestamp without time zone":
                    db_type = "date";
                    break;
                }
                pool.dbcolumns[table][rows[i].column_name.toLowerCase()] = { id: rows[i].ordinal_position, value: val, db_type: db_type, data_type: rows[i].data_type, isnull: rows[i].is_nullable == "YES", isserial: isserial };
            }
            pool.free(client);
            if (callback) callback(err);
        });
    });
}

// Prepare SQL statement for the given operation
db.sqlPrepare = function(op, table, obj, options)
{
    var pool = this.getPool(table, options);
    var req = null;
    switch (op) {
    case "list":
    case "select":
    case "search":
        req = this.sqlSelect(table, obj, options);
        break;
    case "create":
        req = this.sqlCreate(table, obj, options);
        break;
    case "upgrade":
        req = this.sqlUpgrade(table, obj, options);
        break;
    case "drop":
        req = this.sqlDrop(table, obj, options);
        break;
    case "get":
        req = this.sqlSelect(table, obj, core.extendObj(options, "count", 1));
        break;
    case "add":
        req = this.sqlInsert(table, obj, options);
        break;
    case "put":
        req = this.sqlInsert(table, obj, core.extendObj(options, "replace", !options.noReplace));
        break;
    case "incr":
        req = this.sqlUpdate(table, obj, options);
        break;
    case "update":
        req = this.sqlUpdate(table, obj, options);
        break;
    case "del":
        req = this.sqlDelete(table, obj, options);
        break;
    }
    // Pass original object for custom processing or callbacks
    if (!req) req = {};
    req.table = table;
    req.obj = obj;
    req.op = op;
    return req;
}

// Quote value to be used in SQL expressions
db.sqlQuote = function(val)
{
    return val == null || typeof val == "undefined" ? "NULL" : ("'" + String(val).replace(/'/g,"''") + "'");
}

// Return properly quoted value to be used directly in SQL expressions, format according to the type
db.sqlValue = function(value, type, dflt, min, max)
{
    if (value == "null") return "NULL";
    switch ((type || core.typeName(value))) {
    case "expr":
    case "buffer":
        return value;

    case "real":
    case "float":
    case "double":
        return core.toNumber(value, true, dflt, min, max);

    case "int":
    case "integer":
    case "number":
        return core.toNumber(value, null, dflt, min, max);

    case "bool":
    case "boolean":
        return core.toBool(value);

    case "date":
        return this.sqlQuote((new Date(value)).toISOString());

    case "time":
        return this.sqlQuote((new Date(value)).toLocaleTimeString());

    case "mtime":
        return /^[0-9\.]+$/.test(value) ? this.toNumber(value, null, dflt, min, max) : this.sqlQuote((new Date(value)).toISOString());

    default:
        return this.sqlQuote(value);
    }
}

// Return list in format to be used with SQL IN ()
db.sqlValueIn = function(list, type)
{
    var self = this;
    if (!Array.isArray(list) || !list.length) return '';
    return list.map(function(x) { return self.sqlValue(x, type);}).join(",");
}

// Build SQL expressions for the column and value
// options may contain the following properties:
//  - op - SQL operator, default is =
//  - type - can be data, string, number, float, expr, default is string
//  - value - default value to use if passed value is null or empty
//  - min, max - are used for numeric values for validation of ranges
//  - expr - for op=expr, contains sprintf-like formatted expression to be used as is with all '%s' substituted with actual value
db.sqlExpr = function(name, value, options)
{
    var self = this;
    if (!name || typeof value == "undefined") return "";
    if (!options.type) options.type = "string";
    var sql = "";
    var op = (options.op || "").toLowerCase();
    switch (op) {
    case "not in":
    case "in":
        var list = [];
        // Convert type into array
        switch (core.typeName(value)) {
        case "object":
            for (var p in value) list.push(value[p]);
            break;

        case "array":
            list = value;
            break;

        case "string":
            // For number array allow to be separated by comma as well, either one but not to be mixed
            if ((options.type == "number" || options.type == "int") && value.indexOf(',') > -1) {
                list = value.split(',');
                break;
            } else
            if (value.indexOf('|') > -1) {
                list = value.split('|');
                break;
            }

        default:
            list.push(value);
        }
        if (!list.length) break;
        sql += name + " " + op + " (" + self.sqlValueIn(list, options.type) + ")";
        break;

    case "between":
    case "not between":
        // If we cannot parse out 2 values, treat this as exact operator
        var list = [];
        switch (core.typeName(value)) {
        case "array":
            list = value;
            break;

        case "string":
            // For number array allow to be separated by comma as well, either one but not to be mixed
            if ((options.type == "number" || options.type == "int") && value.indexOf(',') > -1) {
                list = value.split(',');
                break;
            } else
            if (value.indexOf('|') > -1) {
                list = value.split('|');
                break;
            }
        }
        if (list.length > 1) {
            sql += name + " " + op + " " + this.sqlValue(list[0], options.type) + " AND " + this.sqlValue(list[1], options.type);
        } else {
            sql += name + "=" + this.sqlValue(value, options.type, options.value, options.min, options.max);
        }
        break;

    case "null":
    case "not null":
        sql += name + " IS " + op;
        break;

    case '@@':
        switch (core.typeName(value)) {
        case "string":
            if (value.indexOf('|') > -1) {
                value = value.split('|');
            } else {
                sql += name + op + " plainto_tsquery('" + (options.min || "english") + "'," + this.sqlQuote(value) + ")";
                break;
            }

        case "array":
            value = value.map(function(x) { return "plainto_tsquery('" + (options.min || "english") + "'," + self.sqlQuote(x) + ")" }).join('||');
            sql += name + op + " (" +  value + ")";
            break;
        }
        break;

    case '~* any':
    case '!~* any':
        sql += this.sqlQuote(value) + " " + op + "(" + name + ")";
        break;

    case 'like%':
    case "ilike%":
    case "not like%":
    case "not ilike%":
        value += '%';
        op = op.substr(0, op.length-1);

    case '>':
    case '>=':
    case '<':
    case '<=':
    case '<>':
    case '!=':
    case "not like":
    case "like":
    case "ilike":
    case "not ilike":
    case "not similar to":
    case "similar to":
    case "regexp":
    case "not regexp":
    case "~":
    case "~*":
    case "!~":
    case "!~*":
    case 'match':
        sql += name + " " + op + " " + this.sqlValue(value, options.type, options.value, options.min, options.max);
        break;

    case "iregexp":
    case "not iregexp":
        sql += "LOWER(" + name + ") " + (op[0] == 'n' ? "NOT" : "") + " REGEXP " + this.sqlValue(value, options.type, options.value, options.min, options.max);
        break;

    case 'begins_with':
        sql += name + " > " + this.sqlQuote(value.substr(0, value.length-1) + String.fromCharCode(value.charCodeAt(value.length-1) - 1));
        sql += " AND " + name + " < " + this.sqlQuote(value.substr(0, value.length-1) + String.fromCharCode(value.charCodeAt(value.length-1) + 1));
        break;

    case 'expr':
        if (options.expr) {
            var str = options.expr;
            if (value.indexOf('|') > -1) value = value.split('|');
            str = str.replace(/%s/g, this.sqlValue(value, options.type, null, options.min, options.max));
            str = str.replace(/%1/g, this.sqlValue(value[0], options.type, null, options.min, options.max));
            str = str.replace(/%2/g, this.sqlValue(value[1], options.type, null, options.min, options.max));
            sql += str;
        }
        break;

    default:
        sql += name + "=" + this.sqlValue(value, options.type, options.value, options.min, options.max);
        break;
    }
    return sql;
}

// Return time formatted for SQL usage as ISO, if no date specified returns current time
db.sqlTime = function(d)
{
    if (d) {
       try { d = (new Date(d)).toISOString() } catch(ex) { d = '' }
    } else {
        d = (new Date()).toISOString();
    }
    return d;
}

// Given columns definition object, build SQL query using values from the values object, all conditions are joined using AND,
// - columns is a list of objects with the following properties:
//     - name - column name, also this is the key to use in the values object to get value by
//     - col - actual column name to use in the SQL
//     - alias - optional table prefix if multiple tables involved
//     - value - default value
//     - type - type of the value, this is used for proper formatting: boolean, number, float, date, time, string, expr
//     - op - any valid SQL operation: =,>,<, between, like, not like, in, not in, ~*,.....
//     - group - for grouping multiple columns with OR condition, all columns with the same group will be in the same ( .. OR ..)
//     - always - only use default value if true
//     - required - value default or supplied must be in the query, otherwise return empty SQL
//     - search - aditional name for a value, for cases when generic field is used for search but we search specific column
// - values - actual values for the condition as an object, usually req.query
// - params - if given will contain values for binding parameters
db.sqlFilter = function(columns, values, params)
{
    var all = [], groups = {};
    if (!values) values = {};
    if (!params) params = [];
    for (var name in columns) {
        var col = columns[name];
        // Default value for this column
        var value = col.value;
        // Can we use supplied value or use only default one
        if (!col.always) {
            if (values[name]) value = values[name];
            // In addition to exact field name there could be query alias to be used for this column in case of generic search field
            // which should be applied for multiple columns, this is useful to search across multiple columns or use diferent formats
            var search = col.search;
            if (search) {
                if (!Array.isArray(col.search)) search = [ search ];
                for (var j = 0; j < search.length; j++) {
                    if (values[search[j]]) value = values[search[j]];
                }
            }
        }
        if (typeof value =="undefined" || (typeof value == "string" && !value)) {
            // Required filed is missing, return empty query
            if (col.required) return "";
            // Allow empty values excplicitely
            if (!col.empty) continue;
        }
        // Uset actual column name now once we got the value
        if (col.col) name = col.col;
        // Table prefix in case of joins
        if (col.alias) name = col.alias + '.' + name;
        // Wrap into COALESCE
        if (typeof col.coalesce != "undefined") {
            name = "COALESCE(" + name + "," + this.sqlValue(col.coalesce, col.type) + ")";
        }
        var sql = "";
        // Explicit skip of the parameter
        if (col.op == 'skip') {
            continue;
        } else
        // Add binding parameters
        if (col.op == 'bind') {
            sql = col.expr.replace('$#', '$' + (params.length + 1));
            params.push(value);
        } else
        // Special case to handle NULL
        if (col.isnull && (value == "null" || value == "notnull")) {
            sql = name + " IS " + value.replace('null', ' NULL');
        } else {
            // Primary condition for the column
            sql = this.sqlExpr(name, value, col);
        }
        if (!sql) continue;
        // If group specified, that means to combine all expressions inside that group with OR
        if (col.group) {
            if (!groups[col.group]) groups[col.group] = [];
            groups[col.group].push(sql);
        } else {
            all.push(sql);
        }
    }
    var sql = all.join(" AND ");
    for (var p in groups) {
        var g = groups[p].join(" OR ");
        if (!g) continue;
        if (sql) sql += " AND ";
        sql += "(" + g + ")";
    }
    return sql;
}

// Build SQL orderby/limit/offset conditions, config can define defaults for sorting and paging
db.sqlLimit = function(options)
{
    if (!options) options = {};
    var rc = "";

    // Sorting column, multiple nested sort orders
    var orderby = "";
    ["", "1", "2"].forEach(function(x) {
        var sort = options['sort' + x];
        if (!sort) return;
        var desc = core.toBool(options['desc' + x]);
        orderby += (orderby ? "," : "") + sort + (desc ? " DESC" : "");
    });
    if (orderby) rc += " ORDER BY " + orderby;

    // Limit clause
    var page = core.toNumber(options.page, false, 0, 0, 9999);
    var count = core.toNumber(options.count, false, 50, 1, 9999);
    var start = core.toNumber(options.start, false, 0, 0, 9999);
    if (count) {
        rc += " LIMIT " + count;
    }
    if (start) {
        rc += " OFFSET " + start;
    } else
    if (page && count) {
        rc += " OFFSET " + ((page - 1) * count);
    }
    return rc;
}

// Build SQL where condition from the keys and object values, returns SQL statement to be used in WHERE
// - obj - an object record properties
// - keys - a list of primary key columns
// - options may contains the following properties:
//     - pool - pool to be used for driver specific functions
//     - ops - object for comparison operators for primary key, default is equal operator
//     - opsMap - operator mapping into supported by the database
//     - typesMap - type mapping for properties to be used in the condition
db.sqlWhere = function(table, obj, keys, options)
{
    var self = this;
    if (!options) options = {};

    // List of records to return by primary key, when only one primary key property is provided use IN operator otherise combine all conditions with OR
    if (Array.isArray(obj)) {
        if (!obj.length) return "";
        var props = Object.keys(obj[0]);
        if (props.length == 1 && keys.indexOf(props[0]) > -1) {
            return props[0] + " IN (" + this.sqlValueIn(obj.map(function(x) { return x[props[0]] })) + ")";
        }
        return obj.map(function(x) { return "(" + keys.map(function(y) { return y + "=" + self.sqlQuote(self.getBindValue(table, options, x[y])) }).join(" AND ") + ")" }).join(" OR ");
    }
    // Regular object with conditions
    var where = [];
    (keys || []).forEach(function(k) {
        var v = obj[k], op = "", type = "";
        if (!v && v != null) return;
        if (options.ops && options.ops[k]) op = options.ops[k];
        if (!op && v == null) op = "null";
        if (!op && Array.isArray(v)) op = "in";
        if (options.opsMap && options.opsMap[op]) op = options.opsMap[op];
        if (options.typesMap && options.typesMap[k]) type = options.typesMap[k];
        var sql = self.sqlExpr(k, v, { op: op, type: type });
        if (sql) where.push(sql);
    });
    return where.join(" AND ");
}

// Create SQL table using table definition
// - table - name of the table to create
// - obj - object with properties as column names and each property value is an object:
//      - name - column name
//      - type - type of the column, default is TEXT, options: int, real or other supported types
//      - value - default value for the column
//      - primary - part of the primary key
//      - index - indexed column, part of the compisite index
//      - unique - must be combined with index property to specify unique composite index
//      - len - max length of the column
//      - notnull - true if should be NOT NULL
// - options may contains:
//      - upgrade - perform alter table instead of create
//      - typesMap - type mapping, convert lowecase type into other type supported by any specific database
//      - noDefaults - ignore default value if not supported (Cassandra)
//      - noNulls - NOT NULL restriction is not supported (Cassandra)
//      - noMultiSQL - return as a list, the driver does not support multiple SQL commands
//      - noLengths - ignore column length for columns (Cassandra)
//      - noIfExists - do not support IF EXISTS on table or indexes
db.sqlCreate = function(table, obj, options)
{
    var self = this;
    if (!options) options = {};

    function keys(name) {
        return Object.keys(obj).filter(function(x) { return obj[x][name]; }).join(',');
    }

    var pool = this.getPool(table, options);
    var dbcols = pool.dbcolumns[table] || {};

    if (!options.upgrade) {

        var rc = ["CREATE TABLE " + (!options.noIfExists ? "IF NOT EXISTS " : " ") + table + "(" +
                  Object.keys(obj).
                      map(function(x) {
                          return x + " " +
                              (function(t) { return (options.typesMap || {})[t] || t })(obj[x].type || options.defaultType || "text") + (!options.noLengths && obj[x].len ? " (" + obj[x].len + ") " : " ") +
                              (!options.noNulls && obj[x].notnull ? " NOT NULL " : " ") +
                              (!options.noauto && obj[x].auto ? " AUTO_INCREMENT " : " ") +
                              (!options.noDefaults && typeof obj[x].value != "undefined" ? "DEFAULT " + self.sqlValue(obj[x].value, obj[x].type) : "") }).join(",") + " " +
                      (function(x) { return x ? ",PRIMARY KEY(" + x + ")" : "" })(keys('primary')) + " " + (options.tableOptions || "") + ")" ];

    } else {

        rc = Object.keys(obj).filter(function(x) { return (!(x in dbcols) || dbcols[x].fake) }).
                map(function(x) {
                    return "ALTER TABLE " + table + " ADD " + x + " " +
                        (function(t) { return (options.typesMap || {})[t] || t })(obj[x].type || options.defaultType || "text") + (!options.noLengths && obj[x].len ? " (" + obj[x].len + ") " : " ") +
                        (!options.noDefaults && typeof obj[x].value != "undefined" ? "DEFAULT " + self.sqlValue(obj[x].value, obj[x].type) : "") }).
                filter(function(x) { return x });
    }

    ["","1","2"].forEach(function(y) {
        var idxname = table + "_idx" + y;
        if (pool.dbindexes[idxname]) return;
        var sql = (function(x) { return x ? "CREATE INDEX " + (!options.noIfExists ? "IF NOT EXISTS " : " ") + idxname + " ON " + table + "(" + x + ")" : "" })(keys('index' + y));
        if (sql) rc.push(sql);
    });

    return { text: options.noMultiSQL && rc.length ? rc : rc.join(";") };
}

// Create ALTER TABLE ADD COLUMN statements for missing columns
db.sqlUpgrade = function(table, obj, options)
{
    return this.sqlCreate(table, obj, core.cloneObj(options || {}, "upgrade", 1));
}

// Create SQL DROP TABLE statement
db.sqlDrop = function(table, obj, options)
{
    return { text: "DROP TABLE IF EXISTS " + table };
}

// Select object from the database,
// options may define the follwong properties:
// - keys is a list of columns for condition
//  - select is list of columns or expressions to return
db.sqlSelect = function(table, obj, options)
{
	var self = this;
    if (!options) options = {};
    var keys = options.keys;
    if (!keys || !keys.length) keys = this.getKeys(table, options) || [];

    // Requested columns, support only existing
    var select = "*";
    if (options.total) {
    	select = "COUNT(*) AS count";
    } else {
    	select = this.getSelectedColumns(table, options);
    	if (!select) select = "*";
    }

    var where = this.sqlWhere(table, obj, keys, options);
    if (where) where = " WHERE " + where;

    var req = { text: "SELECT " + select + " FROM " + table + where + this.sqlLimit(options) };
    return req;
}

// Build SQL insert statement
db.sqlInsert = function(table, obj, options)
{
    if (!options) options = {};
    var names = [], pnums = [], req = { values: [] }, i = 1
    // Columns should exist prior to calling this
    var cols = this.getColumns(table, options);

    for (var p in obj) {
        var v = obj[p];
        var col = cols[p] || {};
        // Filter not allowed columns or only allowed columns
        if (this.skipColumn(p, v, options, cols)) continue;
        // Avoid int parse errors with empty strings
        if (v === "" && ["number","json"].indexOf(col.db_type) > -1) v = null;
        // Pass number as number, some databases strict about this
        if (v && col.db_type == "number" && typeof v != "number") v = core.toNumber(v);
        names.push(p);
        pnums.push(options.placeholder || ("$" + i));
        v = this.getBindValue(table, options, v, col);
        req.values.push(v);
        i++;
    }
    // No columns to insert, just exit, it is not an error, return empty result
    if (!names.length) {
        logger.debug('sqlInsert:', table, 'nothing to do', obj, cols);
        return null;
    }
    req.text = (options.replace ? "REPLACE" : "INSERT") + " INTO " + table + "(" + names.join(",") + ") values(" + pnums.join(",") + ")";
    if (options.returning) req.text += " RETURNING " + options.returning;
    return req;
}

// Build SQL statement for update
db.sqlUpdate = function(table, obj, options)
{
    if (!options) options = {};
    var sets = [], req = { values: [] }, i = 1;
    var cols = this.getColumns(table, options) || {};
    var keys = options.keys;
    if (!keys || !keys.length) keys = this.getKeys(table, options) || [];

    for (p in obj) {
        var v = obj[p];
        var col = cols[p] || {};
        // Filter not allowed columns or only allowed columns
        if (keys.indexOf(p) > -1 || this.skipColumn(p, v, options, cols)) continue;
        // Do not update primary columns
        if (col.primary) continue;
        // Avoid int parse errors with empty strings
        if (v === "" && ["number","json"].indexOf(col.db_type) > -1) v = null;
        // Pass number as number, some databases strict about this
        if (v && col.db_type == "number" && typeof v != "number") v = core.toNumber(v);
        var placeholder = (options.placeholder || ("$" + i));
        // Update only if the value is null, otherwise skip
        if (options.coalesce && options.coalesce.indexOf(p) > -1) {
            sets.push(p + "=COALESCE(" + p + "," + placeholder + ")");
        } else
        // Concat mode means append new value to existing, not overwrite
        if (options.concat && options.concat.indexOf(p) > -1) {
            sets.push(p + "=" + (options.noConcat ? p + "+" + placeholder : "CONCAT(" + p + "," + placeholder + ")"));
        } else
        // Incremental update
        if ((col.type === "counter") || (options.counter && options.counter.indexOf(p) > -1)) {
            sets.push(p + "=" + (options.noCoalesce ? p : "COALESCE(" + p + ",0)") + "+" + placeholder);
        } else {
            sets.push(p + "=" + placeholder);
        }
        v = this.getBindValue(table, options, v, col);
        req.values.push(v);
        i++;
    }
    var where = this.sqlWhere(table, obj, keys, options);
    if (!sets.length || !where) {
        // No keys or columns to update, just exit, it is not an error, return empty result
        logger.debug('sqlUpdate:', table, 'nothing to do', obj, keys);
        return null;
    }
    req.text = "UPDATE " + table + " SET " + sets.join(",") + " WHERE " + where;
    if (options.returning) req.text += " RETURNING " + options.returning;
    return req;
}

// Build SQL statement for delete
db.sqlDelete = function(table, obj, options)
{
    if (!options) options = {};
    var keys = options.keys;
    if (!keys || !keys.length) keys = this.getKeys(table, options) || [];

    var where = this.sqlWhere(table, obj, keys, options);
    if (!where) {
        // No keys or columns to update, just exit, it is not an error, return empty result
        logger.debug('sqlUpdate:', table, 'nothing to do', obj, keys);
        return null;
    }
    var req = { text: "DELETE FROM " + table + " WHERE " + where };
    if (options.returning) req.text += " RETURNING " + options.returning;
    return req;
}

// Setup PostgreSQL pool driver
db.pgsqlInitPool = function(options)
{
    if (!backend.PgSQLDatabase) return this.nopool;

    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "pgsql";
    var pool = this.initPool(options, self.pgsqlOpen);
    pool.dboptions = core.mergeObj(pool.dboptions, { typesMap: { real: "numeric" }, noIfExists: 1, noReplace: 1, schema: ['public'] });
    pool.bindValue = self.pgsqlBindValue;
    pool.cacheIndexes = self.pgsqlCacheIndexes;
    // No REPLACE INTO support, do it manually
    pool.put = function(table, obj, opts, callback) {
        self.update(table, obj, opts, function(err, rows, info) {
            if (err || info.affected_rows) return callback ? callback(err, rows, info) : null;
            self.add(table, obj, opts, callback);
        });
    }
    return pool;
}

// Open PostgreSQL connection, execute initial statements
db.pgsqlOpen = function(options, callback)
{
    new backend.PgSQLDatabase(options.db, function(err) {
        if (err) {
            logger.error('pgsqlOpen:', options, err);
            return callback(err);
        }
        this.notify(function(msg) { logger.log('notify:', msg) });
        callback(err, this);
    });
}

// Cache indexes using the information_schema
db.pgsqlCacheIndexes = function(options, callback)
{
    var self = this;

    self.get(function(err, client) {
        if (err) return callback ? callback(err, []) : null;

        client.query("SELECT t.relname as table, i.relname as index, indisprimary as pk, array_agg(a.attname) as cols "+
                     "FROM pg_class t, pg_class i, pg_index ix, pg_attribute a, pg_catalog.pg_namespace n "+
                     "WHERE t.oid = ix.indrelid and i.oid = ix.indexrelid and a.attrelid = t.oid and n.oid = t.relnamespace and " +
                     "      a.attnum = ANY(ix.indkey) and t.relkind = 'r' and n.nspname not in ('pg_catalog', 'pg_toast') "+
                     "GROUP BY t.relname, i.relname, ix.indisprimary ORDER BY t.relname, i.relname", function(err, rows) {
            if (err) logger.error('cacheIndexes:', self.name, err);
            self.dbkeys = {};
            self.dbindexes = {};
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].pk) {
                    self.dbkeys[rows[i].table] = rows[i].cols;
                } else {
                    self.dbindexes[rows[i].index] = rows[i].cols;
                }
            }
            self.free(client);
            if (callback) callback(err);
        });
    });
}

// Convert js array into db PostgreSQL array format: {..}
db.pgsqlBindValue = function(val, opts)
{
    function toArray(v) {
        return '{' + v.map(function(x) { return Array.isArray(x) ? toArray(x) : typeof x === 'undefined' || x === null ? 'NULL' : JSON.stringify(x); } ).join(',') + '}';
    }
    switch (opts && opts.data_type ? opts.data_type : "") {
    case "json":
        val = JSON.stringify(val);
        break;

    case "array":
        if (Buffer.isBuffer(val)) {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(v[i]);
            val = a.join(',');
        } else
        if (Array.isArray(val)) {
            val = toArray(val);
        }
        if (val && val[0] != "{") val = "{" + v + "}";
        break;

    default:
        if (Buffer.isBuffer(val)) val = val.toJSON();
        if (Array.isArray(val)) val = String(val);
    }
    return val;
}

// Initialize local Sqlite cache database by name, the db files are open in read only mode and are watched for changes,
// if new file got copied from the master, we reopen local database
db.sqliteInitPool = function(options)
{
    var self = this;
    if (!options) options = {};
    if (typeof options.readonly == "undefined") options.readonly = true;
    if (typeof options.temp_store == "undefined") options.temp_store = 0;
    if (typeof options.cache_size == "undefined") options.cache_size = 50000;
    if (typeof options.busy_timeout == "undefined") options.busy_timeout = -1;
    if (typeof options.read_uncommitted == "undefined") options.read_uncommitted = true;

    if (!options.pool) options.pool = "sqlite";
    options.file = path.join(options.path || core.path.spool, (options.db || name)  + ".db");
    var pool = this.initPool(options, self.sqliteOpen);
    pool.dboptions = core.mergeObj(pool.dboptions, { noLengths: 1, noMultiSQL: 1 });
    pool.cacheColumns = self.sqliteCacheColumns;
    return pool;
}

// Common code to open or create local Sqlite databases, execute all required initialization statements, calls callback
// with error as first argument and database object as second
db.sqliteOpen = function(options, callback)
{
    new backend.SQLiteDatabase(options.file, options.readonly ? backend.OPEN_READONLY : 0, function(err) {
        if (err) {
            // Do not report errors about not existing databases
            if (err.code != "SQLITE_CANTOPEN" || !options.silent) logger.error('sqliteOpen', options.file, err);
            return callback(err);
        }
        var db = this;

        // Execute initial statements to setup the environment, like pragmas
        var opts = [];
        if (typeof options.cache_size != "undefined") opts.push("PRAGMA cache_size=-" + options.cache_size);
        if (typeof options.temp_store != "undefined") opts.push("PRAGMA temp_store=" + options.temp_store);
        if (typeof options.journal_mode != "undefined") opts.push("PRAGMA journal_mode=" + options.journal_mode);
        if (typeof options.locking_mode != "undefined") opts.push("PRAGMA locking_mode=" + options.locking_mode);
        if (typeof options.synchronous != "undefined") opts.push("PRAGMA synchronous=" + options.synchronous);
        if (typeof options.read_uncommitted != "undefined") opts.push("PRAGMA read_uncommitted=" + options.read_uncommitted);
        if (typeof options.busy_timeout != "undefined") opts.push("SELECT busy_timeout(" + options.busy_timeout + ")");
        if (Array.isArray(options.init)) opts = opts.concat(options.init);
        async.forEachSeries(opts, function(sql, next) {
            logger.debug('sqliteOpen:', options.file, sql);
            db.exec(sql, next);
    }, function(err2) {
            logger.edebug(err2, 'sqliteOpen:', 'init', options.file);
            callback(err2, db);
        });
    });
}

db.sqliteCacheColumns = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    self.get(function(err, client) {
        if (err) return callback ? callback(err, []) : null;
        client.query("SELECT name FROM sqlite_master WHERE type='table'", function(err, tables) {
            if (err) return callback ? callback(err2) : null;
            self.dbcolumns = {};
            self.dbkeys = {};
            self.dbindexes = {};
            async.forEachSeries(tables, function(table, next) {

                client.query("PRAGMA table_info(" + table.name + ")", function(err, rows) {
                    if (err) return next(err);
                    for (var i = 0; i < rows.length; i++) {
                        if (!self.dbcolumns[table.name]) self.dbcolumns[table.name] = {};
                        if (!self.dbkeys[table.name]) self.dbkeys[table.name] = [];
                        // Split type cast and ignore some functions in default value expressions
                        self.dbcolumns[table.name][rows[i].name] = { id: rows[i].cid, name: rows[i].name, value: rows[i].dflt_value, db_type: rows[i].type.toLowerCase(), data_type: rows[i].type, isnull: !rows[i].notnull, primary: rows[i].pk };
                        if (rows[i].pk) self.dbkeys[table.name].push(rows[i].name);
                    }
                    client.query("PRAGMA index_list(" + table.name + ")", function(err4, indexes) {
                        async.forEachSeries(indexes, function(idx, next2) {
                            client.query("PRAGMA index_info(" + idx.name + ")", function(err5, cols) {
                                cols.forEach(function(x) {
                                    var col = self.dbcolumns[table.name][x.name];
                                    if (idx.unique) col.unique = 1;
                                    if (!self.dbindexes[idx.name]) self.dbindexes[idx.name] = [];
                                    self.dbindexes[idx.name].push(x.name);
                                });
                                next2();
                            });
                    }, function() {
                            next();
                        });
                    });
                });
        }, function(err) {
                self.free(client);
                if (callback) callback(err);
            });
        });
    });
}

// Setup Mysql database driver
db.mysqlInitPool = function(options)
{
    if (!backend.MysqlDatabase) return this.nopool;

    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "mysql";
    var pool = this.initPool(options, self.mysqlOpen);
    pool.cacheIndexes = self.mysqlCacheIndexes;
    pool.dboptions = core.mergeObj(pool.dboptions, { typesMap: { json: "text", bigint: "bigint" },
                                                     placeholder: "?",
                                                     defaultType: "VARCHAR(128)",
                                                     noIfExists: 1,
                                                     noJson: 1,
                                                     noMultiSQL: 1 });
    return pool;
}

db.mysqlOpen = function(options, callback)
{
    new backend.MysqlDatabase(options.db, function(err) {
        callback(err, this);
    });
}

db.mysqlCacheIndexes = function(options, callback)
{
    var self = this;
    self.get(function(err, client) {
        if (err) return callback ? callback(err, []) : null;

        self.dbkeys = {};
        self.dbindexes = {};
        client.query("SHOW TABLES", function(err, tables) {
            async.forEachSeries(tables, function(table, next) {
                table = table[Object.keys(table)[0]].toLowerCase();
                client.query("SHOW INDEX FROM " + table, function(err, rows) {
                    for (var i = 0; i < rows.length; i++) {
                        if (!self.dbcolumns[table]) continue;
                        var col = self.dbcolumns[table][rows[i].Column_name];
                        switch (rows[i].Key_name) {
                        case "PRIMARY":
                            if (!self.dbkeys[table]) self.dbkeys[table] = [];
                            self.dbkeys[table].push(rows[i].Column_name);
                            if (col) col.primary = true;
                            break;

                        default:
                            if (!self.dbindexes[rows[i].Key_name]) self.dbindexes[rows[i].Key_name] = [];
                            self.dbindexes[rows[i].Key_name].push(rows[i].Column_name);
                            break;
                        }
                    }
                    next();
                });
            }, function(err) {
                self.free(client);
                if (callback) callback(err);
            });
        });
    });
}

// Setup DynamoDB database driver
db.dynamodbInitPool = function(options)
{
    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "dynamodb";

    // Redefine pool but implement the same interface
    var pool = this.createPool(options.pool, null, { db: options.db, dboptions: { noJson: 1} });

    pool.cacheColumns = function(opts, callback) {
        var pool = this;
        var options = { db: pool.db };

        aws.ddbListTables(options, function(err, rc) {
            if (err) return callback ? callback(err) : null;
            pool.dbcolumns = {};
            pool.dbkeys = {};
            pool.dbindexes = {};
            async.forEachSeries(rc.TableNames, function(table, next) {
                aws.ddbDescribeTable(table, options, function(err, rc) {
                    if (err) return next(err);
                    rc.Table.AttributeDefinitions.forEach(function(x) {
                        if (!pool.dbcolumns[table]) pool.dbcolumns[table] = {};
                        var db_type = x.AttributeType == "N" ? "number" : x.AttributeType.length == 2 ? "array" : "text";
                        pool.dbcolumns[table][x.AttributeName] = { db_type: db_type, data_type: x.AttributeType };
                    });
                    rc.Table.KeySchema.forEach(function(x) {
                        if (!pool.dbkeys[table]) pool.dbkeys[table] = [];
                        pool.dbkeys[table].push(x.AttributeName);
                        pool.dbcolumns[table][x.AttributeName].primary = 1;
                    });
                    (rc.Table.LocalSecondaryIndexes || []).forEach(function(x) {
                        x.KeySchema.forEach(function(y) {
                            if (!pool.dbindexes[y.IndexName]) pool.dbindexes[y.IndexName] = [];
                            pool.dbindexes[y.IndexName].push(y.AttributeName);
                            pool.dbcolumns[y.IndexName][y.AttributeName].index = 1;
                        });
                    });
                    next();
                });
        }, function(err2) {
                callback(err2);
            });
        });
    }

    // Convert into human readable messages
    pool.convertError = function(table, err, opts) {
        if (err.message == "Attribute found when none expected.") return new Error("Record already exists");
        return err;
    }

    // Simulate query as in SQL driver but performing AWS call, text will be a table name and values will be request options
    pool.query = function(client, req, opts, callback) {
        var pool = this;
        var table = req.text;
        var obj = req.obj;
        var options = core.extendObj(opts, "db", pool.db);
        pool.next_token = null;
        var cols = pool.dbcolumns[table] || {};
        // Primary keys
        var primary_keys = (pool.dbkeys[table] || []).filter(function(x) { return obj[x] }).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
        switch(req.op) {
        case "create":
            var idxs = [];
            var keys = Object.keys(obj).filter(function(x, i) { return obj[x].primary}).
                              map(function(x, i) { return [ x, i ? 'RANGE' : 'HASH' ] }).
                              reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});

            if (keys.length == 2) {
                idxs = Object.keys(obj).filter(function(x) { return obj[x].index }).
                              map(function(x) { return [x, core.newObj(Object.keys(obj).filter(function(y) { return obj[y].primary })[0], 'HASH', x, 'RANGE') ] }).
                              reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
            }
            var attrs = Object.keys(obj).filter(function(x) { return obj[x].primary || (idxs.length && obj[x].index) }).
                               map(function(x) { return [ x, ["int","bigint","double","real","counter"].indexOf(obj[x].type || "text") > -1 ? "N" : "S" ] }).
                               reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});

            aws.ddbCreateTable(table, attrs, keys, idxs, options, function(err, item) {
                callback(err, item.Item ? [item.Item] : []);
            });
            break;

        case "upgrade":
            callback(null, []);
            break;

        case "drop":
            aws.ddbDeleteTable(table, options, function(err) {
                callback(err, []);
            });
            break;

        case "get":
            options.select = self.getSelectedColumns(table, options);
            aws.ddbGetItem(table, primary_keys, options, function(err, item) {
                callback(err, item.Item ? [item.Item] : []);
            });
            break;

        case "select":
        case "search":
            // If we have other key columns we have to use custom filter
            var other = (options.keys || []).filter(function(x) { return pool.dbkeys[table].indexOf(x) == -1 });
            // Only primary key columns are allowed
            var keys = (options.keys || pool.dbkeys[table] || []).filter(function(x) { return other.indexOf(x) == -1 && obj[x] }).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
            var filter = function(items) {
                if (other.length > 0) {
                    if (!options.ops) options.ops = {};
                    if (!options.type) options.type = {};
                    // Keep rows which satisfy all conditions
                    items = items.filter(function(row) {
                        return other.every(function(k) {
                            return core.isTrue(row[k], obj[k], options.ops[k], options.type[k]);
                        });
                    });
                }
                return options.filter ? items.filter(function(row) { return options.filter(row, options); }) : items;
            }
            // Do not use index name if it is a primary key
            if (options.sort && Object.keys(keys).indexOf(options.sort) > -1) options.sort = null;
            options.select = self.getSelectedColumns(table, options);

            var op = Object.keys(keys).sort().toString() == Object.keys(primary_keys).sort().toString() ? 'ddbQueryTable' : 'ddbScanTable';
            aws[op](table, keys, options, function(err, item) {
                if (err) return callback(err, []);
                var count = options.count || 0;
                var rows = filter(item.Items);
                pool.next_token = item.LastEvaluatedKey ? aws.fromDynamoDB(item.LastEvaluatedKey) : null;
                count -= rows.length;

                // Keep retrieving items until we reach the end or our limit
                async.until(
                    function() { return pool.next_token == null || count <= 0; },
                    function(next) {
                        options.start = pool.next_token;
                        aws.ddbQueryTable(table, keys, options, function(err, item) {
                            var items = filter(item.Items);
                            rows.push.apply(rows, items);
                            pool.next_token = item.LastEvaluatedKey ? aws.fromDynamoDB(item.LastEvaluatedKey) : null;
                            count -= items.length;
                            next(err);
                        });
                }, function(err) {
                	callback(err, rows);
                });
            });
            break;

        case "list":
            var req = {};
            req[table] = { keys: obj, select: self.getSelectedColumns(table, options), consistent: options.consistent };
            aws.ddbBatchGetItem(req, options, function(err, item) {
                if (err) return callback(err, []);
                // Keep retrieving items until we get all items
                var moreKeys = item.UnprocessedKeys || null;
                var items = item.Responses[table] || [];
                async.until(
                    function() { return moreKeys; },
                    function(next) {
                        options.RequestItems = moreKeys;
                        aws.ddbBatchGetItem({}, options, function(err, item) {
                            items.push.apply(items, item.Responses[table] || []);
                            next(err);
                        });
                }, function(err) {
                	callback(err, items);
                });
            });
            break;

        case "add":
            // Add only listed columns if there is a .columns property specified
        	var cols = pool.dbcolumns[table] || {};
            var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return (v == null || v === "") || self.skipColumn(n, v, options, cols); } });
            options.expected = (pool.dbkeys[table] || []).map(function(x) { return x }).reduce(function(x,y) { x[y] = null; return x }, {});
            aws.ddbPutItem(table, o, options, function(err, rc) {
                callback(err, []);
            });
            break;

        case "put":
            // Add/put only listed columns if there is a .columns property specified
            var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return (v == null || v === "") || self.skipColumn(n, v, options, cols); } });
            aws.ddbPutItem(table, o, options, function(err, rc) {
                callback(err, []);
            });
            break;

        case "update":
            options.expected = primary_keys;

        case "incr":
            // Skip special columns, primary key columns. If we have specific list of allowed columns only keep those.
        	var cols = pool.dbcolumns[table] || {};
            // Keep nulls and empty strings, it means we have to delete this property.
            var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return primary_keys[n] || self.skipColumn(n, v, options, cols); }, _empty_to_null: 1 });
            // Increment counters, only specified columns will use ADD operation, they must be numbers
            if (!options.ops) options.ops = {};
            if (options.counter) options.counter.forEach(function(x) { options.ops[x] = 'ADD'; });
            aws.ddbUpdateItem(table, primary_keys, o, options, function(err, rc) {
                callback(err, []);
            });
            break;

        case "del":
            aws.ddbDeleteItem(table, primary_keys, options, function(err, rc) {
                callback(err, []);
            });
            break;

        default:
            callback(new Error("invalid op"), []);
        }
    };
    return pool;
}

// Cassandra pool
db.cassandraInitPool = function(options)
{
    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "cassandra";

    var pool = this.initPool(options, self.cassandraOpen);
    pool.dboptions = core.mergeObj(pool.dboptions, { typesMap: { json: "text", real: "double", counter: "counter" },
                                                     opsMap: { begins_with: "begins_with" },
                                                     placeholder: "?",
                                                     noCoalesce: 1,
                                                     noConcat: 1,
                                                     noDefaults: 1,
                                                     noNulls: 1,
                                                     noLengths: 1,
                                                     noReplace: 1,
                                                     noJson: 1,
                                                     noMultiSQL: 1 });
    pool.bindValue = self.cassandraBindValue;
    pool.cacheColumns = self.cassandraCacheColumns;
    // No REPLACE INTO support but UPDATE creates new record if no primary key exists
    pool.put = function(table, obj, opts, callback) {
        self.update(table, obj, opts, callback);
    };
    pool.nextToken = function(req, rows, opts) {
        if (!rows.length) return;
        var keys = this.dbkeys[req.table.toLowerCase()] || [];
        this.next_token = keys.map(function(x) { return core.newObj(x, rows[rows.length-1][x]) });
    }
    pool.prepare = function(op, table, obj, opts) {
        switch (op) {
        case "search":
        case "select":
            // Pagination, start must be a token returned by the previous query, this assumes that options.ops stays the same as well
            if (Array.isArray(opts.start) && typeof opts.start[0] == "object") {
                obj = core.cloneObj(obj);
                opts.start.forEach(function(x) { for (var p in x) obj[p] = x[p]; });
            }
            break;
        }
        return self.sqlPrepare(op, table, obj, opts);
    }
    return pool;
}

db.cassandraOpen = function(options, callback)
{
    var opts = url.parse(options.db);
    var db = new helenus.ConnectionPool({ hosts: [opts.host],  keyspace: opts.path.substr(1), user: opts.auth ? opts.auth.split(':')[0] : null, password: opts.auth ? opts.auth.split(':')[1] : null });
    db.query = this.cassandraQuery;
    db.on('error', function(err) { logger.error('cassandra:', err); });
    db.connect(function(err, keyspace) {
        if (err) logger.error('cassandraOpen:', err);
        if (callback) callback(err, db);
    });
}

db.cassandraQuery = function(text, values, callback)
{
    if (typeof values == "function") callback = values, values = null;
    try {
        this.cql(text, core.cloneObj(values), function(err, results) {
            if (err || !results) return callback ? callback(err, []) : null;
            var rows = [];
            results.forEach(function(row) {
                var obj = {};
                row.forEach(function(name, value, ts, ttl) {
                    obj[name] = value;
                    if (ts) obj["_timestamp"] = ts;
                    if (ttl) obj["_ttl"] = ttl;
                });
                rows.push(obj);
            });
            if (callback) callback(err, rows);
        });
    } catch(e) {
        if (callback) callback(e, []);
    }
}

db.cassandraCacheColumns = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    self.get(function(err, client) {
        if (err) return callback ? callback(err, []) : null;

        client.query("SELECT * FROM system.schema_columns WHERE keyspace_name = ?", [client.keyspace], function(err, rows) {
            rows.sort(function(a,b) { return a.component_index - b.component_index });
            self.dbcolumns = {};
            self.dbindexes = {};
            self.dbkeys = {};
            for (var i = 0; i < rows.length; i++) {
                if (!self.dbcolumns[rows[i].columnfamily_name]) self.dbcolumns[rows[i].columnfamily_name] = {};
                var data_type = rows[i].validator.replace(/[\(\)]/g,".").split(".").pop().replace("Type", "").toLowerCase();
                var db_type = "";
                switch (data_type) {
                case "decimal":
                case "float":
                case "int32":
                case "long":
                case "double":
                case "countercolumn":
                    db_type = "number";
                    break;

                case "boolean":
                    db_type = "bool";
                    break;

                case "date":
                case "timestamp":
                    db_type = "date";
                    break;
                }
                // Set data type to collection type, use type for items
                var d = rows[i].validator.match(/(ListType|SetType|MapType)/);
                if (d) data_type = d[1].replace("Type", "").toLowerCase() + ":" + data_type;
                var col = { id: i, db_type: db_type, data_type: data_type };
                switch(rows[i].type) {
                case "regular":
                    if (!rows[i].index_name) break;
                    if (!self.dbindexes[rows[i].index_name]) self.dbindexes[rows[i].index_name] = [];
                    self.dbindexes[rows[i].index_name].push(rows[i].column_name);
                    break;
                case "partition_key":
                case "clustering_key":
                    if (!self.dbkeys[rows[i].columnfamily_name]) self.dbkeys[rows[i].columnfamily_name] = [];
                    self.dbkeys[rows[i].columnfamily_name].push(rows[i].column_name);
                    if (col) col.primary = true;
                    break;
                }
                self.dbcolumns[rows[i].columnfamily_name][rows[i].column_name] = col;
            }
            self.free(client);
            if (callback) callback(err);
        });
    });
}

// Setup LevelDB database driver, this is simplified driver which supports only basic key-value operations,
// table parameter is ignored, the object only supports the followig properties name and value.
// Options are passed to the LevelDB backend low level driver which is native LevelDB options using the same names:
// http://leveldb.googlecode.com/svn/trunk/doc/index.html
// The database can only be shared by one process so if no unique options.db is given, it will create a unique database as using core.processId()
db.leveldbInitPool = function(options)
{
    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "leveldb";

    var pool = this.createPool(options.pool, null);

    pool.get = function(callback) {
        if (this.ldb) return callback(null, this);
        try {
            if (!core.exists(this.create_if_missing)) options.create_if_missing = true;
            var path = core.path.spool + "/" + (options.db || ('ldb_' + core.processId()));
            new backend.LevelDB(path, options, function(err) {
                pool.ldb = this;
                callback(null, pool);
            });
        } catch(e) {
            callback(e);
        }
    }
    pool.query = function(client, req, opts, callback) {
        var pool = this;
        var table = req.text;
        var obj = req.obj;

        switch(req.op) {
        case "create":
        case "upgrade":
        case "drop":
            callback(null, []);
            break;

        case "get":
            client.ldb.get(obj.name || "", opts, function(err, item) {
                callback(err, item ? [item] : []);
            });
            break;

        case "select":
        case "search":
            client.ldb.all(obj.name || "", opts.end || "", opts, callback);
            break;

        case "list":
            var rc = [];
            async.forEachSeries(obj, function(id, next) {
                client.ldb.get(id, opts, function(err, val) {
                    if (val) rc.push(val);
                    next(err);
                });
            }, function(err) {
                callback(err, rc);
            });
            break;

        case "add":
        case "put":
        case "update":
            client.ldb.put(obj.name || "", obj.value || "", opts, function(err) {
                callback(err, []);
            });
            break;

        case "incr":
            client.ldb.incr(obj.name || "", obj.value || "", opts, function(err) {
                callback(err, []);
            });
            break;

        case "del":
            client.ldb.del(obj.name || "", opts, function(err) {
                callback(err, []);
            });
            break;

        default:
            callback(new Error("invalid op"), []);
        }
    };
    return pool;
}

// Setup LMDB database driver, this is simplified driver which supports only basic key-value operations,
// table parameter is ignored, the object only supports the properties name and value in the record objects.
// Options are passed to the LMDB backend low level driver as MDB_ flags, see http://symas.com/mdb/doc/
// - select and search actions support options.end property which defines the end condition for a range retrieval starting
//   with obj.name property. If not end is given, all records till the end will be returned.
db.lmdbInitPool = function(options)
{
    var self = this;
    if (!options) options = {};
    if (!options.pool) options.pool = "lmdb";

    var pool = this.createPool(options.pool);

    pool.get = function(callback) {
        if (this.lmdb) return callback(null, this);
        try {
            if (!options.path) options.path = core.path.spool;
            if (!options.flags)  options.flags = backend.MDB_CREATE;
            if (!options.dbs) options.dbs = 1;
            // Share same environment between multiple pools, each pool works with one db only to keep the API simple
            if (options.env && options.env instanceof backend.LMDBEnv) this.env = options.env;
            if (!this.env) this.env = new backend.LMDBEnv(options);
            new backend.LMDB(this.env, { name: options.db, flags: options.flags }, function(err) {
                pool.lmdb = this;
                callback(err, pool);
            });
        } catch(e) {
            callback(e);
        }
    }
    pool.query = function(client, req, opts, callback) {
        var pool = this;
        var table = req.text;
        var obj = req.obj;

        logger.log(req)

        switch(req.op) {
        case "create":
        case "upgrade":
        case "drop":
            callback(null, []);
            break;

        case "get":
            client.lmdb.get(obj.name || "", function(err, item) {
                callback(err, item ? [item] : []);
            });
            break;

        case "select":
        case "search":
            client.lmdb.all(obj.name || "", opts.end || "", opts, callback);
            break;

        case "list":
            var rc = [];
            async.forEachSeries(obj, function(id, next) {
                client.lmdb.get(id, opts, function(err, val) {
                    if (val) rc.push(val);
                    next(err);
                });
            }, function(err) {
                callback(err, rc);
            });
            break;

        case "add":
        case "put":
        case "update":
            client.lmdb.put(obj.name || "", obj.value || "", opts, function(err) {
                callback(err, []);
            });
            break;

        case "incr":
            client.lmdb.incr(obj.name || "", obj.value || "", opts, function(err) {
                callback(err, []);
            });
            break;

        case "del":
            client.lmdb.del(obj.name || "", opts, function(err) {
                callback(err, []);
            });
            break;

        default:
            callback(new Error("invalid op"), []);
        }
    };
    return pool;
}
