# Backend.js framework for node.js

General purpose backend framework.

Features:

* Exposes a set of Web service APIs over HTTP(S) using Express framework.
* Supports Sqlite, PostgreSQL, MySQL, DynamoDB, Cassandra, LevelDB, MongoDB, LMDB databases, easily extendable to support any kind of database.
* Provides accounts, connections, locations, messaging and icons APIs with basic functionality for a qucik start.
* Supports crontab-like and on-demand scheduling for local and remote(AWS) jobs.
* Authentication is based on signed requests using API key and secret, similar to Amazon AWS signing requests.
* Runs web server as separate processes to utilize multiple CPU cores.
* Local jobs are executed by spawned processes
* Supports several cache modes(Redis, memcached, local cache) for the database operations.
* Supports several PUB/SUB modes of operatios using nanomsg, Redis.
* Supports common database operations (Get, Put, Del, Update, Select) for all databases using the same DB API.
* ImageMagick is compiled as C++ module for in-process image scaling.
* nanomsg interface for messaging between processes and servers.
* REPL(command line) interface for debugging and looking into server internals.
* Geohash based location searches supported by all databases drivers.

Check out the [Documentation](http://vseryakov.github.io/backendjs/) for more documentation.

# Requirements and dependencies

The module supports several databases and includes ImageMagick interface so in order for such interfaces to be compiled the software must be installed
on the system before installing the backendjs. Not everything is required, if not available the interface will be skipped.

The optional packages that the backendjs may use if available, resolving packages is done with pkg-config:
- nanomsg - messaging, caching and pub/sub services
- ImageMagick - image manipulation
- libpq - PostgreSQL database driver
- libmysql - MySQL database driver

Installing dependencies on CentOS:

        yum -y install libpng-devel libjpeg-turbo-devel postgresql-devel mysql-devel

Installing dependencies on Mac OS X using macports:

        port install libpng jpeg tiff mysql56 postgresql93

# Installation

To install the module with all optional dependencies if they are available in the system

Note: if for example ImageMagick is not istalled it will be skipped, same goes to all database drivers(PostgreSQL, MySQL) and nanomsg.

        npm install backendjs

To force internal nanomsg and ImageMagick to be compiled the following command must be used:

        npm install backendjs --backend_deps_force

This may take some time because of compiling required dependencies like ImageMagick, nanomsg. They are not required in all
applications but still part of the core of the system to be available once needed.

# Quick start

* Simplest way of using the backendjs, it will start the server listening on port 8000

        # node
        > var bk = require('backendjs')
        > bk.server.start()

* Same but using the helper tool, by default it will use embedded Sqlite database and listen on port 8000

        bkjs run-backend

* Documentation is always available when the backend Web server is running at http://localhost:8000/doc.html

* Go to http://localhost:8000/api.html for the Web console to test API requests.
  For this example let's create couple of accounts, type and execute the following URLs in the Web console

        /account/add?name=test1&secret=test1&login=test1@test.com
        /account/add?name=test2&secret=test2&login=test2@test.com


* Now login with any of the accounts above, click on Login at the top-right corner and enter login and secret in the login popup dialog.
* If no error message appeared after the login, try to get your current account details:

        /account/get

* To see all public fields for all accounts just execute

        /account/select

* Shutdown the backend by pressing Ctrl-C
* To make your own custom Web app, create a new directory (somewhere else) to store your project and run the following command from that directory:

        bkjs init-app

* The app.js file is created in your project directory with 2 additional API endpoints `/test/add` and `/test/[0-9]` to show the simplest way
  of adding new tables and API commands.
* The app.sh script is created for convenience, it specifies common arguments and can be customized as needed
* Run new application now, it will start the Web server on port 8000:

        ./app.sh


* Go to http://localhost:8000/api.html and issue `/test/add?id=1&name=1` and then `/test/1` commands in the console to see it in action
* Change in any of the source files will make the server restart automatically letting you focus on the source code and not server management, this mode
  is only enabled by default in development mode, check app.sh for parameters before running it in te production.

* To start node.js shell with backendjs loaded and initialized

        bksh

# Database schema definition

The backend support multiple databases and provides the same db layer for access. Common operations are supported and all other specific usage can be achieved by
using SQL directly or other query language supported by any particular database.
The database operations supported in the unified way provide simple actions like get, put, update, delete, select, the query method provides generic
access to the databe driver and executes given query directly.

Before the tables can be queried the schema must be defined and created, the backend db layer provides simple functions to do it:

- first the table needs to be described, this is achieved by creating a Javascript object with properties describing each column, multiple tables can be described
  at the same time, for example lets define album table and make sure it exists when we run our application:

            api.describeTables({
                album: {
                    id: { primary: 1 },                         // Primary key for an album
                    name: { pub: 1 },                           // Album name, public column
                    mtime: { type: "bigint" },                  // Modification timestamp
                },
                photo: {
                    album_id: { primary: 1 },                   // Combined primary key
                    id: { primary: 1 },                         // consiting of album and photo id
                    name: { pub: 1, index: 1 },                 // Photo name or description, public column with the index for faster search
                    mtime: { type: "bigint" }
                }
             });

- the system will automatically create the album and photos tables, this definition must remain in the app source code
  and be called on every app startup. This allows 1) to see the db schema while working with the app and 2) easily maintain it by adding new columns if
  necessary, all new columns will be detected and the database tables updated accordingly. And it is all Javascript, no need to learn one more language or syntax
  to maintain database tables.

Each database may restrict how the schema is defined and used, the db layer does not provide an artificial layer hiding all specifics, it just provides the same
API and syntax, for example, DynamoDB tables must have only hash primary key or combined hash and range key, so when creating table to be used with DynamoDB, only
one or two columns can be marked with primary property while for SQL databases the composite primary key can conisit of more than 2 columns.

# API endpoints provided by the backend

## Accounts
The accounts API manages accounts and authentication, it provides basic user account features with common fields like email, name, address.

- `/account/get`

  Returns information about current account or other accounts, all account columns are returned for the current account and only public columns
  returned for other accounts. This ensures that no private fields ever be exposed to other API clients. This call also can used to login into the service or
  verifying if the given login and secret are valid, there is no special login API call because each call must be signed and all calls are stateless and independent.

  Parameters:

    - no id is given, return only one current account record as JSON
    - id=id,id,... - return information about given account(s), the id parameter can be a single account id or list of ids separated by comma
    - _session - after successful login setup a session with cookies so the Web app can perform requests without signing every request anymore

  Note: When retrieving current account, all properties will be present including the location, for other accounts only the properties marked as `pub` in the
  `bk_account` table will be returned.

  Response:

            { "id": "57d07a4e28fc4f33bdca9f6c8e04d6c3",
              "alias": "Test User",
              "name": "Real Name",
              "mtime": 1391824028,
              "latitude": 34,
              "longitude": -118,
              "geohash": "9qh1",
              "login": "testuser",
            }


- `/account/add`

  Add new account, all parameters are the columns from the `bk_account` table, required columns are: **name, secret, login**.

  By default, this URL is in the list of allowed paths that do not need authentication, this means that anybody can add an account. For the real
  application this may not be a good choice so the simplest way to disable it to add api-disallow-path=^/account/add$ to the config file or
  specify in the command line. More complex ways to perform registration will require adding pre and.or post callbacks to handle account registration
  for example with invitation codes....

  In the table `bk_auth`, the column type is used to distinguish between account roles, by default only account with type `admin` can
  add other accounts with this type specified, this column can also be used in account permissions implementations. Because it is in the bk_auth table,
  all columns of this table are available as `req.account` object after the successful authentication where req is Express request object used in the middleware
  parameters.

  *Note: secret and login can be anything, the backend does not require any specific formats so one simple trick which is done by the
  backend Web client is to scramble login/secret using HMAC-SHA1 and keep them in the local storage, this way the real login and secret is never exposed but
  the login popup will still asking for real name, see backend.js in the web/js folder for more details.*

  Example:

            /account/add?name=test&login=test@test.com&secret=test123&gender=f&phone=1234567


  How to make an account as admin

            # Run backend shell
            bkjs run-shell

            # Update record by login
            > db.update("bk_auth", { login: 'login@name', type: 'admin' });

- `/account/select`

  Return list of accounts by the given condition, calls `db.select` for bk_account table. Parameters are the column values to be matched and
  all parameters starting with underscore are control parameters that goes into options of the `db.select` call with underscore removed. This will work for SQL
  databases only because DynamoDB or Cassandra will not search by non primary keys. In the DynamoDB case this will run ScanTable action which will be very expensive for
  large tables. Supports special query parameters `_select,_keys,_ops`, see docs about `db.select` for more info.

  Example:

            /account/search?email=test&_ops=email,begins_with
            /account/search?name=test&_keys=name


  Response:

            {  "data": [{
                          "id": "57d07a4e28fc4f33bdca9f6c8e04d6c3",
                          "alias": "Test User1",
                          "name": "User1",
                          "mtime": 1391824028,
                          "login": "test1",
                        },
                        {
                          "id": "57d07a4e2824fc43bd669f6c8e04d6c3",
                          "alias": "Test User2",
                          "name": "User2",
                          "mtime": 1391824028,
                          "login": "test2",
                        }],
                "next_token": ""
            }

- `/account/del`

  Delete current account, after this call no more requests will be authenticated with the current credentials

- `/account/update`

  Update current account with new values, the parameters are columns of the table `bk_account`, only columns with non empty values will be updated.

  Example:

            /account/update?name=New%2BName&alias=Hidden%2BName&gender=m

- `/account/put/secret`

  Change account secret for the current account, no columns except the secret will be updated and expected.

  Parameters:
    - secret - new secret for the account

  Example:

            /account/put/secret?secret=blahblahblah


- `/account/subcribe`

  Subscribe to account events delivered via HTTP Long Poll, a client makes the connection and waits for events to come, whenever
  somebody updates the account's counter or send a message or creates a connection to this account the event about it will be sent to this HTTP
  connection and delivered as JSON object. This is not a persistent queue so if not listening, all events will just be ignored, only events published
  since the connect will be delivered. To specify what kind of events needs to be delivered, `match` query parameter can be specified which is a
  RegExp of the whole event body string.

  *Note: On the server side there is a config parameter `subscribeInterval` which defines how often to deliver notifications, by default it is 5 seconds which means
  only every 5 seconds new events will be delivered to the Web client, if more than one event happened, they all accumulate and will be sent as a JSON list.*

  Example:

        /account/subscribe
        /account/subscribe?match=connection/add.*type:*like


  Response:

        [ { "path": "/message/add", "mtime:" 1234566566, "type": "1" },
          { "path": "/counter/incr", "mtime:" 1234566566, "type": "like,invite" } },
          { "path": "/connection/add", "mtime": 1223345545, "type": "like" } ]

- `/account/select/icon`

  Return a list of available account icons, icons that have been uploaded previously with /account/put/icon calls. The `url` property is an URL to retrieve this particular icon.

  Parameters:
    - id - if specified then icons for the given account will be returned

  Example:

        /account/select/icon?id=12345

  Response:

        [ { id: '12345', type: '1', url: '/account/get/icon?id=12345&type=1' },
          { id: '12345', type: '2', url: '/account/get/icon?id=12345&type=2' } ]

- `/account/get/icon`

  Return an account icon, *the icon is returned in the body as binary BLOB*, if no icon with specified type exists, i.e. never been uploaded then 404 is returned.

  Parameters:
    - type - a number from 0 to 9 or any single letter a..z which defines which icon to return, if not specified 0 is used

  Example:

        /account/get/icon?type=2


- `/account/put/icon`

  Upload an account icon, once uploaded, the next `/account/get` call will return propertis in the format `iconN` wheer N is any of the
  type query parameters specified here, for example if we uploaded an icon with type 5, then /account/get will return property icon5 with the URL
  to retrieve this icon.
  *By default all icons uploaded only accessible for the account which uploaded them.*

  Parameters:

    - type - icon type, a number between 0 and 9 or any single letter a..z, if not specified 0 is used
    - icon - can be passed as base64 encoded image in the query,
        - can be passed as base64 encoded string in the body as JSON, like: { type: 0, icon: 'iVBORw0KGgoA...' },
          for JSON the Content-Type HTTP headers must be set to `application/json` and data should be sent with POST request
        - can be uploaded from the browser using regular multi-part form
    - acl_allow - icon access permissions:
      - "" (empty) - only own account can access
      - all - public, everybody can see this icon
      - auth - only authenticated users can see this icon
      - id,id.. - list of account ids that can see this account
    - _width - desired width of the stored icon, if negative this means do not upscale, if th eimage width is less than given keep it as is
    - _height - height of the icon, same rules apply as for the width above
    - _ext - image file format, default is jpg, supports: gif, png, jpg, jp2

  Example:

        /account/put/icon?type=1&icon=iVBORw0KGgoAAAANSUhEUgAAAAcAAAAJCAYAAAD+WDajAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwgAADs....

- `/account/del/icon`

  Delete account icon

  Parameters:

    - type - what icon to delete, if not specified 0 is used

  Example:

        /account/icon/del?type=1

## Public Images endpoint
This endpoint can server any icon uploaded to the server for any account, it is supposed to be a non-secure method, i.e. no authentication will be performed and no signagture
will be needed once it is confgiured which prefix can be public using `api-allow` or `api-allow-path` config parameters.

The format of the endpoint is:

    /image/prefix/id/type

    Example:

        # Configure accounts icons to be public in the etc/config
        api-allow-path=/image/account/

        # Or pass in the command line
        ./app.sh -api-allow-path /image/account/

        # Make requests
        /image/account/12345/0
        /image/account/12345/1

        #Return icons for account 12345 for types 0 and 1

## Icons
The icons API provides ability for an account to store icons of different types. Each account keeps its own icons separate form other
accounts, within the account icons can be separated by `prefix` which is just a namespace assigned to the icons set, for example to keep messages
icons separate from albums, or use prefix for each separate album. Within the prefix icons can be assigned with unique type which can be any string.

Prefix and type can consist from alphabetical characters and numbers, dots, underscores and dashes: [a-z0-9._-]. This means, they are identificators, not real titles or names,
a special mapping between prefix/type and album titles for example needs to be created separately.

The supposed usage for type is to concatenate common identifiers first with more specific to form unique icon type which later can be queried
by prefix or exactly by icon type. For example album id can be prefixed first, then sequential con number like album1:icon1, album1:icon2....
then retrieving all icons for an album would be only query with album1: prefix.

- `/icon/get/prefix`
- `/icon/get/prefix/type`

   Return icon for the current account in the given prefix, icons are kept on the local disk in the directory
   configured by -api-images-dir parameter(default is images/ in the backend directory). Current account id is used to keep icons
   separate from other accounts. `type` is used to specify unique icon created with such type which can be any string.

- `/icon/put/prefix`
- `/icon/put/prefix/type`

  Upload new icon for the given account in the folder prefix, if type is specified it creates an icons for this type to separate
  multiple icons for the same prefix. `type` can be any string consisting from alpha and digits characters.

  The following parameters can be used:
    - descr - optional description of the icon
    - latitude, longitude - optional coordinates for the icon
    - acl_allow - allow access permissions, see `/account/put/icon` for the format and usage
    - _width - desired width of the stored icon, if negative this means do not upscale, if th eimage width is less than given keep it as is
    - _height - height of the icon, same rules apply as for the width above
    - _ext - image file format, default is jpg, supports: gif, png, jpg

- `/icon/del/prefix`
- `/icon/del/prefix/type`

   Delete the default icon for the current account in the folder prefix or by type

- `/icon/select/prefix`
- `/icon/select/prefix/type`
  Return list of available icons for the given prefix adn type, all icons starting with prefix/type will be returned,
  the `url` property will provide full URL to retrieve the icon contents

  Example:

        /icon/select/album/me
        /icon/select/album/12345

  Responses:

        [ { id: 'b3dcfd1e63394e769658973f0deaa81a', type: 'me-1', icon: '/icon/get/album/me1' },
          { id: 'b3dcfd1e63394e769658973f0deaa81a', type: 'me-2', icon: '/icon/get/album/me2' } ]

        [ { id: 'b3dcfd1e63394e769658973f0deaa81a', type: '12345-f0deaa81a', icon: '/icon/get/album/12345-f0deaa81a' } ]

## Connections
The connections API maintains two tables `bk_connection` and `bk_reference` for links between accounts of any type. bk_connection table maintains my
links, i.e. when i make explicit connection to other account, and bk_reference table is automatically updated with reference for that other account that i made
a connection with it. No direct operations on bk_reference is allowed.

- `/connection/add`
- `/connection/put`
  Create or replace a connection between two accounts, required parameters are:
    - `id` - id of account to connect to
    - `type` - type of connection, like,dislike,....
    - _connected - the reply will contain a property `connected` set to 1 if the other side of our connection is connected to us as well

  This call automatically creates a record in the bk_reference table which is reversed connection for easy access to information like
  ''who is connected to me'' and auto-increment like0, like1 counters for both accounts in the bk_counter table.

  Also, this call updates the counters in the `bk_counter` table for my account which match the connection type, for example if the type of
  connection is 'invite' and the `bk_counter` table contain 2 columns `invite0` and `invite1`, then both counters will be increased.

  Example:

        /connection/add?id=12345&type=invite&state=sent

- `/connection/update`
  Update other properties of the existing connection, for connections that may take more than i step or if a connection has other data associated with it beside
  the type of the connection.

  Example:

        /connection/update?id=12345&type=invite&state=accepted

- `/connection/del`
  Delete existing connection(s), `id` and/or `type` may be be specified, if not all existing connections will be deleted.

  Example:

        /connection/del?type=invite&id=12345

- `/connection/get`
  Receive all my connections of the given type, i.e. connection(s) i made, if `id` is given only one record for the specified connection will be returned. Supports special
  query parameters `_select,_keys,_ops`, see docs about `db.select` for more info.

  Example:

        /connection/get?type=invite             - return all accounts who i invited
        /connection/get?type=invite&id=12345

  Response:

        { "data": [ { "id": "12345",
                      "type": "invite",
                      "status": "",
                      "mtime": "12334312543"
                  }],
          "next_token": ""
        }

- `/reference/get`
  Receive all references that connected with my account, i.e. connections made by somebody else with me, works the same way as for connection query call

  Example:

        # Return all accounts who invited me
        /reference/get?type=invite
        # Return accounts who invited me after specified mtime
        /reference/get?type=invite&_keys=id,type,mtime&_ops=mtime,gt&mtime=12334312543

  Response:

        { "data": [ { "id": "57d07a4e28fc4f33bdca9f6c8e04d6c3",
                      "type": "invite",
                      "status": "",
                      "mtime": "12334312543"
                  }],
          "next_token": ""
        }

## Locations
The location API maintains a table `bk_location` with geolocation coordinates for accounts and allows searching it by distance. The configuration parameter
`min-distance` defines the radius for the smallest bounding box in km containing single location, radius searches will combine neighboring boxes of
this size to cover the whole area with the given distance request, also this affects the length of geohash keys stored in the bk_location table. By default min-distance is 5 km
which means all geohashes in bk_location table will have geohash of size 4. Once min-distance is set it cannot be changed without rebuilding the bk_location table with new geohash size.

- `/location/put`
  Store currenct location for current account, latitude and longitude parameters must be given, this call will update the bk_account table as well with
  these coordinates

  Example:

        /location/put?latitude=-188.23232&longitude=23.4545454

- `/location/get`
  Return matched accounts within the distance(radius) specified by `distance=` parameter in kilometers and current position specified by latitude/longitude paraemeters. This
  call returns results in chunks and requires navigation through all pages to receive all matched records. Records returned will start with the closest to the current
  point. If there are more matched records than specified by the `_count`, the `next_token` property is set with the token to be used in the subsequent call,
  it must be passed as is as `_token=` parameter with all original query parameters.

  By default only locations with account ids will be returned, specifying `_details=1` will return public account columns like name as well.

  Note: The current account will not be present in the results  even if it is within the range, to know my own location use `/account/get` call.

  Example:

            /location/get?distance=10&latitude=-118.23434&longitude=23.45665656&_count=25
            /location/get?distance=10&latitude=-118.23434&longitude=23.45665656&_count=25&_token=FGTHTRHRTHRTHTTR.....

  Response:

           { "data": [ { "id": "12345",
                         "distance": 5,
                         "latitude": -118.123,
                         "longitude": 23.45
                         "mtime": "12334312543"
                       },
                       { "id": "45678",
                         "distance": 5,
                         "latitude": -118.133,
                         "longitude": 23.5
                         "mtime": "12334312543"
                       }],
             "next_token": ""
           }

## Messages
The messaging API allows sending and recieving messages between accounts, it supports text and images. The typical usage of this API is to
poll the counter record using `/counter/get` from time to time and check for `msg_count` and `msg_read` counters, once `msg_count` is greater than `msg_read` this means
there is a new message arrived. Then call `/message/get` to retrieve all or only new messages arrived after some point in time and store the mtime
from the last messages received so the next time we will use this time to get only new messages.

- `/message/image`
  Return the image data for the given message, the required parameters are:
    - sender - id of the sender returned in the by `/message/get` reply results for every message
    - mtime - exact timestamp of the message

- `/message/get`
  Receive messages, the parameter `mtime` defines which messages to get, if omitted all messages will be returned. By `mtime` it is possible to
  specify that only messages received since that time to return, it must be in milliseconds since midnight GMT on January 1, 1970, this is what
  Date.now() return in Javascript. The images are not returned, only link to the image in `icon` property of reach record,
  the actual image data must be retrieved separately.

  When `sender` is specified then all messages for given sender will be returned.

  When `id` is specified and i tis not the current account id, then all messages that the current account has sent to the `id` will be returned, i.e.
  this is how i can get all messages i have sent to the `id`.

  NOTE: The `mtime` is when the backend server received the message, if client and the server clocks are off this may return wrong data or not return anything at all,
  also because the arrival order of the messages cannot be guaranteed, sending fast multiple messages may be received in different order by the backend and this will
  result in mtimes that do not correspond to actual times when the message has been sent.

  Example:

        # Get all messages
        /message/get

        # Get all messages received after given mtime
        /message/get?mtime=123475658690

        # Get all messages with custom filter: if msg text contains Hi
        /message/get?_keys=id,mtime,msg&_ops=msg,iregexp&msg=Hi

        # Get all messages for specific sender
        /message/get?sender=12345

        # Get all messages i have sent to the user 12345
        /message/get?id=12345

  Response:

        { "data": [ { "sender": "12345",
                      "msg": "Hi, how r u?",
                      "mtime": "12334312543"
                    },
                    { "sender": "45678",
                      "msg": "check this out!",
                      "icon": "/message/image?sender=45678&mtime=12334312543",
                      "mtime": "12334312543"
                    }],
             "next_token": ""
           }

- `/message/get/unread`
  Read all unread messages, i.e. the messages that never been issued `/message/read` call.

  Parameters:
   - `_read` - if set to 1, all returned messages will be marked as read automatically, so no individual /message/read call needed


- `/message/add`
  Send a message to an account, the following parametrrs must be specified:
    - `id` - account id of the receiver
    - `msg` - text of the message, can be empty if `icon` property exists
    - `icon` - icon of the message, it can be base64 encoded image in the query or JSON string if the whole message is posted as JSON or
      can be a multipart file upload if submitted via browser, can be omitted if `msg/connection/get?type=invite&id=12345` property exists.

  After successful post the message counters of the destination account will be updated: msg_count will be increased automatically

  Example:

        /message/add?id=12345&msg=Hello
        /message/add?id=12345&msg=this%2Bis%2Bthe%2Bpic&icon=KHFHTDDKH7676758JFGHFDRDEDET....TGJNK%2D

- `/message/read`
  Mark a message as read, this will update account counter `msg_read` automatically. The required query parameters are `sender` and `mtime`.

  Example:

        /message/read?sender=12345&mtime=12366676434

- `/message/del`
  Delete the message by `sender` and/or `mtime` which must be passed as query parameters. If no mtime is given, all messages from the given sender will be deleted.

  Example:

        /message/del?sender=12345&mtime=124345656567676


## Counters
The counters API maintains realtime counters for every account records, the counters record may contain many different counter columns for different purposes and
is always cached with whatever cache service is used, by default it is cached by the Web server process on every machine. Web worker processes ask the master Web server
process for the cached records thus only one copy of the cache per machine even in the case of multiple CPU cores.

- `/counter/get`
  Return counter record for current account with all available columns of if `id` is given return public columns for given account, it works with `bk_counter` table
  which by default defines some common columns:
    - like0 - how many i liked, how many time i liked someone, i.e. made a new record in bk_connection table with type 'like'
    - like1 - how many liked me, reverse counter, who connected to me with type 'like'
    - dislike0 - how many i disliked
    - dislike1 - how many disliked me
    - follow0 - how many i follow
    - follow1 - how many follows me
    - invite0 - how many i invited
    - invite1 - how many invited me
    - msg_count - how messages i received via messaging API
    - msg_read - how many messages i read using messaging API, these counters allow to keep track of new messages, as soon as msg_count greater than msg_read
    it means i have a new message
  More columns can be added to the bk_counter table.

  NOTE: The columns with suffixes 0 and 1 are special columns that support the Connections API, every time a new connection is created, the type of new connection
  is checked against any columns in the bk_counter table, if a property type0 exists and marked in the table descriptnio as `autoincr` then the corresponding
  counter property is increased, this is how every time new connectio like/dislike/invite/follow is added, the counters in the bk_counter table are increased.

- `/counter/put`
  Replace my counters record, all values if not specified will be set to 0

- `/counter/incr`
  Increase one or more counter fields, each column can provide a numeric value and it will be added to the existing value, negative values will be substracted.
  if `id` parameter is specified, only public columns will be increased for other account.

  Example:

        /counter/incr?msg_read=5&
        /counter/incr?id=12345&ping=1

## History
The history API maintains one table for all application specific logging records. All operations deal with current account only.

- `/history/add`
  Add a record to the `bk_history` table for current account, timestamp is added automatically, all other fields are optional but by default
  this table contains only 2 columns: `type` and `data` for genetic logging, it can to be extended to support any other application logic if needed.

- `/history/get`
  Return history record for current account, if mtime is not specified all records from the beginning will be returned, use `_count` and `_start` parameters to paginate through
  all available records or specify `mtime=` with the timestamp in milliseconds to start with particular time.

## Data
The data API is a generic way to access any table in the database with common operations, as oppose to the any specific APIs above this API only deals with
one table and one record without maintaining any other features like auto counters, cache...

*Because it exposes the whole database to anybody who has a login it is a good idea to disable this endpoint in the production or provide access callback that verifies
who can access it.*
  - To disable this endpoint completely in the config: api-disable=data
  - To allow admins to access it only:

        api.registerAuthCheck('GET', '/data', function(req, status, cb) { if (req.account.type != "admin") return cb({ status: 401, message: 'access denied' }; cb(status)); });

- `/data/columns`
- `/data/columns/TABLE`
  Return columns for all tables or the specific TABLE

- `/data/keys/TABLE`
  Return primary keys for the given TABLE

- `/data/(select|search|list|get|add|put|update|del|incr|replace)/TABLE`
  Perform database operation on the given TABLE, all options for the `db` functiobns are passed as query parametrrs prepended with underscore,
  regular parameters are the table columns.

  Example:

        /data/get/bk_account?id=12345
        /data/put/bk_counter?id=12345&like0=1
        /data/select/bk_account?name=john&_ops=name,gt&_select=name,alias,email

## System API
The system API returns information about the backend statistics, allows provisioning and configuration commands and other internal maintenance functions. By
default is is open for access to all users but same security considerations apply here as for the Data API.

- `/system/cache/(init|stats|keys|get|set|put|incr|del|clear)`
    Access to the caching functions

- `/system/msg/(msg)`
    Access to the messaging functions

- `/system/stats`
  Database pool statistics and other diagnostics
  - pool - database metrics
    - process - stats about how long it takes between issuing the db request and till the final moment all records are ready to be sent to the client
    - response - stats about only response times from the db without any local processing times of the result records
    - queue - stats about db requests at any given moment queued for the execution
    - rate - req/sec rates
  - api - Web requests metrics, same structure as for the db pool metrics

  Individual sub-objects:
  - rate or meter - Things that are measured as events / interval.
     - mean: The average rate since the meter was started.
     - count: The total of all values added to the meter.
     - currentRate: The rate of the meter since the last toJSON() call.
     - 1MinuteRate: The rate of the meter biased towards the last 1 minute.
     - 5MinuteRate: The rate of the meter biased towards the last 5 minutes.
     - 15MinuteRate: The rate of the meter biased towards the last 15 minutes.
  - queue or histogram - Keeps a resevoir of statistically relevant values biased towards the last 5 minutes to explore their distribution
      - min: The lowest observed value.
      - max: The highest observed value.
      - sum: The sum of all observed values.
      - variance: The variance of all observed values.
      - mean: The average of all observed values.
      - stddev: The stddev of all observed values.
      - count: The number of observed values.
      - median: 50% of all values in the resevoir are at or below this value.
      - p75: See median, 75% percentile.
      - p95: See median, 95% percentile.
      - p99: See median, 99% percentile.
      - p999: See median, 99.9% percentile.

  Response:

         {
            "toobusy": 0,
            "pool": {
                "process": {
                    "meter": {
                        "mean": 0.001194894762493158,
                        "count": 65,
                        "currentRate": 0.001194894762493158,
                        "1MinuteRate": 2.413646785930864e-158,
                        "5MinuteRate": 1.2021442332952544e-33,
                        "15MinuteRate": 7.127940837162242e-13
                    },
                    "histogram": {
                        "min": 1,
                        "max": 4,
                        "sum": 99,
                        "variance": 0.4096153846153847,
                        "mean": 1.523076923076923,
                        "stddev": 0.6400120191179106,
                        "count": 65,
                        "median": 1,
                        "p75": 2,
                        "p95": 2.6999999999999957,
                        "p99": 4,
                        "p999": 4
                    }
                },
                "queue": {
                    "min": 1,
                    "max": 1,
                    "sum": 65,
                    "variance": 0,
                    "mean": 1,
                    "stddev": 0,
                    "count": 65,
                    "median": 1,
                    "p75": 1,
                    "p95": 1,
                    "p99": 1,
                    "p999": 1
                },
                "count": 0,
                "rate": {
                    "mean": 0.0011948946746301802,
                    "count": 65,
                    "currentRate": 0.0011948946746301802,
                    "1MinuteRate": 2.413646785930864e-158,
                    "5MinuteRate": 1.2021442332952544e-33,
                    "15MinuteRate": 7.127940837162242e-13
                },
                "response": {
                    "meter": {
                        "mean": 0.0011948947405274121,
                        "count": 65,
                        "currentRate": 0.0011948947405274121,
                        "1MinuteRate": 2.413646785930864e-158,
                        "5MinuteRate": 1.2021442332952544e-33,
                        "15MinuteRate": 7.127940837162242e-13
                    },
                    "histogram": {
                        "min": 0,
                        "max": 2,
                        "sum": 65,
                        "variance": 0.12500000000000003,
                        "mean": 1,
                        "stddev": 0.3535533905932738,
                        "count": 65,
                        "median": 1,
                        "p75": 1,
                        "p95": 2,
                        "p99": 2,
                        "p999": 2
                    }
                },
                "misses": 3,
                "hits": 50
            },
            "api": {
             "rss": {
                "min": 77926400,
                "max": 145408000,
                "sum": 23414882304,
                "variance": 234721528417225.16,
                "mean": 128653199.47252747,
                "stddev": 15320624.282881724,
                "count": 182,
                "median": 124903424,
                "p75": 144999424,
                "p95": 145408000,
                "p99": 145408000,
                "p999": 145408000
            },
            "heap": {
                "min": 14755896,
                "max": 31551408,
                "sum": 4174830592,
                "variance": 19213862445722.168,
                "mean": 22938629.626373626,
                "stddev": 4383362.002586846,
                "count": 182,
                "median": 22453472,
                "p75": 26436622,
                "p95": 30530277.599999998,
                "p99": 31331225.599999998,
                "p999": 31551408
            },
            "loadavg": {
                "min": 0,
                "max": 0.14208984375,
                "sum": 8.33349609375,
                "variance": 0.0013957310299007465,
                "mean": 0.04578844007554945,
                "stddev": 0.03735948380131538,
                "count": 182,
                "median": 0.043701171875,
                "p75": 0.0806884765625,
                "p95": 0.103857421875,
                "p99": 0.13803710937499994,
                "p999": 0.14208984375
            },
            "freemem": {
                "min": 1731198976,
                "max": 1815724032,
                "sum": 319208222720,
                "variance": 335910913486664.44,
                "mean": 1753891333.6263735,
                "stddev": 18327872.584854588,
                "count": 182,
                "median": 1757151232,
                "p75": 1763340288,
                "p95": 1785729638.4,
                "p99": 1798348267.5199997,
                "p999": 1815724032
            },
            "rate": {
                "mean": 0.005091340673514894,
                "count": 277,
                "currentRate": 0.005091340673514894,
                "1MinuteRate": 0.014712537947741827,
                "5MinuteRate": 0.003251074139103506,
                "15MinuteRate": 0.0011131541240945431
            },
            "response": {
                "meter": {
                    "mean": 0.005072961780912493,
                    "count": 276,
                    "currentRate": 0.005072961780912493,
                    "1MinuteRate": 0.014712537947741827,
                    "5MinuteRate": 0.003251074139103506,
                    "15MinuteRate": 0.0011131541240946244
                },
                "histogram": {
                    "min": 1,
                    "max": 11847,
                    "sum": 13614,
                    "variance": 508182.2787351782,
                    "mean": 49.32608695652174,
                    "stddev": 712.8690473959282,
                    "count": 276,
                    "median": 2,
                    "p75": 5.75,
                    "p95": 27.149999999999977,
                    "p99": 122.99000000000024,
                    "p999": 11847
                }
            },
            "queue": {
                "min": 1,
                "max": 2,
                "sum": 286,
                "variance": 0.03154920734578558,
                "mean": 1.032490974729242,
                "stddev": 0.17762096538918368,
                "count": 277,
                "median": 1,
                "p75": 1,
                "p95": 1,
                "p99": 2,
                "p999": 2
            },
            "count": 1
            }
        }


# Backend directory structure

When the backend server starts and no -home argument passed in the command line the backend makes its home environment in the ~/.backend directory.

The backend directory structure is the following:

* `etc` - configuration directory, all config files are there
    * `etc/config` - config parameters, same as specified in the command line but without leading -, each config parameter per line:

        Example:

            debug=1
            db-pool=dynamodb
            db-dynamodb-pool=http://localhost:9000
            db-pgsql-pool=postgresql://postgres@127.0.0.1/backend

            To specify other config file: bkjs run-backend -config-file file

    * some config parameters can be condigured in DNS as TXT records, the backend on startup will try to resolve such records and use the value if not empty.
      All params that  marked with DNS TXT can be configured in the DNS server for the domain where the backend is running, the config parameter name is
      concatenated with the domain and queried for the TXT record, for example: `lru-host` parameter will be queried for lru-host.domain.name for TXT record type.

    * `etc/crontab` - jobs to be run with intervals, local or remote, JSON file with a list of cron jobs objects:

        Example:

        1. Create file in ~/.backend/etc/crontab with the following contents:

                [ { "type": "local", "cron": "0 1 1 * * 1,3", "job": { "api.cleanSessions": { "interval": 3600000 } } } ]

        2. Define the funtion that the cron will call with the options specified, callback must be called at the end, create this app.js file

                var backend = require("backendjs");
                backend.api.cleanSessions = function(options, callback) {
                     backend.db.del("session", { mtime: options.interval + Date.now() }, { ops: "le", keys: [ "mtime" ] }, callback);
                }
                backend.server.start()

        3. Start the scheduler and the web server at once

                bkjs run-backend -master -web

    * `etc/proxy` - HTTP proxy config file, from http-proxy (https://github.com/nodejitsu/node-http-proxy)

        Example:

        1. Create file ~/.backend/etc/proxy with the following contents:

                { "target" : { "host": "localhost", "port": 8001 } }

        2. Start the proxy

                bkjs -proxy

        3. Now all requests will be sent to localhost:8001

    * `etc/profile` - shell script loaded by the bkjs utility to customize env variables
* `images` - all images to be served by the API server, every subfolder represent naming space with lots of subfolders for images
* `var` - database files created by the server
* `tmp` - temporary files
* `web` - Web pages served by the static Express middleware

# Internal backend functions

The backend includes internal C++ module which provide some useful functions available in the Javascript. The module is exposed as "backend" submodule, to see
all functions for example run the below:

    var backend = require('backendjs');
    console.log(backend.backend)

List of available functions:
- rungc() - run V8 garbage collector on demand
- setsegv() - install SEGV signal handler to show crash backtrace
- setbacktrace() - install special V8-aware backtrace handler
- backtrace() - show V8 backtrace from current position
- heapSnapshot(file) - dump current memory heap snapshot into a file
- splitArray(str) - split a string into an array separated by commas, supports double quotes
- logging([level]) - set or return logging level, this is internal C++ logging facility
- loggingChannel(channelname) - redirect logging into stdout or stderr, this is internal C++ logging
- countWords(word, text) - return how many time word appers in the text, uses Knuth-Morris-Pratt algorithm
- countAllWords(list, text) - return an object with counters for each word from the list, i.e. how many times each word appears in the text, uses Aho-Corasick algorithm
- countWordsInit() - clears word counting cache
- resizeImage(source, options, callback) - resize image using ImageMagick,
   - source can be a Buffer or file name
   - options can have the following properties:
     - width - output image width, if negative and the original image width is smaller than the specified, nothing happens
     - height - output image height, if negative and the original image height is smaller this the specified, nothing happens
     - quality - 0 -99
     - out - output file name
     - ext - image extention

- resizeImageSync(name,width,height,format,filter,quality,outfile) - resize an image synchronically
- snappyCompress(str) - compress a string
- snappyUncompress(str) - decompress a string
- geoDistance(lat1, lon1, lat2, lon2) - return distance between 2 coordinates in km
- geoBoundingBox(lat, lon, distance) - return bounding box geohash for given point around distance
- geoHashEncode(lat, lon, len) - return geohash for given coordinate, len defines number of bytesin geohash
- geoHashDecode(hash) - return coordinates for given geohash
- geoHashAdjacent()
- geoHashGrid()
- geoHashRow()
- cacheSave() - general purpose caching functions that have no memory limits and do not use V8 heap
- cacheSet()
- cacheGet()
- cacheDel()
- cacheKeys()
- cacheClear()
- cacheNames()
- cacheSize()
- cacheEach()
- cacheForEach()
- cacheForEachNext()
- cacheBegin()
- cacheNext()
- lruInit(max) - init LRU cache with max number of keys, this is in-memory cache which evicts older keys
- lruStats() - return statistics about the LRU cache
- lruSize() - return size of the current LRU cache
- lruCount() - number of keys in the LRU cache
- lruSet(name, val) - set/replace value by name
- lruGet(name) - return value by name
- lruIncr(name, val) - increase value by given number, non existent items assumed to be 0
- lruDel(name) - delete by name
- lruKeys() - return all cache key names
- lruClear() - clear LRU cache
- lruServer()
- syslogInit(name, priority, facility) - initialize syslog client, used by the logger module
- syslogSend(level, text)
- syslogClose()
- listStatements() - list all active Sqlite statements
- NNSocket() - create a new nanomsg socket object

# Cache configurations
Database layer support caching of the responses using `db.getCached` call, it retrieves exactly one record from the configured cache, if no record exists it
will pull it from the database and on success will store it in the cache before returning to the client. When dealing with cached records, there is a special option
that must be passed to all put/update/del database methods in order to clear local cache, so next time the record will be retrieved with new changes from the database
and refresh the cache, that is `{ cached: true }` can be passed in the options parameter for the db methods that may modify records with cached contents. In any case
it is required to clear cache manually there is `db.clearCached` method for that.

## Internal with nanomsg

For cache management signaling, all servers maintain local cache per machine, it is called `LRU` cache. This cache is maintained in the master Web process and
serves all Web worker processes via IPC channel. Every Web master process if compiled with nanomsg library can accept cache messages on a TCP port (`cache-port=20194`)
from other backend nodes. Every time any Web worker updates the local cache, its master process re-broadcasts the same request to other connected Web master
processes on other nodes thus keeping in sync caches on all nodes.

The basic flow is the following using a hypothetical example:

- there are 4 nodes running in the network: node1, node2, node3 and node4, instead of the names nodeX we can use IP addresses as well.
- all nodes configured with the parameter `cache-host=node1,node2`
- nanomsg sockets may be connected to multiple endpoints, so we can have 2 cache servers for redundency. This config parameter can be specified in the local config file on all nodes
   or can be defined in the DNS server as TXT record `cache-host`. If running in AWS the config parameters also can be specified in the user-data the same was as command line arguments.
- any node which is requested for a cached record asks its local cache for such key and if it not found, retrieves it from the database and puts into local cache,
   if running for a while, potentially every node now may contain same items in the cache and all requests for such items will be served without touching the db
- An update request comes to the node3 which deletes a key from the local cache:
   - node3 also sends 'del' request for the requested key to both node1 and node2 servers via connected sockets because of `cache-host` config parameter
   - node1 and node2 servers receive 'del' request and delete the key from their local caches
   - node1 and node2 re-send same request to all connected clients which are actually all nodes in the network, so all nodes receive 'del' cache request
   - because we have 2 LRU servers, every node will receive the same del request twice which is very small packet and removing same item from the cache
     costs nothing, both requests will be received within milliseonds from each other.
   - next request to any of the nodes for that key we just deleted will result in retrieving the record from the database and putting back to the local cache
     of the node until the next 'del' request.
   - Important: each node maintains its own version of the cache, i.e. all nodes do not have exactly the same
     items in the cache, over time they all retieve same records but only on demand and when one node puts an item in the cache it is not sent to all other nodes.
     To make the cache synhronized set `cache-sync=1`, in this case all cache commands will be sent to all nodes, with multiple broadcast nodes
     the same item will be sent multiple times from each broadcast node, this is why it is disabled by default, sending 'del' multiple times does not add
     much overhead as opposed to re-sending actual items.

For very frequent items there is no point using local cache but for items reasonable static with not so often changes this cache model will work reliably and similar to
what `memcached` or `Redis` server would do as well.

The benefits of this approach is not to run any separate servers and dealing with its own configuration and support, using nanomsg
internal backend cache system is self contained and does not need additional external resources, any node can be LRU server whose only role is to make sure all other
nodes flush their caches if needed. Using redundant broadcast servers makes sure such flush requests reach all nodes in the cluster and there is no single point of failure.

Essentually, setting `cache-host` to the list of any nodes in the network is what needs to be done to support distributed cache with nanomsg sockets.

# memcached
Setting `cache-type=memcache` and pointing `memcache-host` to one or more hosts running memcached servers is what needs to be done only, the rest of the
system works similar to the internal nanomsg caching but using memcache client instead. The great benefit using memcache is to configure more than one
server in `memcache-host` separated by comma which makes it more reliable and eliminates single point of failure if one of the memcache servers goes down.

# Redis
Set `cache-type=redis` and point `redis-host` to the server running Redis server. Only single redis server can be specified.

# PUB/SUB configurations

Publish/subscribe functionality allows clients to receive notifications without constantly polling for new events. A client can be anything but
the backend provides some partially implemented subscription notifications for Web clients using the Long Poll.
The Account API call `/account/subscribe` can use any pub/sub mode.

The flow of the pub/sub operations is the following:
- a client makes `/account/subscribe` API request, the connection is made and is kept open indefenitely or as long as configured using `api-subscribe-timeput`.
- the backend receives this request, and runs the `core.ipcSubscribe` method with the key being the account id
  - if nanomsg pub/sub hosts are configured, the method connect to the sub hosts with the subscription key and wait for the events to be published
- some other client makes an API call that triggers an event, like update a counter, sends a message, on such event the backend
  always runs `core.ipcPublish` method and if there is no publish host configured nothing happens.
  If there is a host to publish, it sends the message to it, the message being a JSON object with the request API path and mtime, other properties depend on the call made.
- this step depends on the pub/sub system being used:
  - nanomsg, the publish server receives nanomsg request and re-broadcasts it to all subscription servers connected, there can be more than one pub/sub host configured for
    redundancy purposes and to eliminate single point of failure. All subscription servers will receive the published message and send it to the connected HTTP clients
    with matched subscribed key.
  - redis, uses native Redis pub/sub system, every client directly connected to the redis server and subscribed to the events
- the client who issued `/account/subscribe` command may receive the same event more than once, this is expected behaiviour,
  it is responsibility of the client to handle duplicates at this moment, this may change in the future.

## Internal with nanomsg
To use publish/subcribe with nanomsg, first nanomsg must be compiled in the backend module. Usually this is done when explicitely installed with `--backend_deps_force`
options to the npm install, see above how to install the package.

All nodes must have the same configuration, similar to the LRU cache otherwise some unexpected behaviour may happen.
The config parameter `msg-host` defines where to publish messages and from where messages can be retrieved. Having more than one hosts listed will ensure
better reliability of delivering messages but may result in message duplication in some cases when some servers are much slower than others for any reason.

## Redis
To configure the backend to use Redis for local cache set `msg-type=redis` and `redis-host=HOST` where HOST is IP address or hostname of the redis server.
After that all cache requests will be directed to that redis server. The work flow itself is similar to nanomsg internal system, just instead of nanomsg sockets redis
client is used.

# Security configurations

## API only
This is default setup of the backend when all API requests except `/account/add` must provide valid signature and all HTML, Javascript, CSS and image files
are available to everyone. This mode assumes that Web developmnt will be based on 'single-page' design when only data is requested from the Web server and all
rendering is done using Javascript. This is how the `api.html` develpers console is implemented, using JQuery-UI and Knockout.js.

To see current default config parameters run any of the following commands:

        bkjs run-backend -help | grep api-allow

        node -e 'require("backendjs").core.showHelp()'

To disable open registration in this mode just add config parameter `api-disallow-path=^/account/add$` or if developing an application add this in the initMiddleware

        api.initMiddleware = function(callback) {
            this.allow.splice(this.allow.indexOf('^/account/add$'), 1);
        }

## Secure Web site, client verification
This is a mode when the whole Web site is secure by default, even access to the HTML files must be authenticated. In this mode the pages must defined 'Backend.session = true'
during the initialization on every html page, it will enable Web sessions for the site and then no need to sign every API reauest.

The typical client Javascript verification for the html page may look like this, it will redirect to login page if needed,
this assumes the default path '/public' still allowed without the signature:

        <link href="/styles/jquery-ui.css" rel="stylesheet" type="text/css" />
        <script src="/js/jquery.js" type="text/javascript"></script>
        <script src="/js/jquery-ui.js" type="text/javascript"></script>
        <script src="/js/knockout.js" type="text/javascript"></script>
        <script src="/js/crypto.js" type="text/javascript"></script>
        <script src="js/backend.js" type="text/javascript"></script>
        <script src="js/backend-jquery-ui.js" type="text/javascript"></script>
        <script>
        $(function () {
            Backend.session = true;
            Backend.scramble = true;
            ko.applyBindings(Backend);

            Backend.login(function(err, data) {
                if (err) window.location='/public/index.html';
            });
        });
        </script>

## Secure Web site, backend verification
On the backend side in your application app.js it needs more secure settings defined i.e. no html except /public will be accessible and
in case of error will be redirected to the login page by the server. Note, in the login page `Backend.session` must be set to true for all
html pages to work after login without singing every API request.

First we disable all allowed paths to the html and registration:

        api.initMiddleware = function(callback) {
            self.allow.splice(self.allow.indexOf('^/$'), 1);
            self.allow.splice(self.allow.indexOf('\\.html$'), 1);
            self.allow.splice(self.allow.indexOf('^/account/add$'), 1);
        }


Second we define auth callback in the app and redirect to login if the reauest has no valid signature, we check all html pages, all allowed html pages from the /public
will never end up in this callback because it is called after the signature check but allowed pages are served before that:

        api.registerAuthCheck('', /^\/$|\.html$/, function(req, status, callback) {
            if (status.status != 200) {
                status.status = 302;
                status.url = '/public/index.html';
            }
            callback(status);
        });

# The backend provisioning utility: bkjs

The purpose of the `bkjs` shell script is to act as a helper tool in configuring and managing the backend environment
and as well to be used in operations on production systems. It is not required for the backend operations and provided as a convenience tool
which is used in the backend development and can be useful for others running or testing the backend.

Running without arguments will bring help screen with description of all available commands.

The tool is multi-command utility where the first argument is the command to be executed with optional additional arguments if needed.
On startup the bkjs tries to load and source the following config files:

        /etc/backendrc
        /usr/local/etc/backendrc
        ~/.backend/etc/profile

Any of the following config files can redefine any environmnt variable thus pointing to the correct backend environment directory or
customize the running environment, these should be regular shell scripts using bash syntax.

Most common used commands are:
- bkjs run-backend - run the backend or the app for development purposes, uses local app.js if exists otherwise runs generic server
- bkjs run-shell - start REPL shell with the backend module loaded and available for use, all submodules are availablein the shell as well like core, db, api
- bkjs init-app - create the app skeleton
- bkjs put-backend path [-host host] - sync sources of the app with the remote site, uses BACKEND_MASTER env variable for host if not specified in the command line, this is for developent version of the backend only
- bkjs setup-server [-root path] [-user user] - initialize Linux instance(Amazon,CentOS) for backend use, optional -root can be specified where the backend
   home will be instead of ~/.backend, optional -user tells to use existing user instead of creating user backend.

# Deployment use cases

## AWS instance setup

Here is the typical example how to setup new AWS server, it is not required and completely optional but bkjs provies some helpful commands that may simplify
new image configuration.

- start new AWS instance via AWS console, use Amazon Linux or CentOS 6
- login as `ec2-user`
- get bkjs: `curl -OL https://raw.githubusercontent.com/vseryakov/backendjs/master/bkjs'
- run `sudo ./bkjs setup-server -root /home/backend`
- global system-wide options will be defined in the `/etc/backendrc` like BACKEND_ARGS, BACKEND_NAME, BACKEND_ROOT env variables
- reboot
- login as `backend` user using the AWS keypair private key
- run `ps agx`, it should show several backend processes running
- try to access the instance via HTTP port for the API console or documentation

## Configure HTTP port

The first thing when deploying the backend into production is to change API HTTP port, by default is is 8000, but we would want port 80 so regardless
how the environment is setup it is ultimatley 2 ways to specify the port for HTTP server to use:

- config file

  The config file is always located in the etc/ folder in the backend home directory, how the home is specified depends on the system but basically it can be
  defined via command line arguments as `-home` or via environment variables when using bkjs. See bkjs documentation but on AWS instances created with bkjs
  `setup-server` command, for non-standard home use `/etc/backendrc` profile, specify `BACKEND_HOME=/home/backend` there and the rest will be taken care of

- command line arguments

  When running node scripts which use the backend, just specify `-home` command line argument with the directory where yor backend should be and the backend will use it

  Example:

        node app.js -home $HOME -port 80

- config database

  If `-db-config` is specified in the command line or `db-config=` in the local config file, this will trigger loading additional
  config parameters from the specified databae pool, it will load all records from tbe bk_config table on that db pool. `db-config` defines the
  configuration group or type to load, by default the config group is 'core', so even if ther is only one config group it must be specified in the `db-config`
  parameter. Using the database to store configuration make it easier to maintain dynamic environment for example in case of auto scaling or lanching on demand, this way
  a new instance will query current config from the database and this eliminates supporting text files and distributing them to all instances.

- DNS records
  Some config options may be kept in the DNS TXT records and every time a instance is started it will query the local DNS for such parameters. Only a small subset of
  all config parameters support DNS store. To see which parmeteres can be stored in the DNS run `bkjs show-help` and look for 'DNS TXT configurable'.

# Security
All requests to the API server must be signed with account login/secret pair.

- The algorithm how to sign HTTP requests (Version 1, 2):
    * Split url to path and query parameters with "?"
    * Split query parameters with "&"
    * '''ignore parameters with empty names'''
    * '''Sort''' list of parameters alphabetically
    * Join sorted list of parameters with "&"
        - Make sure all + are encoded as %2B
    * Form canonical string to be signed as the following:
        - Line1: The HTTP method(GET), followed by a newline.
        - Line2: the host, lowercase, followed by a newline.
        - Line3: The request URI (/), followed by a newline.
        - Line4: The sorted and joined query parameters as one string, followed by a newline.
        - Line5: The expiration value in milliseconds, required, followed by a newline
        - Line6: The Content-Type HTTP header, lowercase, followed by a newline
    * Computed HMAC-SHA1 digest from the canonical string and encode it as BASE64 string, preserve trailing = if any
    * Form BK-Signature HTTP header as the following:
        - The header string consist of multiple fields separated by pipe |
            - Field1: Signature version:
                - version 1, normal signature
                - version 2, only used in session cookies, not headers
                - version 3, same as 1 but uses SHA256
            - Field2: Application version or other app specific data
            - Field3: account login or whatever it might be in the login column
            - Field4: HMAC-SHA digest from the canonical string, version 1 o 3 defines SHA1 or SHA256
            - Field5: expiration value in milliseconds, same as in the canonical string
            - Field6: SHA1 checksum of the body content, optional, for JSON and other forms of requests not supported by query paremeters
            - Field7: empty, reserved for future use

The resulting signature is sent as HTTP header bk-signature: string

For JSON content type, the method must be POST and no query parameters specified, instead everything should be inside the JSON object
which is placed in the body of the request. For additional safety, SHA1 checksum of the JSON paylod can be calculated and passed in the signature,
this is the only way to ensure the body is not modified when not using query parameters.

See web/js/backend.js for function Backend.sign or function core.signRequest in the core.js for the Javascript implementation.

# Backend framework development (Mac OS X, developers)

* for DB drivers and ImageMagick to work propely it needs some dependencies to be installed:

        port install libpng jpeg tiff lcms2 mysql56 postgresql93

* make sure there is no openjpeg15 installed, it will conflict with ImageMagick jp2 codec

* `git clone https://github.com/vseryakov/backendjs.git` or `git clone git@github.com:vseryakov/backendjs.git`

* cd backendjs

* if node.js is already installed skip to the next section

    * node.js can be compiled by the bkjs and installed into default location, on Darwin it is /opt/local
    * to install node into other location, BACKEND_PREFIX needs to be set
    * to change $BACKEND_PREFIX, create ~/.backend/etc/profile file, for example:

        mkdir -p ~/.backend/etc
        echo "BACKEND_PREFIX=$HOME/local" > ~/.backend/etc/profile

    * **Important**: Add NODE_PATH=$BACKEND_PREFIX/lib/node_modules to your environment in .profile or .bash_profile so
      node can find global modules, replace $BACKEND_PREFIX with the actual path unless this variable is also set in the .profile

    * to install node.js in $BACKEND_PREFIX/bin run command:

            ./bkjs build-node

* to compile the binary module and all required dependencies just type `make` or `npm build .`

    * to see the actual compiler settings during compilation the following helps:

            make V=1

    * to compile with internal nanomsg and ImageMagick use:

            make force V=1

* to install all dependencies and make backendjs module and bkjs globally available:

            npm link

* to run local server on port 8000 run command:

        ./bkjs run-backend

* to start the backend in command line mode, the backend environment is prepared and initialized including all database pools.
   This command line access allows you to test and run all functions from all modules of the backend without running full server
   similar to node.js REPL functionality. All modules are accessible from the command line.

        $ ./bkjs run-shell
        > core.version
         '2013.10.20.0'
        > logger.setDebug(2)

# Author
  Vlad Seryakov

Check out the [Documentation](http://vseryakov.github.io/backendjs/) for more documentation.

