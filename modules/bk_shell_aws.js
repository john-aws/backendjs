//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const util = require('util');
const core = require(__dirname + '/../lib/core');
const lib = require(__dirname + '/../lib/lib');
const logger = require(__dirname + '/../lib/logger');
const aws = require(__dirname + '/../lib/aws');
const shell = require(__dirname + '/bk_shell');

shell.help.push("-aws-s3-get -path PATH - retrieve a file from S3");
shell.help.push("-aws-s3-put -path PATH -file FILE - store a file to S3");
shell.help.push("-aws-s3-list -path PATH [-filter PATTERN] [-sort version|file|size|date|mtime] [-fmt obj|path] [-start NUM] [-count NUM] - list contents of a S3 folder");
shell.help.push("-aws-show-amazon-images [-filter PATTERN] [-arch ARCH] [-rootdev ebs|instance-store|*] [-devtype gp2|io1|standard|*] - show Amazon Linux AMIs (use %2A instead of *)");
shell.help.push("-aws-show-images [-filter PATTERN] - show my account AMIs by name pattern");
shell.help.push("-aws-delete-image -filter PATTERN [-dry-run] - delete all AMIs that match the given name filter");
shell.help.push("-aws-create-image [-name NAME] [-descr DESCR] [-no-reboot] [-reboot] [-instance-id ID] [-dry-run] - create a new AMI from the instance by id or the current instance");
shell.help.push("-aws-launch-instances [-count NUM] [-image-name PATTERN] [-name NAME] [-group-name PATTERN] [-subnet-name PATTERN] [-subnet-split] [-subnet-each] [-user-data TEXT] [-alarm-name NAME] [-host-name HOST] [-bkjs-cmd NAME] [-cloudinit-cmd CMD] [-wait] [wait-timeout MSECS] [-wait-delay MSECS] [-dry-run] - start instance(s), the app name from the package.json is used as the base for all other resources unless explicitely defined in the command line");
shell.help.push("-aws-reboot-instances -filter PATTERN [-dry-run] - reboot instances by tag pattern");
shell.help.push("-aws-terminate-instances -filter PATTERN [-count NUM] [-dry-run] - terminate instances by tag pattern");
shell.help.push("-aws-show-instances [-filter PATTERN] [-show-ip] - show running instances by tag pattern");
shell.help.push("-aws-show-elb -elb-name NAME [-filter PATTERN] - show instances for an ELB");
shell.help.push("-aws-reboot-elb -elb-name NAME [-timeout MSECS] [-interval MSECS] [-dry-run]");
shell.help.push("-aws-replace-elb -elb-name NAME [-timeout MSECS] [-interval MSECS] [-dry-run]");
shell.help.push("-aws-setup-ssh -group-name NAME [-close] [-dry-run]");
shell.help.push("-aws-setup-instance [-cmd CMD] [-file FILE ] [-wait] [-dry-run]");
shell.help.push("-aws-create-launch-config [-name NAME] [-config-name NAME] [-instance-name NAME] [-update-groups] [-dry-run] - create a launch configuration for autoscaling, can copy from an instance or other existing config, optinally update all ASGs with new config name");
shell.help.push("-aws-create-launch-template-version -name NAME [-version N] [-default] [-dry-run] - create a launch template version with the most recent AMI");
shell.help.push("-aws-set-route53 -name HOSTNAME [-current] [-filter PATTERN] [-type A|CNAME] [-ttl N] [-public] [-dry-run] - create or update a Route53 record of specified type with IP/hostnames of all instances that satisfy the given filter, -public makes it use public IP/hostnames");
shell.help.push("-aws-check-cfn -file FILE - verify a CF template");
shell.help.push("-aws-create-cfn -name NAME -file FILE [-aws-region REGION] [-retain] [-wait] [-PARAM VALUE] ...");
shell.help.push("-aws-wait-cfn -name NAME [-aws-region REGION] - wait for the given CF stack to be completed");
shell.help.push("-aws-show-cfn-events -name NAME [-aws-region REGION] - show events for the given stack");

// Check all names in the tag set for given name pattern(s), all arguments after 0 are checked
shell.awsCheckTags = function(obj, name)
{
    var tags = lib.objGet(obj, "tagSet.item", { list: 1 });
    if (!tags.length) return false;
    for (var i = 1; i < arguments.length; i++) {
        if (!arguments[i]) continue;
        var rx = new RegExp(String(arguments[i]), "i");
        if (tags.some(function(t) { return t.key == "Name" && rx.test(t.value); })) return true;
    }
    return false;
}

// Return matched subnet ids by availability zone and/or name pattern
shell.awsFilterSubnets = function(subnets, zone, name)
{
    return subnets.filter(function(x) {
        if (zone && zone != x.availablityZone && zone != x.availabilityZone.split("-").pop()) return 0;
        return name ? shell.awsCheckTags(x, name) : 1;
    }).map(function(x) {
        return x.subnetId;
    });
}

// Retrieve my AMIs for the given name pattern
shell.awsGetSelfImages = function(name, callback)
{
    aws.queryEC2("DescribeImages",
                 { 'Owner.0': 'self',
                   'Filter.1.Name': 'name',
                   'Filter.1.Value': name
                 }, function(err, rc) {
        if (err) return callback(err);
        var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
        // Sort by version in descending order, assume name-N.N.N naming convention
        images = lib.sortByVersion(images, "name");
        callback(null, images);
    });
}

// Return an image that matches given app name latest version
shell.awsSearchImage = function(filter, appName, callback)
{
    var img;

    this.awsGetSelfImages(filter, function(err, rc) {
        if (err) return callback(err);

        // Give preference to the images with the same app name
        if (rc.length) {
            var rx = new RegExp("^" + appName, "i");
            for (var i = 0; i < rc.length && !img; i++) {
                if (rc[i].name.match(rx)) img = rc[i];
            }
            if (!img) img = rc[0];
        }
        callback(err, img);
    });
}

// Return Amazon AMIs for the current region, HVM type only
shell.awsGetAmazonImages = function(options, callback)
{
    var query = { 'Owner.0': 'amazon',
        'Filter.1.Name': 'name',
        'Filter.1.Value': options.filter || 'amzn-ami-hvm-*',
        'Filter.2.Name': 'architecture',
        'Filter.2.Value': options.arch || 'x86_64',
        'Filter.3.Name': 'root-device-type',
        'Filter.3.Value': options.rootdev || 'ebs',
        'Filter.4.Name': 'block-device-mapping.volume-type',
        'Filter.4.Value': options.devtype || 'gp2',
    };
    if (this.isArg("-dry-run", options)) {
        logger.log("getAmazonImages:", query);
        return callback(null, []);
    }
    aws.queryEC2("DescribeImages", query, function(err, rc) {
        if (err) return callback(err);
        var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
        images.sort(function(a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0 });
        callback(null, images);
    });
}

// Wait ELB to have instance count equal or not to the expected total
shell.awsGetElbCount = function(name, equal, total, options, callback)
{
    var running = 1, count = 0, expires = Date.now() + (options.timeout || 180000);

    lib.doWhilst(
        function(next) {
            aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: name }, function(err, rc) {
                if (err) return next(err);
                count = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 }).filter(function(x) { return x.State == "InService"}).length;
                logger.log("awsGetElbCount:", name, "checking(" + (equal ? "=" : "<>") + "):", "in-service", count, "out of", total);
                if (equal) {
                    running = total == count && Date.now() < expires;
                } else {
                    running = total != count && Date.now() < expires;
                }
                setTimeout(next, running ? (options.interval || 5000) : 0);
            });
        },
        function() {
            return running;
        },
        function(err) {
            callback(err, total, count);
        });
}

shell.awsGetUserData = function(options)
{
    var userData = this.getArg("-user-data", options);
    if (!userData || userData.match(/^#cloud-config/)) {
        var cloudInit = "";
        var runCmd = this.getArgList("-cloudinit-cmd", options);
        if (runCmd.length) cloudInit += "runcmd:\n" + runCmd.map(function(x) { return " - " + x }).join("\n") + "\n";
        var hostName = this.getArg("-host-name", options);
        if (hostName) cloudInit += "hostname: " + hostName + "\n";
        var user = this.getArg("-user", options, "ec2-user");
        var bkjsCmd = this.getArgList("-bkjs-cmd", options);
        if (bkjsCmd.length) cloudInit += "runcmd:\n" + bkjsCmd.map(function(x) { return " - /home/" + user + "/bin/bkjs " + x }).join("\n") + "\n";
        if (cloudInit) userData = !userData ? "#cloud-config\n" + cloudInit : "\n" + cloudInit;
    }
    return userData;
}

// Launch instances by run mode and/or other criteria
shell.awsLaunchInstances = function(options, callback)
{
    var subnets = [], instances = [];
    var appName = this.getArg("-app-name", options, core.appName);
    var appVersion = this.getArg("-app-version", options, core.appVersion);

    var req = {
        name: this.getArg("-name", options, appName + "-" + appVersion),
        count: this.getArgInt("-count", options, 1),
        vpcId: this.getArg("-vpc-id", options, aws.vpcId),
        instanceType: this.getArg("-instance-type", options, aws.instanceType),
        imageId: this.getArg("-image-id", options, aws.imageId),
        subnetId: this.getArg("-subnet-id", options, aws.subnetId),
        keyName: this.getArg("-key-name", options, aws.keyName) || appName,
        elbName: this.getArg("-elb-name", options, aws.elbName),
        elasticIp: this.getArg("-elastic-ip", options),
        publicIp: this.isArg("-public-ip", options),
        groupId: this.getArg("-group-id", options, aws.groupId),
        iamProfile: this.getArg("-iam-profile", options, aws.iamProfile) || appName,
        availabilityZone: this.getArg("-availability-zone"),
        terminate: this.isArg("-no-terminate", options) ? 0 : 1,
        alarms: [],
        data: this.awsGetUserData(options),
    };
    logger.debug("awsLaunchInstances:", req);

    lib.series([
       function(next) {
           if (req.imageId) return next();
           var imageName = shell.getArg("-image-name", options, '*');
           shell.awsSearchImage(imageName, appName, function(err, ami) {
               req.imageId = ami && ami.imageId;
               next(err ? err : !req.imageId ? "ERROR: AMI must be specified or discovered by filters" : null);
           });
       },
       function(next) {
           if (req.groupId) return next();
           var filter = shell.getArg("-group-name", options, appName + "|^default$");
           aws.ec2DescribeSecurityGroups({ filter: filter }, function(err, rc) {
               if (!err) req.groupId = rc.map(function(x) { return x.groupId });
               next(err);
           });
       },
       function(next) {
           // Verify load balancer name
           if (shell.isArg("-no-elb", options)) return next();
           aws.queryELB("DescribeLoadBalancers", {}, function(err, rc) {
               if (err) return next(err);

               var list = lib.objGet(rc, "DescribeLoadBalancersResponse.DescribeLoadBalancersResult.LoadBalancerDescriptions.member", { list: 1 });
               if (req.elbName) {
                   if (!list.filter(function(x) { return x.LoadBalancerName == req.elbName }).length) return next("ERROR: Invalid load balancer " + aws.elbName);
               } else {
                   req.elbName = list.filter(function(x) { return x.LoadBalancerName.match("^" + appName) }).map(function(x) { return x.LoadBalancerName }).pop();
               }
               next();
           });
       },
       function(next) {
           // Create CloudWatch alarms, find SNS topic by name
           var alarmName = shell.getArg("-alarm-name", options);
           if (!alarmName) return next();
           aws.snsListTopics(function(err, topics) {
               var topic = new RegExp(alarmName, "i");
               topic = topics.filter(function(x) { return x.match(topic); }).pop();
               if (!topic) return next(err);
               req.alarms.push({ metric:"CPUUtilization",
                               threshold: shell.getArgInt("-cpu-threshold", options, 80),
                               evaluationPeriods: shell.getArgInt("-periods", options, 3),
                               alarm:topic });
               req.alarms.push({ metric:"NetworkOut",
                               threshold: shell.getArgInt("-net-threshold", options, 10000000),
                               evaluationPeriods: shell.getArgInt("-periods", options, 3),
                               alarm:topic });
               req.alarms.push({ metric:"StatusCheckFailed",
                               threshold: 1,
                               evaluationPeriods: 2,
                               statistic: "Maximum",
                               alarm:topic });
               next(err);
           });
       },
       function(next) {
           if (req.subnetId) return next();
           var params = req.vpcId ? { "Filter.1.Name": "vpc-id", "Filter.1.Value": req.vpcId } : {};
           aws.queryEC2("DescribeSubnets", params, function(err, rc) {
               subnets = lib.objGet(rc, "DescribeSubnetsResponse.subnetSet.item", { list: 1 });
               next(err);
           });
       },
       function(next) {
           var zone = shell.getArg("-zone");
           if (req.subnetId) {
               subnets.push(req.subnetId);
           } else
           // Same amount of instances in each subnet
           if (shell.isArg("-subnet-each", options)) {
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
           } else
           // Split between all subnets
           if (shell.isArg("-subnet-split", options)) {
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
               if (count <= subnets.length) {
                   subnets = subnets.slice(0, count);
               } else {
                   var n = subnets.length;
                   for (var i = count - n; i > 0; i--) subnets.push(subnets[i % n]);
               }
               options.count = 1;
           } else {
               // Random subnet
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
               lib.shuffle(subnets);
               subnets = subnets.slice(0, 1);
           }
           if (!subnets.length) return next("ERROR: subnet must be specified or discovered by filters");

           lib.forEachLimit(subnets, subnets.length, function(subnet, next2) {
               req.subnetId = subnet;
               logger.log("awsLaunchInstances:", req);
               if (shell.isArg("-dry-run", options)) return next2();

               aws.ec2RunInstances(req, function(err, rc) {
                   if (err) return next2(err);
                   instances = instances.concat(lib.objGet(rc, "RunInstancesResponse.instancesSet.item", { list: 1 }));
                   next2();
               });
           }, next);
       },
       function(next) {
           if (instances.length) logger.log(instances.map(function(x) { return [ x.instanceId, x.privateIpAddress || "", x.publicIpAddress || "" ] }));
           if (!shell.isArg("-wait", options)) return next();
           if (instances.length != 1) return next();
           aws.ec2WaitForInstance(instances[0].instanceId, "running",
                                  { waitTimeout: shell.getArgInt("-wait-timeout", options, 600000),
                                    waitDelay: shell.getArgInt("-wait-delay", options, 30000) },
                                  next);
       },
    ], callback);
}

// Delete an AMI with the snapshot
shell.cmdAwsLaunchInstances = function(options)
{
    this.awsLaunchInstances(options, function(err) {
        shell.exit(err);
    });
}

shell.cmdAwsShowImages = function(options)
{
    var filter = this.getArg("-filter", options);

    this.awsGetSelfImages(filter || "*", function(err, images) {
        if (err) shell.exit(err);
        images.forEach(function(x) {
            console.log(x.imageId, x.name, x.imageState, x.description);
        });
        shell.exit();
    });
}

shell.cmdAwsShowAmazonImages = function(options)
{
    options.filter = this.getArg("-filter", options);
    options.rootdev = this.getArg("-rootdev", options);
    options.devtype = this.getArg("-devtype", options);
    options.arch = this.getArg("-arch", options);

    this.awsGetAmazonImages(options, function(err, images) {
        if (err) shell.exit(err);
        images.forEach(function(x) {
            console.log(x.imageId, x.name, x.imageState, x.description);
        });
        shell.exit();
    });
}

shell.cmdAwsShowGroups = function(options)
{
    options.filter = this.getArg("-filter", options);
    options.name = this.getArg("-name", options);

    aws.ec2DescribeSecurityGroups(options, function(err, images) {
        images.forEach(function(x) {
            console.log(x.groupId, x.groupName, x.groupDescription);
        });
        shell.exit();
    });
}

// Delete an AMI with the snapshot
shell.cmdAwsDeleteImage = function(options)
{
    var filter = this.getArg("-filter", options);
    if (!filter) shell.exit("-filter is required");
    var images = [];

    lib.series([
       function(next) {
           shell.awsGetSelfImages(filter, function(err, list) {
               if (!err) images = list;
               next(err);
           });
       },
       // Deregister existing image with the same name in the destination region
       function(next) {
           logger.log("DeregisterImage:", images);
           if (this.isArg("-dry-run", options)) return next();
           lib.forEachSeries(images, function(img, next2) {
               aws.ec2DeregisterImage(img.imageId, { snapshots: 1 }, next2);
           }, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Create an AMI from the current instance of the instance by id
shell.cmdAwsCreateImage = function(options)
{
    options.name = this.getArg("-name", options);
    options.descr = this.getArg("-descr", options);
    options.instanceId = this.getArg("-instance-id", options);
    options.noreboot = this.isArg("-no-reboot", options);
    options.reboot = this.isArg("-reboot", options);
    options.interval = this.getArgInt("-interval", options, 5000);
    if (this.isArg("-dry-run", options)) return shell.exit(null, options);
    var imgId;
    lib.series([
       function(next) {
           aws.ec2CreateImage(options, function(err, rc) {
               imgId = lib.objGet(rc, "CreateImageResponse.imageId");
               next(err);
           });
       },
       function(next) {
           if (!imgId || !shell.isArg("-wait", options)) return next();
           var running = 1, expires = Date.now() + shell.getArgInt("-timeout", options, 300000);
           lib.doWhilst(
             function(next) {
                 aws.queryEC2("DescribeImages", { "ImageId.1": imgId }, function(err, rc) {
                     if (err) return next(err);
                     var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
                     running = (images.length && images[0].imageState == "available") || Date.now() > expires ? 0 : 1;
                     setTimeout(next, running ? options.interval : 0);
                 });
             },
             function() {
                 return running;
             },
             function(err) {
                 next(err);
             });
       },
    ], function(err) {
        if (imgId) console.log(imgId);
        shell.exit(err);
    });
}

shell.cmdAwsCopyImage = function(options)
{
    var region = this.getArg("-region", options);
    if (!region) shell.exit("-region is required");
    var imageName = shell.getArg("-image-name", options, '*');
    var appName = this.getArg("-app-name", options, core.appName);
    var imageId;

    lib.series([
      function(next) {
          shell.awsSearchImage(imageName, appName, function(err, ami) {
              imageId = ami && ami.imageId;
              imageName = ami && mi.imageName;
              next(err ? err : imageId ? "ERROR: AMI must be specified or discovered by filters" : null);
          });
      },
      // Deregister existing image with the same name in the destination region
      function(next) {
          aws.queryEC2("DescribeImages", { 'ImageId.1': imageId  }, { region: region }, function(err, rc) {
              if (err) return next(err);
              images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
              if (!images.length) return next();
              logger.log("Will deregister existing AMI with the same name", region, images[0].imageName, images[0].imageId, "...");
              if (shell.isArg("-dry-run", options)) return next();
              aws.ec2DeregisterImage(images[0].imageId, { snapshots: 1, region: region }, next);
          });
      },
      function(next) {
          var req = { SourceRegion: aws.region || 'us-east-1', SourceImageId: imageId, Name: imageName };
          logger.log("CopyImage:", req)
          if (shell.isArg("-dry-run", options)) return next();
          aws.queryEC2("CopyImage", req, { region: region }, function(err, rc) {
              if (err) return next(err);
              var id = lib.objGet(rc, "CopyImageResponse.imageId");
              if (id) logger.log("CopyImage:", id);
              next();
          });
      },
    ], function(err) {
        shell.exit(err);
    });
}

// Reboot instances by run mode and/or other criteria
shell.cmdAwsRebootInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter", options);
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list.map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) shell.exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("RebootInstances:", req)
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Terminate instances by run mode and/or other criteria
shell.cmdAwsTerminateInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter", options);
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list.map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("TerminateInstances:", req)
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Show running instances by run mode and/or other criteria
shell.cmdAwsShowInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter", options);
    var col = this.getArg("-col", options);

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list;
               next(err);
           });
       },
       function(next) {
           logger.debug("showInstances:", instances);
           if (col) {
               var map = { priv: "privateIpAddress", ip: "ipAddress", id: "instanceId", name: "name", key: "keyName" }
               console.log(instances.map(function(x) { return lib.objDescr(x[map[col] || col]) }).join(" "));
           } else {
               instances.forEach(function(x) { console.log(x.instanceId, x.subnetId, x.privateIpAddress, x.ipAddress, x.name, x.keyName); });
           }
           next();
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Update a Route53 record with IP/names of all instances specified by the filter
shell.cmdAwsSetRoute53 = function(options)
{
    var name = this.getArg("-name", options);
    if (!name) shell.exit("ERROR: -name must be specified and must be a full host name")
    var filter = this.getArg("-filter", options);
    var type = this.getArg("-type", options, "A");
    var ttl = this.getArg("-ttl", options);
    var public = this.isArg("-public", options);
    var current = this.isArg("-current", options);
    var values = [];

    lib.series([
       function(next) {
           if (current) return next();
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               values = list.map(function(x) {
                   switch (type) {
                   case "A":
                       return public ? x.ipAddress || x.publicIpAddress : x.privateIpAddress;
                   case "CNAME":
                       return public ? x.publicDnsName : x.privateDnsName;
                   }
               }).filter(function(x) { return x });
               next(err);
           });
       },
       function(next) {
           if (!values.length && !current) return next();
           var host = lib.toTemplate(name, core.instance);
           logger.log("setRoute53:", name, host, type, values, core.ipaddr);
           if (shell.isArg("-dry-run", options)) return next();
           aws.route53Change(current ? host : { name: host, type: type, ttl: ttl, value: values }, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Show ELB running instances
shell.cmdAwsShowElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var instances = [];
    var filter = this.getArg("-filter", options);

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               instances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 });
               next();
           });
       },
       function(next) {
           var req = { instanceId: instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId }) };
           aws.ec2DescribeInstances(req, function(err, list) {
               list.forEach(function(row) {
                   instances.forEach(function(x) {
                       if (x.InstanceId == row.instanceId) x.name = row.name;
                   });
               });
               next(err);
           });
       },
       function(next) {
           // Show all instances or only for the specified version
           if (filter) {
               instances = instances.filter(function(x) { return (x.name && x.State == 'InService' && x.name.match(filter)); });
           }
           instances.forEach(function(x) {
               console.log(Object.keys(x).map(function(y) { return x[y] }).join(" | "));
           });
           next();
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Reboot instances in the ELB, one by one
shell.cmdAwsRebootElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, instances = [];
    options.timeout = this.getArgInt("-timeout", options);
    options.interval = this.getArgInt("-interval", options);

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               instances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 }).filter(function(x) { return x.State == "InService" });
               total = instances.length;
               next();
           });
       },
       function(next) {
           // Reboot first half
           if (!instances.length) return next();
           var req = {};
           instances.splice(0, Math.floor(instances.length/2)).forEach(function(x, i) {
               req["InstanceId." + (i + 1)] = x.InstanceId;
           });
           logger.log("RebootELB:", elbName, "restarting:", req)
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
       function(next) {
           if (shell.isArg("-dry-run", options)) return next();
           // Wait until one instance is out of service
           shell.awsGetElbCount(elbName, 1, total, options, next);
       },
       function(next) {
           if (shell.isArg("-dry-run", options)) return next();
           // Wait until all instances in service again
           shell.awsGetElbCount(elbName, 0, total, options, next);
       },
       function(next) {
           // Reboot the rest
           if (!instances.length) return next();
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           logger.log("RebootELB:", elbName, 'restarting:', req)
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Deploy new version in the ELB, terminate the old version
shell.cmdAwsReplaceElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, oldInstances = [], newInstances = [], oldInService = [];
    options.timeout = this.getArgInt("-timeout", options);
    options.interval = this.getArgInt("-interval", options);

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               oldInstances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 });
               oldInService = oldInstances.filter(function(x) { return x.State == "InService" });
               next();
           });
       },
       function(next) {
           logger.log("ReplaceELB:", elbName, 'running:', oldInstances)
           // Launch new instances
           shell.awsLaunchInstances(options, next);
       },
       function(next) {
           newInstances = instances;
           if (shell.isArg("-dry-run", options)) return next();
           // Wait until all instances are online
           shell.awsGetElbCount(elbName, 0, oldInService.length + newInstances.length, options, function(err, total, count) {
               if (!err && count != total) err = "Timeout waiting for instances";
               next(err);
           })
       },
       function(next) {
           // Terminate old instances
           if (!oldInstances.length) return next();
           var req = {};
           oldInstances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           logger.log("ReplaceELB:", elbName, 'terminating:', req)
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Open/close SSH access to the specified group for the current external IP address
shell.cmdAwsSetupSsh = function(options)
{
    var ip = "", groupId;
    var groupName = this.getArg("-group-name", options);
    if (!groupName) shell.exit("-group-name is required");

    lib.series([
       function(next) {
           aws.ec2DescribeSecurityGroups({}, function(err, rc) {
               if (!err && rc.length) groupId = rc[0];
               next(err);
           });
       },
       function(next) {
           if (!groupId) return next("No group is found for", groupName);
           core.httpGet("http://checkip.amazonaws.com", function(err, params) {
               if (err || params.status != 200) return next(err || params.data || "Cannot determine IP address");
               ip = params.data.trim();
               next();
           });
       },
       function(next) {
           var req = { GroupId: groupId,
               "IpPermissions.1.IpProtocol": "tcp",
               "IpPermissions.1.FromPort": 22,
               "IpPermissions.1.ToPort": 22,
               "IpPermissions.1.IpRanges.1.CidrIp": ip + "/32" };
           logger.log(req);
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryEC2(shell.isArg("-close", options) ? "RevokeSecurityGroupIngress" : "AuthorizeSecurityGroupIngress", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Launch an instance and setup it with provisioning script
shell.cmdAwsSetupInstance = function(options)
{
    var opts = {};
    var file = this.getArg("-file", options);
    var cmd = this.getArg("-cmd", options);
    if (!file && !cmd) shell.exit("-file or -cmd is required");

    lib.series([
       function(next) {
           if (!file) return next();
           opts.userData = "#cloud-config\n" +
                   "write_files:\n" +
                   "  - encoding: b64\n" +
                   "    content: " + Buffer(lib.readFileSync(file)).toString("base64") + "\n" +
                   "    path: /tmp/cmd.sh\n" +
                   "    owner: ec2-user:root\n" +
                   "    permissions: '0755'\n" +
                   "runcmd:\n" +
                   "  - [ /tmp/cmd.sh ]\n" +
                   "  - [ rm, -f, /tmp/cmd.sh ]\n";
           shell.awsLaunchInstances(opts, next);
       },
       function(next) {
           if (!cmd) return next();
           opts.userData = "#cloud-config\n" +
                   "runcmd:\n" +
                   "  - " + cmd + "\n";
           shell.awsLaunchInstances(opts, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Get file
shell.cmdAwsS3Get = function(options)
{
    var query = this.getQuery();
    var file = this.getArg("-file", options);
    var uri = this.getArg("-path", options);
    query.file = file || uri.split("?")[0].split("/").pop();
    aws.s3GetFile(uri, query, function(err, data) {
        shell.exit(err, data);
    });
}

// Put file
shell.cmdAwsS3Put = function(options)
{
    var query = this.getQuery();
    var path = this.getArg("-path", options);
    var uri = this.getArg("-file", options);
    aws.s3PutFile(uri, file, query, function(err, data) {
        shell.exit(err, data);
    });
}

// List folder
shell.cmdAwsS3List = function(options)
{
    var query = this.getQuery();
    var sort = this.getArg("-sort", options);
    var desc = this.getArg("-desc", options);
    var uri = this.getArg("-path", options);
    var fmt = this.getArg("-fmt", options);
    var filter = lib.toRegexp(this.getArg("-filter", options));
    var start = this.getArgInt("-start", options);
    var count = this.getArgInt("-count", options);
    aws.s3List(uri, query, function(err, files) {
        if (err) shell.exit(err);
        files = files.filter(function(x) {
            if (x.Key.slice(-1) == "/") return 0;
            return filter.test(x.Key);
        }).map(function(x) {
            switch (fmt) {
            case "obj":
                return { file: x.Key, date: x.LastModified, mtime: lib.toDate(x.LastModified), size: x.Size };
            case "path":
                return x.Key;
            default:
                return x.Key.split("/").pop();
            }
        });
        switch (sort) {
        case "version":
            files = lib.sortByVersion(files, "file");
            break;
        case "size":
            files.sort(function(a, b) { return desc ? b.size - a.size : a.size - b.size });
            break;
        case "mtime":
            files.sort(function(a, b) { return desc ? b.mtime - a.mtime : a.mtime - b.mtime });
            break;
        case "date":
            files.sort(function(a, b) { return desc ? b.date < a.date : a.date < b.date });
            break;
        case "file":
        case "name":
            if (fmt == "obj") {
                files.sort(function(a, b) { return desc ? b.file < a.file : a.file < b.file });
            } else {
                files.sort(function(a, b) { return desc ? b < a : a < b });
            }
            break;
        }
        if (start) files = files.slice(start);
        if (count) files = files.slice(0, count);
        for (var i in files) console.log(files[i]);
        shell.exit();
    });
}

shell.cmdAwsCheckCfn = function(options)
{
    var file = this.getArg("-file", options);
    if (!file) shell.exit("ERROR: -file is required");

    var body = lib.readFileSync(file, { json: 1, logger: "error" });
    if (!body.Resources) shell.exit("ERROR: Resources must be specified in the template");

    aws.queryCFN("ValidateTemplate", { TemplateBody: JSON.stringify(body) }, function(err, rc) {
        if (err) return shell.exit(err);
        shell.exit(null, util.inspect(rc, { depth: null }));
    });
}

shell.cmdAwsCreateCfn = function(options)
{
    var name = this.getArg("-name", options);
    if (!name) shell.exit("ERROR: -name is required");
    var file = this.getArg("-file", options);
    if (!file) shell.exit("ERROR: -file is required");

    var body = lib.readFileSync(file, { json: 1, logger: "error" });
    if (!body.Resources) shell.exit("ERROR: Resources must be specified in the template");

    // Mark all resources as Retain so when deleting the stack all resource will still be active and can be configured separately
    if (shell.isArg("-retain", options)) {
        Object.keys(body.Resources).forEach(function(x) {
            body.Resources[x].DeletionPolicy = "Retain";
        });
    }
    var req = { StackName: name };

    // Assign parameters
    Object.keys(body.Parameters).forEach(function(x, i) {
        var val = shell.getArg('-' + x, options, body.Parameters[x].Default).trim();
        if (!val && lib.toNumber(body.Parameters[x].MinLength)) shell.exit("ERROR: -" + x + " is required");
        if (!val) return;
        req['Parameters.member.' + (i + 1) + '.ParameterKey'] = x;
        req['Parameters.member.' + (i + 1) + '.ParameterValue'] = val;
    });
    for (var p in body.Resources) {
        if (body.Resources[p].Type.indexOf("AWS::IAM::") == 0) {
            req["Capabilities.member.1"] = "CAPABILITY_IAM";
            break;
        }
    }
    if (shell.isArg("-disable-rollback")) req.DisableRollback = true;
    if (shell.isArg("-rollback")) req.OnFailure = "ROLLBACK";
    if (shell.isArg("-delete")) req.OnFailure = "DELETE";
    if (shell.isArg("-do-nothing")) req.OnFailure = "DO_NOTHING";
    var role = shell.getArg("-role-arn", options);
    if (role) req.RoleARN = role;
    var policy = shell.getArg("-policy-url", options);
    if (policy) req.StackPolicyURL = policy;
    shell.getArgList("-tags", options).forEach(function(x, i) {
        req['Tags.member.' + (i + 1)] = tags[i];
    });

    logger.log(req)
    if (shell.isArg("-dry-run", options)) return shell.exit();

    req.TemplateBody = JSON.stringify(body)
    aws.queryCFN("CreateStack", req, function(err, rc) {
        if (err) return shell.exit(err);
        logger.log(util.inspect(rc, { depth: null }));
        if (!shell.isArg("-wait", options)) return shell.exit();
        shell.cmdAwsWaitCfn(options, function(err) {
            if (err) return shell.cmdAwsShowCfnEvents(options);
            shell.exit();
        });
    });
}

shell.cmdAwsWaitCfn = function(options, callback)
{
    var name = this.getArg("-name", options);
    if (!name) shell.exit("ERROR: -name is required");
    var timeout = this.getArgInt("-timeout", options, 1800);
    var interval = this.getArgInt("-interval", options, 60);

    var num = 0, expires = Date.now() + timeout * 1000, stacks = [], status = "";
    var complete = ["CREATE_COMPLETE","CREATE_FAILED",
                    "ROLLBACK_COMPLETE","ROLLBACK_FAILED",
                    "DELETE_COMPLETE","DELETE_FAILED",
                    "UPDATE_COMPLETE","UPDATE_FAILED",
                    "UPDATE_ROLLBACK_COMPLETE","UPDATE_ROLLBACK_FAILED"];

    lib.series([
      function(next) {
          // Wait for all instances to register or exit after timeout
          lib.doWhilst(
            function(next2) {
                aws.queryCFN("DescribeStacks", { StackName: name }, function(err, rc) {
                    if (err) return next2(err);
                    stacks = lib.objGet(rc, "DescribeStacksResponse.DescribeStacksResult.Stacks.member", { list: 1 })
                    if (stacks.length > 0) status = stacks[0].StackStatus;
                    setTimeout(next2, num++ == 0 ? 0 : interval*1000);
                });
            },
            function() {
                if (status) logger.log("Status: ", name, status);
                return complete.indexOf(status) == -1 && Date.now() < expires;
            },
            next);
      },
      function(next) {
          logger.log(util.inspect(stacks, { depth: null }));
          next(status.match(/(CREATE|DELETE|UPDATE)_COMPLETE/) ? null :
              (status.match(/CREATING$/) ? "Timeout waiting for completion, start again to continue" :
                                           "Error waiting for completion: " + status));
      },
    ], function(err) {
        if (typeof callback == "function") return callback(err)
        shell.exit(err)
    })
}

shell.cmdAwsShowCfnEvents = function(options)
{
    var name = this.getArg("-name", options);
    if (!name) exit("ERROR: -name is required");

    var token = undefined;

    lib.doWhilst(
      function(next) {
          aws.queryCFN("DescribeStackEvents", { StackName: name, NextToken: token }, function(err, rc) {
              if (err) return next(err);
              token = lib.objGet(rc, "DescribeStackEventsResponse.DescribeStackEventsResult.NextToken");
              var events = lib.objGet(rc, "DescribeStackEventsResponse.DescribeStackEventsResult.StackEvents.member", { list: 1 });
              events.forEach(function(x) {
                  console.log(x.Timestamp, x.ResourceType, x.LogicalResourceId, x.PhysicalResourceId, x.ResourceStatus, x.ResourceStatusReason || "");
              });
              next();
          });
      },
      function() {
          return token;
      },
      function(err) {
          shell.exit(err);
      });
}

shell.cmdAwsCreateLaunchTemplateVersion = function(options, callback)
{
    var appName = this.getArg("-app-name", options, core.appName);
    var appVersion = this.getArg("-app-version", options, core.appVersion);
    var name = this.getArg("-name", options);
    var version = this.getArgInt("-version", options);
    var imageId = this.getArg("-image-id", options);
    var tmpl, image;

    lib.series([
        function(next) {
            var opts = {
                LaunchTemplateName: name,
            };
            if (version) opts["LaunchTemplateVersion.1"] = version;
            aws.queryEC2("DescribeLaunchTemplateVersions", opts, function(err, rc) {
                if (!err) {
                    tmpl = lib.objGet(rc, "DescribeLaunchTemplateVersionsResponse.launchTemplateVersionSet.item", { list: 1 }).
                                            sort((a, b) => (a.versionNumber - b.versionNumber)).pop();
                }
                next(err);
            });
        },
        function(next) {
            if (imageId) return next();
            var filter = shell.getArg("-image-name", options, '*');
            shell.awsSearchImage(filter, appName, function(err, rc) {
                if (!err) image = rc;
                next(err);
            });
        },
        function(next) {
            var opts = {
                LaunchTemplateName: name,
                SourceVersion: tmpl.versionNumber,
                VersionDescription: image ? image.name : appName + "-" + appVersion,
            };

            if (image && !imageId) imageId = image.imageId;
            if (imageId && tmpl.launchTemplateData.imageId != imageId) {
                opts["LaunchTemplateData.ImageId"] = imageId;
            }

            var type = shell.getArg("-instance-type", options);
            if (type && tmpl.launchTemplateData.instanceType != type) {
                opts["LaunchTemplateData.InstanceType"] = type;
            }

            var key = shell.getArg("-key-name", options);
            if (key && tmpl.LaunchTemplateData.keyName != key) {
                opts["LaunchTemplateData.KeyName"] = key;
            }

            var profile = shell.getArg("-iam-profile", options);
            if (profile && (!tmpl.LaunchTemplateData.IamInstanceProfile || tmpl.LaunchTemplateData.IamInstanceProfile.name != profile)) {
                opts["LaunchTemplateData.IamInstanceProfile.Name"] = profile;
            }

            var eth0 = lib.objGet(tmpl.LaunchTemplateData, "networkInterfaceSet.item", { list: 1 }).filter((x) => (x.deviceIndex == 0)).pop();
            var pub = lib.toBool(shell.getArg("-public-ip", options));
            if (pub && (!eth0 || lib.toBool(eth0.associatePublicIpAddress) != pub)) {
                opts["LaunchTemplateData.NetworkInterface.1.AssociatePublicIpAddress"] = pub;
                opts["LaunchTemplateData.NetworkInterface.1.DeviceIndex"] = "0";
            }

            var groups = lib.strSplit(shell.getArg("-group-id", options)).sort();
            if (lib.isArray(groups) && (!eth0 || lib.objGet(eth0, "groupSet.groupId", { list: 1 }).sort().join(",") != groups.join(","))) {
                opts["LaunchTemplateData.NetworkInterface.1.DeviceIndex"] = "0";
                groups.forEach((x, i) => { opts["LaunchTemplateData.NetworkInterface.1.SecurityGroupId." + (i + 1)] = x });
            }

            var dname = shell.getArg("-dev-name", options, "/dev/xvda");
            var dsize = shell.getArg("-dev-size", options);
            var dtype = shell.getArg("-dev-type", options, "gp2");
            var iops = shell.getArgInt("-dev-iops", options);
            var dev = lib.objGet(tmpl.LaunchTemplateData, "blockDeviceMappingSet.item", { list: 1 }).filter((x) => (x.deviceName == dname)).pop();
            if (dsize && (!dev || !dev.ebs || dev.ebs.volumeSize != dsize || dev.ebs.volumeType != dtype || (iops && dev.ebs.iops != iops))) {
                opts['LaunchTemplateData.BlockDeviceMappings.1.Ebs.VolumeSize'] = dsize;
                opts['LaunchTemplateData.BlockDeviceMappings.1.Ebs.VolumeType'] = dtype;
                opts['LaunchTemplateData.BlockDeviceMappings.1.DeviceName'] = dname;
                if (iops) opts['LaunchTemplateData.BlockDeviceMappings.1.Ebs.Iops'] = iops;
            }

            if (tmpl) logger.info("TEMPLATE:", tmpl);
            if (image) logger.info("IMAGE:", image)
            logger.log("CreateLaunchTemplateVersion:", opts);
            if (shell.isArg("-dry-run", options)) return next();
            if (Object.keys(opts).length == 3) return next();
            aws.queryEC2("CreateLaunchTemplateVersion", opts, (err, rc) => {
                if (!err) {
                    tmpl = lib.objGet(rc, "CreateLaunchTemplateVersionResponse.launchTemplateVersion");
                    logger.log("CreateLaunchTemplateVersionResponse:", tmpl);
                }
                next(err);
            });
        },
        function(next) {
            if (shell.isArg("-dry-run", options)) return next();
            if (!shell.isArg("-default", options)) return next();
            var opts = {
                LaunchTemplateName: name,
                SetDefaultVersion: tmpl.versionNumber,
            };
            aws.queryEC2("ModifyLaunchTemplate", opts, next);
        },
    ], function(err) {
        if (typeof callback == "function") return callback(err);
        shell.exit(err);
    });
}

shell.cmdAwsCreateLaunchConfig = function(options, callback)
{
    var appName = this.getArg("-app-name", options, core.appName);
    var appVersion = this.getArg("-app-version", options, core.appVersion);
    var configName = shell.getArg("-config-name", options);

    var lconfig, lconfigs, image, instance, groups;
    var req = {
        LaunchConfigurationName: this.getArg("-name", options),
        InstanceType: this.getArg("-instance-type", options, aws.instanceType),
        ImageId: this.getArg("-image-id", options, aws.imageId),
        InstanceId: this.getArg("-instance-id", options),
        KeyName: this.getArg("-key-name", options, aws.keyName),
        IamInstanceProfile: this.getArg("-iam-profile", options, aws.iamProfile),
        AssociatePublicIpAddress: this.getArg("-public-ip"),
        "SecurityGroups.member.1": this.getArg("-group-id", options, aws.groupId),
    };
    var d = this.getArg("-device", options).match(/^([a-z0-9\/]+):([a-z0-9]+):([0-9]+)$/);
    if (d) {
        req['BlockDeviceMappings.member.1.DeviceName'] = d[1];
        req['BlockDeviceMappings.member.1.Ebs.VolumeType'] = d[2];
        req['BlockDeviceMappings.member.1.Ebs.VolumeSize'] = d[3];
    }
    var udata = this.awsGetUserData(options);
    if (udata) req.UserData = Buffer.from(udata).toString("base64");

    lib.series([
       function(next) {
           if (!configName) return next();
           aws.queryAS("DescribeLaunchConfigurations", {}, function(err, rc) {
               if (err) return next(err);
               lconfigs = lib.objGet(rc, "DescribeLaunchConfigurationsResponse.DescribeLaunchConfigurationsResult.LaunchConfigurations.member", { list: 1 });
               // Sort by version in descending order, assume name-N.N.N naming convention
               lconfigs = lib.sortByVersion(lconfigs, "LaunchConfigurationName");
               var lname = configName.replace(/-[0-9\.]+$/, "");
               var rx = new RegExp("^" + lname + "-", "i");
               for (var i in lconfigs) {
                   if (rx.test(lconfigs[i].LaunchConfigurationName)) {
                       lconfig = lconfigs[i];
                       break;
                   }
               }
               next(err);
           });
       },
       function(next) {
           if (req.InstanceId) return next();
           var filter = shell.getArg("-instance-name");
           if (!filter) return next();
           var q = { tagName: filter, stateName: "running" };
           aws.ec2DescribeInstances(q, function(err, list) {
               instance = list[0];
               if (instance) req.InstanceId = instance.instanceId;
               next(err);
           });
       },
       function(next) {
           if (req.ImageId) return next();
           var filter = shell.getArg("-image-name", options, '*');
           shell.awsSearchImage(filter, appName, function(err, rc) {
               image = rc;
               next(err ? err : !image ? "ERROR: AMI must be specified or discovered by filters" : null);
           });
       },
       function(next) {
           if (req["SecurityGroups.member.1"]) return next();
           var filter = shell.getArg("-group-name", options, appName + "|^default$");
           aws.ec2DescribeSecurityGroups({ filter: filter }, function(err, rc) {
               groups = rc;
               next(err);
           });
       },
       function(next) {
           if (req.InstanceId) return next();
           if (!req.ImageId) req.ImageId = (image && image.imageId) || (lconfig && lconfig.ImageId);
           if (!lconfig) return next();
           // Reuse config name but replace the version from the image, this is an image upgrade
           if (!req.LaunchConfigurationName && configName && lconfig) {
               var n = lconfig.LaunchConfigurationName.split(/[ -]/);
               if (configName == n[0]) req.LaunchConfigurationName = configName + "-" + image.name.split("-").pop();
           }
           if (image) {
               // Attach the image version to the config name
               if (req.LaunchConfigurationName && /-[0-9\.]+$/.test(image.name) && !/-[0-9\.]+$/.test(req.LaunchConfigurationName)) {
                   req.LaunchConfigurationName += "-" + image.name.split("-").pop();
               }
               if (!req.LaunchConfigurationName) req.LaunchConfigurationName = image.name;
           }
           if (!req.LaunchConfigurationName) req.LaunchConfigurationName = appName + "-" + appVersion;
           if (!req.InstanceType) req.InstanceType = lconfig.InstanceType || aws.instanceType;
           if (!req.KeyName) req.KeyName = lconfig.KeyName || appName;
           if (!req.IamInstanceProfile) req.IamInstanceProfile = lconfig.IamInstanceProfile || appName;
           if (!req.UserData && lconfig.UserData && typeof lconfig.UserData == "string") req.UserData = lconfig.UserData;
           if (!req['BlockDeviceMappings.member.1.DeviceName']) {
               lib.objGet(lconfig, "BlockDeviceMappings.member", { list: 1 }).forEach(function(x, i) {
                   req["BlockDeviceMappings.member." + (i + 1) + ".DeviceName"] = x.DeviceName;
                   if (x.VirtualName) req["BlockDeviceMappings.member." + (i + 1) + ".VirtualName"] = x.Ebs.VirtualName;
                   if (x.Ebs && x.Ebs.VolumeSize) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.VolumeSize"] = x.Ebs.VolumeSize;
                   if (x.Ebs && x.Ebs.VolumeType) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.VolumeType"] = x.Ebs.VolumeType;
                   if (x.Ebs && x.Ebs.Iops) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.Iops"] = x.Ebs.Iops;
                   if (x.Ebs && x.Ebs.Encrypted) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.Encrypted"] = x.Ebs.Encrypted;
                   if (x.Ebs && typeof x.Ebs.DeleteOnTermination == "boolean") req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.DeleteOnTermination"] = x.Ebs.DeleteOnTermination;
               });
           }
           if (!req["SecurityGroups.member.1"]) {
               lib.objGet(lconfig, "SecurityGroups.member", { list: 1 }).forEach(function(x, i) {
                   req["SecurityGroups.member." + (i + 1)] = x;
               });
           }
           if (!req["SecurityGroups.member.1"] && groups) {
               groups.forEach(function(x, i) { req["SecurityGroups.member." + (i + 1)] = x.groupId });
           }
           req.AssociatePublicIpAddress = lib.toBool(req.AssociatePublicIpAddress || lconfig.AssociatePublicIpAddress);
           next();
       },
       function(next) {
           if (lconfigs.some(function(x) { return x.LaunchConfigurationName == req.LaunchConfigurationName })) return next();
           if (lconfig) logger.info("CONFIG:", lconfig);
           if (image) logger.info("IMAGE:", image)
           if (instance) logger.info("INSTANCE:", instance);
           logger.log("CreateLaunchConfig:", req);
           if (shell.isArg("-dry-run", options)) return next();
           aws.queryAS("CreateLaunchConfiguration", req, next);
       },
       function(next) {
           if (shell.isArg("-dry-run", options)) return next();
           if (!shell.isArg("-update-groups", options) || !lconfig) return next();
           aws.queryAS("DescribeAutoScalingGroups", req, function(err, rc) {
               groups = lib.objGet(rc, "DescribeAutoScalingGroupsResponse.DescribeAutoScalingGroupsResult.AutoScalingGroups.member", { list: 1 });
               var lname = lconfig.LaunchConfigurationName.replace(/-[0-9\.]+$/, "");
               lib.forEachSeries(groups, function(group, next2) {
                   if (group.LaunchConfigurationName.replace(/-[0-9\.]+$/, "") != lname && group.LaunchConfigurationName != lconfig.LaunchConfigurationName) {
                       return next2();
                   }
                   aws.queryAS("UpdateAutoScalingGroup", { AutoScalingGroupName: group.AutoScalingGroupName, LaunchConfigurationName: req.LaunchConfigurationName }, next2);
               }, next);
           });
       },
    ], function(err) {
        if (typeof callback == "function") return callback(err);
        shell.exit(err);
    });
}

