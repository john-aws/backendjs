//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const url = require('url');
const mime = require('mime');
const qs = require('qs');
const http = require('http');
const https = require('https');
const logger = require(__dirname + '/logger');
const core = require(__dirname + '/core');
const lib = require(__dirname + '/lib');
const aws = require(__dirname + '/aws');

// Sign S3 AWS request, returns url to be send to S3 server, options will have all updated headers to be sent as well
aws.signS3 = function(method, bucket, path, body, options)
{
    if (!options) options = {};
    if (!options.headers) options.headers = {};

    var region = options.region || this.region || 'us-east-1';
    if (!options.headers["content-type"]) options.headers["content-type"] = "binary/octet-stream";
    // For text files to prevent encoding/decoding issues
    if (/text|html|xml|json/.test(options.headers["content-type"]) &&
        options.headers["content-type"].indexOf("charset=") == -1) {
        options.headers["content-type"] += "; charset=utf-8";
    }

    // Run through the encoding so our signature match the real url sent by core.httpGet
    path = url.parse(path || "/").pathname;
    if (path[0] != "/") path = "/" + path;

    // DNS compatible or not, use path-style if not for access otherwise virtual host style
    var dns = bucket.match(/[a-z0-9][a-z0-9-]*[a-z0-9]/) ? true : false;

    var host = (dns ? bucket + "." : "") + "s3" + (region != "us-east-1" ? "-" + region : "") + ".amazonaws.com";
    var uri = (options.endpoint_protocol || "https") + "://" + host + (dns ? "" : "/" + bucket) + path;
    var credentials = options.credentials || this;

    if (region != 'us-east-1') {
        if (!dns) path = "/" + bucket + path;
        var q = Object.keys(options.query || []).sort().map(function(x) {
            return aws.uriEscape(x) + (options.query[x] == null ? "" : "=" + aws.uriEscape(options.query[x]));
        });
        if (q) path += "?" + q;
        if (!options.headers["x-amz-content-sha256"]) {
            options.headers["x-amz-content-sha256"] = method != "GET" && options.postfile ? "UNSIGNED-PAYLOAD" : lib.hash(body || "", "sha256", "hex");
        }
        var opts = {};
        this.querySign(region, "s3", host, method || "GET", path, body, options.headers, options.credentials, opts);
        if (options.url) {
            uri += '&X-Amz-Date=' + opts.date;
            uri += '&X-Amz-Algorithm=AWS4-HMAC-SHA256';
            uri += '&X-Amz-Credential=' + opts.credential;
            uri += '&X-Amz-SignedHeaders=' + opts.signedHeaders;
            uri += '&X-Amz-Signature=' + opts.signature;
            if (options.expires) uri += "&X-Amz-Expires=" + options.expires;
            if (credentials.token) uri += '&X-Amz-Security-Token=' + credentials.token;
        }
        logger.debug('signS3:', uri, lib.objDescr(options), "opts:", opts);
    } else {
        if (!options.headers["x-amz-date"]) options.headers["x-amz-date"] = (new Date()).toUTCString();
        if (credentials.token) options.headers["x-amz-security-token"] = credentials.token;

        // Construct the string to sign and query string
        var strSign = (method || "GET") + "\n" + (options.headers['content-md5']  || "") + "\n" + (options.headers['content-type'] || "") + "\n" + (options.expires || "") + "\n";

        // Amazon canonical headers
        var hdrs = [];
        for (var p in options.headers) {
            if (/X-AMZ-/i.test(p)) {
                var value = options.headers[p];
                if (value instanceof Array) value = value.join(',');
                hdrs.push(p.toString().toLowerCase() + ':' + value);
            }
        }
        if (hdrs.length) strSign += hdrs.sort().join('\n') + "\n";
        // Split query string for subresources, supported are:
        var resources = ["acl", "lifecycle", "location", "logging", "notification", "partNumber", "policy", "requestPayment", "torrent",
                         "uploadId", "uploads", "versionId", "versioning", "versions", "website", "cors",
                         "delete",
                         "response-content-type", "response-content-language", "response-expires",
                         "response-cache-control", "response-content-disposition", "response-content-encoding" ];
        var rc = [];
        for (p in options.query) {
            p = p.toLowerCase();
            if (resources.indexOf(p) != -1) rc.push(p + (options.query[p] == null ? "" : "=" + options.query[p]));
        }
        strSign += (bucket ? "/" + bucket : "") + path + (rc.length ? "?" : "") + rc.sort().join("&");
        var signature = lib.sign(credentials.secret, strSign);
        options.headers.authorization = "AWS " + credentials.key + ":" + signature;

        // Build REST url
        if (options.url) {
            uri += url.format({ query: options.query });
            uri += (uri.indexOf("?") == -1 ? "?" : "") + '&AWSAccessKeyId=' + credentials.key + "&Signature=" + encodeURIComponent(signature);
            if (options.expires) uri += "&Expires=" + options.expires;
            if (credentials.token) uri += "&SecurityToken=" + credentials.token;
        }
        logger.debug('signS3:', uri, lib.objDescr(options), "str:", strSign);
    }
    return uri;
}

// S3 requests
// Options may contain the following properties:
// - method - HTTP method
// - query - query parameters for the url as an object
// - postdata - any data to be sent with POST
// - postfile - file to be uploaded to S3 bucket
// - expires - absolute time when this request is expires
// - headers - HTTP headers to be sent with request
// - file - file name where to save downloaded contents
aws.queryS3 = function(bucket, path, options, callback)
{
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};

    if (!options.retryCount) options.retryCount = 3;
    if (!options.retryTimeout) options.retryTimeout = 1000;
    options.retryOnError = function() { return this.status == 503 || this.status == 500 }
    var uri = this.signS3(options.method, bucket, path, options.postdata, options);

    core.httpGet(uri, options, function(err, params) {
        if (params.status < 200 || params.status > 299) err = aws.parseError(params, options);
        lib.tryCall(callback, err, params);
    });
}

// Retrieve a list of files from S3 bucket, only files inside the path will be returned
aws.s3List = function(path, options, callback)
{
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};

    options.query = options.query || {};
    var uri = this.s3ParseUrl(path);
    for (var p in uri.query) options.query[p] = uri.query[p];
    if (uri.path) options.query.prefix = uri.path;
    if (uri.key) options = lib.objClone(options, "credentials", { key: uri.key, secret: uri.secret });
    var rows = [], truncated = false, self = this;
    lib.doWhilst(
      function(next) {
          self.queryS3(uri.bucket, "", options, function(err, params) {
              if (err) return next(err);
              rows.push.apply(rows, lib.objGet(params.obj, "ListBucketResult.Contents", { list: 1 }));
              truncated = lib.toBool(params.obj.ListBucketResult.IsTruncated);
              options.query.marker = params.obj.ListBucketResult.NextMarker || rows.length ? rows[rows.length - 1].Key : "";
              next(err);
          });
      },
      function() {
          return truncated;
      }, function(err) {
          lib.tryCall(callback, err, rows);
      });
}

// Retrieve a file from S3 bucket, root of the path is a bucket, path can have a protocol prepended like s3://, it will be ignored
aws.s3GetFile = function(path, options, callback)
{
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};

    var uri = this.s3ParseUrl(path);
    if (uri.query) options.query = uri.query;
    if (uri.key) options = lib.objClone(options, "credentials", { key: uri.key, secret: uri.secret });
    this.queryS3(uri.bucket, uri.path, options, callback);
}

// Upload a file to S3 bucket, `file` can be a Buffer or a file name
aws.s3PutFile = function(path, file, options, callback)
{
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};

    options.method = "PUT";
    if (!options.headers) options.headers = {};
    if (options.acl) options.headers['x-amz-acl'] = options.acl;
    if (options.contentType) options.headers['content-type'] = options.contentType;
    if (!options.headers['content-type']) options.headers['content-type'] = mime.getType(path);
    options[Buffer.isBuffer(file) ? 'postdata' : 'postfile'] = file;
    var uri = this.s3ParseUrl(path);
    if (uri.query) options.query = uri.query;
    if (uri.key) options = lib.objClone(options, "credentials", { key: uri.key, secret: uri.secret });
    logger.debug("s3PutFile:", uri, lib.objDescr(options));
    this.queryS3(uri.bucket, uri.path, options, callback);
}

// Parse an S3 URL and return an object with bucket and path
aws.s3ParseUrl = function(link)
{
    var rc = {};
    if (!link) return rc;
    link = link.split("?");
    // Remove the protocol part and leading slashes
    link[0] = link[0].replace(/(^.+\:\/\/|^\/+)/, "");
    var path = link[0].replace("//", "/").split("/");
    rc.bucket = path[0];
    // Access key and secret as auth
    var d = rc.bucket.match(/^([^:]+):([^@]+)@(.+)$/);
    if (d) {
        rc.key = d[1];
        rc.secret = d[2];
        rc.bucket = d[3];
    }
    rc.path = path.slice(1).join("/");
    if (link[1]) rc.query = qs.parse(link[1]);
    return rc;
}

// Proxy a file from S3 bucket into the existing HTTP response `res`
aws.s3Proxy = function(res, bucket, path, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    var opts = lib.objClone(options);
    var params = url.parse(this.signS3("GET", bucket, path, "", opts));
    params.headers = opts.headers;
    var mod = params.protocol == "https:" ? https : http;
    var s3req = mod.request(params, function(s3res) {
        res.writeHead(s3res.statusCode, s3res.headers);
        s3res.pipe(res, { end: true });
    }).on("error", function(err) {
        logger.error('s3Proxy:', bucket, path, err);
        s3req.abort();
    }).on("close", function() {
        lib.tryCall(null, callback);
    });
    s3req.setTimeout(options.httpTimeout || 10000, function() { s3req.abort() });
    s3req.end();
}

