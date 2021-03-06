//
// Vlad Seryakov 2014
//

// Status of the current account
bkjs.koAuth = ko.observable(0);
bkjs.koAdmin = ko.observable(0);
bkjs.koState = {};
bkjs.koTemplate = {};

bkjs.koInit = function()
{
    ko.applyBindings(bkjs);
    bkjs.login(function(err) {
        bkjs.checkLogin(err);
    });
}

bkjs.checkLogin = function(err)
{
    bkjs.koAuth(bkjs.loggedIn);
    bkjs.koAdmin(bkjs.loggedIn && bkjs.checkAccountType(bkjs.account, bkjs.adminType || "admin"));
    $(bkjs).trigger(bkjs.loggedIn ? "bkjs.login" : "bkjs.nologin", err);
    if (!err && typeof bkjs.koShow == "function") bkjs.koShow();
}

bkjs.koLogin = function(data, event)
{
    bkjs.showLogin(bkjs.koLoginOptions, function(err) {
        bkjs.checkLogin(err);
        if (!err) bkjs.hideLogin();
    });
}

bkjs.koLogout = function(data, event)
{
    bkjs.logout(function() {
        bkjs.koAuth(0);
        bkjs.koAdmin(0);
        $(bkjs).trigger('bkjs.logout');
        if (bkjs.koLogoutUrl) window.location.href = bkjs.koLogoutUrl;
    });
}

bkjs.koGet = function(name, dflt)
{
    if (typeof name != "string") name = String(name);
    name = name.replace(/[^a-zA-z0-9_]/g, "_");
    var val = bkjs.koState[name];
    if (typeof val == "undefined") {
        bkjs.koState[name] = val = Array.isArray(dflt) ? ko.observableArray(dflt) : ko.observable(dflt);
    }
    return val;
}

bkjs.koSet = function(name, val)
{
    if (!name) return;
    if (!Array.isArray(name)) name = [ name ];
    for (var i in name) {
        var key = name[i];
        if (typeof key != "string") continue;
        key = key.replace(/[^a-zA-z0-9_]/g, "_");
        if (ko.isObservable(bkjs.koState[key])) {
            bkjs.koState[key](val);
        } else {
            bkjs.koState[key] = Array.isArray(val) ? ko.observableArray(val) : ko.observable(val);
        }
    }
}

bkjs.koSetObject = function(obj, options)
{
    if (!obj || typeof obj != "object") obj = {};
    for (var p in obj) {
        if (typeof options[p] != "undefined") continue;
        if (ko.isObservable(obj[p])) obj[p](undefined); else obj[p] = undefined;
    }
    for (var p in options) {
        if (ko.isObservable(obj[p])) obj[p](options[p]); else obj[p] = options[p];
    }
    return obj;
}

bkjs.koEvent = function(name, data)
{
    var event = bkjs.toCamel(name);
    event = "on" + event.substr(0, 1).toUpperCase() + event.substr(1);
    $(bkjs).trigger("bkjs.event", [name, event, data]);
}

bkjs.koModel = function(params)
{
    this.params = {};
    for (var p in params) this.params[p] = params[p];
    $(bkjs).on("bkjs.event", $.proxy(this._handleEvent, this));
}

bkjs.koModel.prototype._handleEvent = function(ev, name, event, data)
{
    if (typeof this[event] == "function") this[event](data);
    if (typeof this.handleEvent == "function") this.handleEvent(name, data);
}

bkjs.koModel.prototype.dispose = function()
{
    delete this.params;
    bkjs.koEvent("model.disposed", this._name);
    $(bkjs).off("bkjs.event", $.proxy(this._handleEvent, this));
    if (typeof this.onDispose == "function") this.onDispose();
}

bkjs.koCreateModel = function(name)
{
    if (!name) throw "model name is required";
    var model = function(params) {
        this._name = name;
        bkjs.koModel.call(this, params);
        if (typeof this.onInit == "function") this.onInit();
    };
    bkjs.inherits(model, bkjs.koModel);
    bkjs.koEvent("model.created", name);
    return model;
}

bkjs.koFindModel = function(name)
{
    name = bkjs.toCamel(name);
    return bkjs.koTemplate[name] ? { template: bkjs.koTemplate[name], viewModel: bkjs[name + "Model"] } : null;
}


ko.bindingHandlers.hidden = {
    update: function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        var isCurrentlyHidden = !(element.style.display == "");
        if (value && !isCurrentlyHidden) element.style.display = "none"; else
        if ((!value) && isCurrentlyHidden) element.style.display = "";
    }
};

// Web bundle naming convention
ko.components.loaders.unshift({
    getConfig: function(name, callback) {
        callback(bkjs.koFindModel(name));
    }
});

