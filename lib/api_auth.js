//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const url = require('url');
const bcrypt = require('bcrypt');
const lib = require(__dirname + '/lib');
const db = require(__dirname + '/db');
const api = require(__dirname + '/api');
const logger = require(__dirname + '/logger');

// Perform authorization of the incoming request for access and permissions
api.handleSignature = function(req, res, next)
{
    this.checkAccess(req, function afterAccess(status) {
        // Status is given, return an error or proceed to the next module
        if (status && status.status) {
            if (status.status == 200) return next();
            if (status.status) {
                api.clearSessionSignature(req);
                api.sendReply(res, status);
            }
            return;
        }

        // Verify account signature
        api.checkRequestSignature(req, function afterSig(status) {
            if (status && status.status != 200) logger.debug('handleSignature:', status, req.signature, 'HDRS:', req.headers, 'SESSION:', req.session);

            // Determine what to do with the request even if the status is not success, a hook may deal with it differently,
            // the most obvious case is for a Web app to perform redirection on authentication failure
            api.checkAuthorization(req, status, function afterAuth(status) {
                if (status && status.status != 200) {
                    api.clearSessionSignature(req);
                    api.sendReply(res, status);
                } else {
                    api.checkRouting(req, "authRouting");
                    next();
                }
            });
        });
    });
}

// Setup session cookies or access token for automatic authentication without signing, req must be complete with all required
// properties after successful authorization.
api.handleSessionSignature = function(req, callback)
{
    var options = this.getOptions(req);
    options.accesstoken = options.accesstoken && req.account && req.account.login && req.account.secret && req.headers ? true : false;
    options.session = options.session && req.account && req.account.login && req.account.secret && req.headers ? true : false;
    var hooks = this.findHook('sig', req.method, req.path);
    logger.debug("handleSessionSignature:", hooks.length, "hooks", options);

    if (!hooks.length) {
        if (options.accesstoken) this.createAccessTokenSignature(req, options);
        if (options.session) this.createSessionSignature(req, options);
        return lib.tryCall(callback);
    }

    lib.forEachSeries(hooks, function(hook, next) {
        hook.callback.call(api, req, req.account, null, next);
    }, (sig) => {
        if (!sig) {
            if (options.accesstoken) this.createAccessTokenSignature(req, options);
            if (options.session) this.createSessionSignature(req, options);
        }
        lib.tryCall(callback);
    });
}

api.clearSessionSignature = function(req)
{
    if (req.account) {
        delete req.account[this.accessTokenName];
        delete req.account[this.accessTokenName + '-age'];
    }
    if (req.session) {
        delete req.session[this.signatureHeaderName];
    }
}

// Returns a new signature object with all required properties filled form the request object
api.newSignature = function(req)
{
    var rc = { version: 1, expires: 0, now: Date.now() };
    var url = (req.signatureUrl || req.url || "/").split("?");
    rc.path = url[0];
    rc.query = url[1] || "";
    rc.method = req.method || "";
    rc.host = (req.headers.host || "").split(':').shift().toLowerCase();
    rc.type = (req.headers['content-type'] || "").toLowerCase();
    for (var i = 1; i < arguments.length; i += 2) rc[arguments[i]] = arguments[i + 1];
    return rc;
}

// Parse incoming request for signature and return all pieces wrapped in an object, this object will be used by `verifySignature` function.
//
// If the signature successfully recognized it is saved in the request as `req.signature`,
// it always returns a signature object, a new one or existing
api.getSignature = function(req)
{
    if (req.signature) return req.signature;
    var sig = this.newSignature(req);
    var signature = req.query[this.signatureHeaderName] || req.headers[this.signatureHeaderName] || "";
    if (!signature && !this.noAccessToken) {
        signature = req.query[this.accessTokenName] || req.headers[this.accessTokenName];
        if (signature) {
            signature = lib.decrypt(this.accessTokenSecret, signature, "", "hex");
            sig.source = "t";
        }
    }
    if (!signature) {
        signature = req.session ? req.session[this.signatureHeaderName] : "";
        if (signature) sig.source = "s";
    }
    delete req.query[this.accessTokenName];
    delete req.query[this.signatureHeaderName];
    if (signature) {
        var d = signature.match(this.rxSignature);
        if (d) {
            sig.version = lib.toNumber(d[1]);
            if (d[2]) sig.tag = d[2];
            if (d[3]) sig.login = d[3].trim();
            if (d[4]) sig.signature = d[4];
            sig.expires = lib.toNumber(d[5]);
            sig.checksum = d[6] || "";
            req.signature = sig;
        }
    }
    return sig;
}

// Returns true if the signature `sig` matches given account secret. `account` object must be a `bk_auth` record.
api.verifySignature = function(req, sig, account, callback)
{
    // Verify the signature
    var secret = account.secret;
    var query = (sig.query).split("&").sort().filter(function(x) { return x != "" && x.indexOf(api.signatureHeaderName) != 0 }).join("&");
    switch (sig.version) {
    case -1:
        bcrypt.compare(sig.secret, secret, function(err, rc) {
            if (!rc) logger.debug("verifySignature:", 'failed', sig, account);
            callback(rc ? sig : null);
        });
        return;

    case 1:
        sig.str = "";
        sig.str = sig.method + "\n" + sig.host + "\n" + sig.path + "\n" + query + "\n" + sig.expires + "\n" + sig.type + "\n" + sig.checksum + "\n";
        sig.hash = lib.sign(secret, sig.str, "sha1");
        break;

    case 3:
        secret += ":" + (account.token_secret || "");
    case 2:
        sig.str = sig.version + "\n" + (sig.tag || "") + "\n" + sig.login + "\n*\n" + lib.domainName(sig.host) + "\n/\n*\n" + sig.expires + "\n*\n*\n";
        sig.hash = lib.sign(secret, sig.str, "sha256");
        break;

    case 4:
        if (account.auth_secret) secret += ":" + account.auth_secret;
        sig.str = sig.version + "\n" + (sig.tag || "") + "\n" + sig.login + "\n" + sig.method + "\n" + sig.host + "\n" + sig.path + "\n" + query + "\n" + sig.expires + "\n" + sig.type + "\n" + sig.checksum + "\n";
        sig.hash = lib.sign(secret, sig.str, "sha256");
        break;

    default:
        sig.hash = NaN;
        var hooks = this.findHook('sig', sig.method, sig.path);
        if (hooks.length) {
            lib.forEachSeries(hooks, function(hook, next) {
                hook.callback.call(api, req, account, sig, next);
            }, function(rc) {
                if (!rc) logger.debug("verifySignature:", 'failed', sig, account);
                callback(rc);
            });
            return;
        }
    }

    if (sig.signature != sig.hash) {
        logger.debug('verifySignature:', 'failed', sig, account);
        sig = null;
    }
    callback(sig);
}

// Create secure signature for an HTTP request. Returns an object with HTTP headers to be sent in the response.
//
// The options may contains the following:
//  - expires is absolute time in milliseconds when this request will expire, default is 30 seconds from now
//  - version a version number defining how the signature will be signed
//  - type - content-type header, may be omitted
//  - tag - a custom tag, vendor specific, opaque to the bkjs, can be used for passing additional account or session inforamtion
//  - checksum - SHA1 digest of the whole content body, may be omitted
//  - query - on object with query parameters to use instead of parameters in the uri
api.createSignature = function(login, secret, method, host, uri, options)
{
    if (!login || !secret) return {};
    if (!options) options = {};
    var now = Date.now();
    var expires = options.expires || 0;
    if (!expires) expires = now + 30000;
    if (expires < now) expires += now;
    var ver = options.version || 4;
    var tag = String(options.tag || "");
    var ctype = String(options.type || "").toLowerCase();
    var checksum = String(options.checksum || "");
    var hostname = String(host || "").split(":").shift().toLowerCase();
    var q = String(uri || "/").split("?");
    var path = q[0];
    var query = options.query || q[1] || "";
    if (typeof query == "object") query = url.format({ query: options.query });
    query = query.split("&").sort().filter(function(x) { return x != ""; }).join("&");
    var rc = {}, str, hmac;
    switch (ver) {
    case -1:
        // Internal use only
        return rc;

    case 1:
        str = String(method) + "\n" + hostname + "\n" + path + "\n" + query + "\n" + String(expires) + "\n" + ctype + "\n" + checksum + "\n";
        hmac = lib.sign(secret, str, "sha1")
        break;

    case 2:
    case 3:
        path = "/";
        method = query = "*";
        rc['bk-domain'] = hostname = lib.domainName(hostname);
        rc['bk-max-age'] = Math.floor((expires - now)/1000);
        rc['bk-expires'] = expires;
        rc['bk-path'] = path;
        str = ver + '\n' + tag + '\n' + String(login) + "\n" + String(method) + "\n" + hostname + "\n" + path + "\n" + query + "\n" + String(expires) + "\n*\n*\n";
        hmac = lib.sign(secret, str, "sha256")
        break;

    case 4:
    default:
        str = ver + '\n' + tag + '\n' + String(login) + "\n" + String(method) + "\n" + hostname + "\n" + path + "\n" + query + "\n" + String(expires) + "\n" + ctype + "\n" + checksum + "\n";
        hmac = lib.sign(secret, str, "sha256")
    }
    rc[this.signatureHeaderName] = ver + '|' + tag + '|' + String(login) + '|' + hmac + '|' + expires + '|' + checksum + '|';
    logger.debug('createSignature:', rc);
    return rc;
}

api.createSessionSignature = function(req, options)
{
    var sig = this.createSignature(req.account.login, req.account.secret, "", req.headers.host, "", { version: 2, expires: options && options.sessionAge || this.sessionAge });
    if (req.session) req.session[this.signatureHeaderName] = sig[this.signatureHeaderName];
    return sig;
}

api.createAccessTokenSignature = function(req, options)
{
    var sig = this.createSignature(req.account.login, req.account.secret + ":" + (req.account.token_secret || ""), "", req.headers.host, "", { version: 3, expires: options && options.sessionAge || this.accessTokenAge });
    req.account[this.accessTokenName] = lib.encrypt(this.accessTokenSecret, sig[this.signatureHeaderName], "", "hex");
    req.account[this.accessTokenName + '-age'] = options && options.sessionAge || this.accessTokenAge;
    return sig;
}

// Verify request signature from the request object, uses properties: .host, .method, .url or .originalUrl, .headers
api.checkRequestSignature = function(req, callback)
{
    var now = Date.now();
    // Make sure we will not crash on wrong object
    if (!req || !req.headers) req = { headers: {} };

    // Extract all signature components from the request
    var sig = this.getSignature(req);

    // Sanity checks, required headers must be present and not empty
    if (!sig.method || !sig.host) {
        return callback({ status: 415, message: "Invalid request", code: "NOMETHOD" });
    }

    // Bad or empty signature result in empty login
    if (!sig.login) {
        return callback({ status: 417, message: "No login provided", code: "NOLOGIN" });
    }

    // Make sure the request is not expired, it must be in milliseconds
    if (sig.expires < now - this.signatureAge) {
        var msg = req.__("Expired request, check your clock, the server time is %s, your clock is %s",
                         lib.strftime(now, "%m/%d/%Y %H:%M:%S GMT", { utc: 1 }),
                         lib.strftime(sig.expires, "%m/%d/%Y %H:%M:%S GMT", { utc: 1 }));
        return callback({ status: 406, message: msg, code: "EXPIRED" });
    }

    // Check the signature version consistency, do not accept wrong signatures in the unexpected places
    if ((sig.version == 2 && sig.source != "s") ||
        (sig.version == 3 && sig.source != "t") ||
        (sig.version == 4 && sig.source) ||
        (!sig.version && sig.source) ||
        (sig.version == -1 && sig.source != "l")) {
        return callback({ status: 416, message: "Invalid request", code: "NOSRC" });
    }

    // Verify if the access key is valid, they all are cached so a bad cache may result in rejects
    db.get(this.authTable, { login: sig.login }, function(err, account, info) {
        if (err) return callback({ status: 500, message: String(err) });
        if (!account) return callback({ status: 401, message: "Authentication failed", code: "NOAUTH" });

        api.checkAccountSignature(req, sig, account, function(err) {
            // Maintain last access time in the cache
            if (!err && api.accessTimeInterval && info.cached && now - (account.atime || 0) > api.accessTimeInterval) {
                account.atime = now;
                db.putCache(this.authTable, account);
            }
            callback(err);
        });
    });
}

// Check account record against a incoming request signature
api.checkAccountSignature = function(req, sig, account, callback)
{
    // Account expiration time
    if (account.expires && account.expires < Date.now()) {
        return callback({ status: 412, message: "This account has expired", code: "EXPIRED" });
    }

    // Verify ACL regex if specified, test the whole query string as it appears in the request query line
    if (account.acl_deny && sig.url.match(account.acl_deny)) {
        return callback({ status: 403, message: "Access denied", code: "NOACCESS" });
    }
    if (account.acl_allow && !sig.url.match(account.acl_allow)) {
        logger.debug("checkAccountSignature:", account.id, account.name, sig.url, account.acl_allow);
        return callback({ status: 403, message: "Not permitted", code: "NOACCESS" });
    }

    // Deal with encrypted body, use our account secret to decrypt, this is for raw data requests
    // if it is JSON or query it needs to be reparsed in the application
    if (req.body && req.get("content-encoding") == "encrypted") {
        req.body = lib.decrypt(account.secret, req.body);
    }

    // Now we can proceed with signature verification, all other conditions are met
    this.verifySignature(req, sig, account, (sig) => {
        if (!sig) {
            api.clearSessionSignature(req);
            return callback({ status: 401, message: "Authentication failed", code: "NOAUTH" });
        }
        // We do not need the raw query string anymore, it can be quite big and it is already in req.query
        delete sig.query;

        // Cleanup not allowed parameters
        if (account.query_deny) {
            var rx = new RegExp(account.opts_deny, "i");
            for (var p in req.query) {
                if (rx.test(p)) delete req.query[p];
            }
            if (req.query != req.body) {
                for (const p in req.body) {
                    if (rx.test(p)) delete req.body[p];
                }
            }
        }

        // Save account and signature in the request, it will be used later
        req.signature = sig;
        this.setCurrentAccount(req, account);
        callback({ status: this.authStatus, message: this.authMessage });
    });
}

// Assign or clear the current account record for the given request, if account is null the account is cleared
api.setCurrentAccount = function(req, account)
{
    if (!req) return;
    if (!req.account) req.account = {};
    if (!req.options) req.options = {};
    if (account === null) {
        req.account = {};
        req.options.account = {};
    } else
    if (account && account.id) {
        for (var p in account) req.account[p] = account[p];
        req.options.account = lib.objNew("id", account.id, "login", account.login, "name", account.name, "type", account.type);
    }
}

// Perform URL based access checks, this is called before the signature verification, very early in the request processing step.
//
// Checks access permissions, calls the callback with the following argument:
// - nothing if checkRequestSignature needs to be called
// - an object with status: 200 to skip authorization and proceed with other routes
// - an object with status: 0 means response has been sent, just stop
// - an object with status other than 0 or 200 to return the status and stop request processing,
//    for statuses 301,302 there should be url property in the object returned
api.checkAccess = function(req, callback)
{
    var rc = null;
    if (this.denyIp.rx && this.denyIp.rx.test(req.options.ip)) return callback({ status: 403, message: "Access denied", code: "DENY" });
    if (this.checkAcl(this.deny, this.denyAcl, req.options)) return callback({ status: 403, message: "Access denied", code: "DENY" });

    // Save the status and check the hooks, if no returns anything use it
    if (this.allowIp.rx && this.allowIp.rx.test(req.options.ip)) rc = { status: 200, message: "" };
    if (this.checkAcl(this.allow, this.allowAcl, req.options)) rc = { status: 200, message: "" };
    if (rc && rc.status == 200 && this.checkAcl(this.ignoreAllow, this.ignoreAllowAcl, req.options)) rc = null;

    // Call custom access handler for the endpoint
    var hooks = this.findHook('access', req.method, req.options.path);
    if (hooks.length) {
        lib.forEachSeries(hooks, function(hook, next) {
            logger.debug('checkAccess:', req.method, req.options.path, hook.path);
            hook.callback.call(api, req, next);
        }, function(status) {
            logger.debug("checkAccess:", req.method, req.options.path, status, rc);
            callback(status || rc);
        });
        return;
    }
    logger.debug("checkAccess:", req.method, req.options.path, rc);
    callback(rc);
}

// Perform authorization checks after the account been checked for valid signature, this is called even if the signature verification failed,
// in case of a custom authentication middlware this must be called at the end and use the status object returned in the callback to
// return an error or proceed with the request. In any case the result of this function is final.
//
// If a user has valid login by default access to all API endpoints is granted, to restrict access to specific APIs use any combinations of
// `api-allow` or `api-deny` config parameters.
//
// - req is Express request object
// - status contains the signature verification status, an object with status: and message: properties, can not be null.
//    The status property is passed to each hook in the chain, the result status will be returned to the client.
// - callback is a function(status) to be called with the resulted status where status must be an object with status and message properties as well
api.checkAuthorization = function(req, status, callback)
{
    // Ignore no login error if allowed
    if (status && status.status == 417 && this.checkAcl(this.allowAnonymous, this.allowAclAnonymous, req.options)) status = null;
    // Status for hooks is never null
    if (!status) status = { status: this.authStatus, message: this.authMessage };

    // Disable access to endpoints if session exists, meaning Web app
    if (req.signature && req.signature.source == "s" && this.checkAcl(this.disableSession, this.disableSessionAcl, req.options)) {
        logger.debug("checkAuthorization:", "disableSession:", req.account.id, req.account.name, req.account.type, req.options.path, this.disableSession.list, this.disableSessionAcl);
        return this.checkAuthHooks(req, { status: 401, message: "Not authorized", code: "DISABLED" }, callback);
    }

    // Verify access by account type
    if (!this.checkAccountType(req.account, "admin")) {
        // Admin only
        if (this.checkAcl(this.allowAdmin, this.alowAclAdmin, req.options)) {
            logger.debug("checkAuthorization:", "allowAdmin:", req.account.id, req.account.name, req.account.type, req.options.path, this.allowAdmin.list, this.alowAclAdmin);
            return this.checkAuthHooks(req, { status: 401, message: "Restricted access", code: "ADMIN" }, callback);
        }
        var rc = this.checkAclDeny(req);
        if (rc) return this.checkAuthHooks(req, rc, callback);

        // Authenticated only below
        if (req.account.id && this.checkAcl(this.allowAuthenticated, this.allowAclAuthenticated, req.options)) {
            logger.debug("checkAuthorization:", "allowAuthenticated:", req.account.id, req.account.name, req.account.type, req.options.path, this.allowAuthenticated.list, this.allowAclAuthenticated);
            status = { status: 200, message: "ok" };
        } else {
            // Check for exclusive urls first
            rc = this.checkAclOnly(req);
            if (rc) return this.checkAuthHooks(req, rc, callback);

            // Must satisfy at least one account type
            rc = api.checkAclAllow(req);

            // If the default is allow we only reject if matched but allowed
            if (this.authStatus < 400 && rc.matched.length && !rc.allow) {
                return this.checkAuthHooks(req, { status: 401, message: "Access is not allowed", code: "ALLOW" }, callback);
            }
            // If the default is reject we need explicit allow
            if (this.authStatus >= 400 && rc.allow) {
                status = { status: 200, message: "ok" };
            }
        }
    }
    this.checkAuthHooks(req, status, callback);
}

api.checkAclAllow = function(req)
{
    var rc = { allow: "", matched: [] };
    for (const p in this.allowAccount) {
        if (!this.allowAccount[p].rx || !this.allowAccount[p].rx.test(req.options.path)) continue;
        rc.matched.push(p);
        if (lib.isFlag(req.account.type, p)) {
            rc.allow = p;
            break;
        }
    }
    if (!rc.allow.length) {
        for (const p in this.allowAcl) {
            if (!this.acl[p].rx || !this.acl[p].rx.test(req.options.path)) continue;
            rc.matched.push(p);
            if (lib.isFlag(req.account.type, this.allowAcl[p])) {
                rc.allow = p;
                break;
            }
        }
    }
    logger.debug("checkAuthorization:", "allowAccount:", req.account.id, req.account.name, req.account.type, req.options.path, this.authStatus, rc);
    return rc;
}

api.checkAclDeny = function(req)
{
    if (req.account.id && this.checkAcl(this.denyAuthenticated, this.denyAclAuthenticated, req.options)) {
        logger.debug("checkAuthorization:", "denyAuthenticated:", req.account.id, req.account.name, req.account.type, req.options.path, this.denyAuthenticated.list, this.denyAclAuthenticated);
        return { status: 401, message: "Access denied", code: "DENY" };
    }
    for (const i in req.account.type) {
        var p = req.account.type[i];
        if (this.checkAcl(this.denyAccount[p], this.denyAcl[p], req.options)) {
            logger.debug("checkAuthorization:", "denyAccount:", req.account.id, req.account.name, req.account.type, req.options.path, this.denyAccount[p] && this.denyAccount[p].list, this.denyAcl[p]);
            return { status: 401, message: "Access denied", code: "DENY" };
        }
    }
}

api.checkAclOnly = function(req)
{
    var matched = [];
    for (const p in this.onlyAccount) {
        if (!this.onlyAccount[p].rx || !this.onlyAccount[p].rx.test(req.options.path)) continue;
        if (lib.isFlag(req.account.type, p)) return { status: 200, message: "ok" };
        matched.push(p);
    }
    for (const p in this.onlyAcl) {
        if (!this.acl[p].rx || !this.acl[p].rx.test(req.options.path)) continue;
        if (lib.isFlag(req.account.type, this.onlyAcl[p])) return { status: 200, message: "ok" };
        matched.push(p);
    }
    if (matched.length) {
        logger.debug("checkAuthorization:", "onlyAccount:", req.account.id, req.account.name, req.account.type, req.options.path, "matched:", matched);
        return { status: 401, message: "Access denied", code: "ONLY" };
    }
}

api.checkAcl = function(rx, acl, options)
{
    return (rx && rx.rx && rx.rx.test(options.path)) ||
           (Array.isArray(acl) && acl.some((x) => (api.acl[x] && api.acl[x].rx && api.acl[x].rx.test(options.path))));
}

api.checkAuthHooks = function(req, status, callback)
{
    if (status.status >= 401 && status.status < 500) {
        var loc = this.checkRedirectRules(req, req.options, "loginRedirect");
        if (loc) return callback(loc);
    }
    var hooks = this.findHook('auth', req.method, req.options.path);
    if (!hooks.length) return callback(status);

    lib.forEachSeries(hooks, function(hook, next) {
        logger.debug('checkAuthHooks:', req.method, req.options.path, hook.path, req.account.id, status);
        hook.callback.call(api, req, status, function(err) {
            if (err && typeof err.status == "number") status = err;
            next();
        });
    }, function() {
        callback(status);
    });
}

// Check login and secret from a client
api.checkLogin = function(req, callback)
{
    // Make sure we will not crash on wrong object
    if (!req || !req.query) req = { query: {}, headers: {} };

    // Required values must be present and not empty
    if (!req.query.login || !req.query.secret) {
        return callback({ status: 417, message: "No username or password provided", code: "NOLOGIN" });
    }
    // Create internal signature from the login data
    req.signature = this.newSignature(req, "version", -1, "source", "l", "login", req.query.login, "secret", req.query.secret);
    delete req.query.login;
    delete req.query.secret;
    this.checkRequestSignature(req, callback);
}
