//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  April 2013
//

#include "node_backend.h"

#ifdef __APPLE__
#define LOGDEV         "/var/run/syslog"
#else
#define LOGDEV         "/dev/log"
#endif

struct SyslogTls {
    SyslogTls(): sock(-1), port(514), tag("backend"), path(LOGDEV), connected(0), options(0), facility(LOG_USER), severity(LOG_INFO) {}

    int      sock;                /* fd for log */
    int      port;                /* port for remote syslog */
    string   tag;                 /* string to tag the entry with */
    string   path;                /* path to socket or hostname */
    int      connected;           /* have done connect */
    int      options;             /* status bits, set by openlog() */
    int      facility;            /* default facility code */
    int      severity;            /* default severity code */
};

static void _syslogOpen(string path, string tag, int options, int facility);
static void _syslogClose(void);
static void _syslogSend(int severity, string fmt, ...);
static void _syslogSendV(int severity, string fmt, va_list ap);
static void _syslogFreeTls(void *arg);
static SyslogTls *_syslogGetTls(void);

static Handle<Value> syslogInit(const Arguments& args);
static Handle<Value> syslogSend(const Arguments& args);
static Handle<Value> syslogClose(const Arguments& args);

static pthread_key_t key;

void SyslogInit(Handle<Object> target)
{
    HandleScope scope;

    pthread_key_create(&key, _syslogFreeTls);
    NODE_SET_METHOD(target, "syslogInit", syslogInit);
    NODE_SET_METHOD(target, "syslogSend", syslogSend);
    NODE_SET_METHOD(target, "syslogClose", syslogClose);
}

static Handle<Value> syslogInit(const Arguments& args)
{
    HandleScope scope;

    REQUIRE_ARGUMENT_STRING(0, name);
    REQUIRE_ARGUMENT_INT(1, options);
    REQUIRE_ARGUMENT_INT(2, facility);

    _syslogClose();
    _syslogOpen("", *name, options, facility);

    return scope.Close(Undefined());
}

static Handle<Value> syslogSend(const Arguments& args)
{
    HandleScope scope;

    REQUIRE_ARGUMENT_INT(0, level);
    REQUIRE_ARGUMENT_STRING(1, msg);

    _syslogSend(level, "%s", *msg);

    return scope.Close(Undefined());
}

static Handle<Value> syslogClose(const Arguments& args)
{
    HandleScope scope;

    _syslogClose();
    return scope.Close(Undefined());
}


static SyslogTls *_syslogGetTls(void)
{
    SyslogTls *log = (SyslogTls*)pthread_getspecific(key);

    if (!log) {
        log = new SyslogTls;
        pthread_setspecific(key, log);
    }
    return log;
}

static void _syslogFreeTls(void *arg)
{
    SyslogTls *log = (SyslogTls*)arg;

    if (log) {
        if (log->sock != -1) close(log->sock);
        delete log;
    }
}

static void _syslogOpen(string path, string tag, int options, int facility)
{
    SyslogTls *log = _syslogGetTls();
    int changed = 0;

    if (!path.empty() && path != log->path) {
        log->path = path;
        changed = 1;
    }
    if (!tag.empty() && tag != log->tag) {
        log->tag = tag;
        changed = 1;
    }
    if (options && options != log->options) {
        log->options = options;
        changed = 1;
    }
    if (facility != -1 && facility != log->facility) {
        log->facility = facility;
        changed = 1;
    }
    if (changed) {
        _syslogClose();
    }

    if (log->sock == -1) {
        if (!log->path.empty() && log->path[0] == '/') {
            struct sockaddr_un un;
            memset(&un, 0, sizeof(un));
            un.sun_family = AF_UNIX;
            strncpy(un.sun_path, log->path.c_str(), sizeof(un.sun_path) - 1);
            if (log->options & LOG_NDELAY) {
                log->sock = socket(AF_UNIX, SOCK_DGRAM, 0);
            }
            if (log->sock != -1 && !log->connected && connect(log->sock, (struct sockaddr*)&un, sizeof(un)) != -1) {
                log->connected = 1;
            }
        } else {
            struct sockaddr_in sa;
            char *ptr = (char*)strchr(log->path.c_str(), ':');
            if (ptr != NULL) {
                *ptr++ = 0;
                log->port = atoi(ptr);
            }
            memset(&sa, 0, sizeof(struct sockaddr_in));
            sa.sin_family = AF_INET;
            sa.sin_addr.s_addr = inet_addr(log->path.c_str());
            sa.sin_port = htons(log->port);

            if (log->options & LOG_NDELAY) {
                log->sock = socket(AF_INET, SOCK_DGRAM, 0);
            }
            if (log->sock != -1 && !log->connected && connect(log->sock, (struct sockaddr*)&sa, sizeof(sa)) != -1) {
                log->connected = 1;
            }
        }
    }
}

static void _syslogClose(void)
{
    SyslogTls *log = _syslogGetTls();

    if (log->sock != -1) close(log->sock);
    log->sock = -1;
    log->connected = 0;
}

static void _syslogSend(int severity, string fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    _syslogSendV(severity, fmt, ap);
    va_end(ap);
}

static void _syslogSendV(int severity, string fmt, va_list ap)
{
    string buf, err = strerror(errno);
    time_t now = time(NULL);
    int fd, offset;
    SyslogTls *log = _syslogGetTls();

    if (severity == -1) severity = log->severity;

    // see if we should just throw out this message
    if (!LOG_MASK(LOG_PRI(severity)) || (severity &~ (LOG_PRIMASK|LOG_FACMASK))) return;

    if (log->sock < 0 || !log->connected) {
        _syslogOpen("", "", log->options | LOG_NDELAY, -1);
        if (!log->connected) return;
    }

    // set default facility if none specified
    if ((severity & LOG_FACMASK) == 0) severity |= log->facility;

    // build the message
    buf = vFmtStr("<%d>%.15s ", severity, ctime(&now) + 4);
    offset = buf.size();

    if (!log->tag.empty()) buf += log->tag;
    if (log->options & LOG_PID) buf += vFmtStr("[%d]", getpid());
    if (!log->tag.empty()) buf += ": ";

    // substitute error message for %m
    buf += vFmtStrV(strReplace(fmt, "%m", err), ap);

    // output to stderr if requested
    if (log->options & LOG_PERROR) {
        write(2, buf.c_str() + offset, buf.size() - offset);
    }

    // output to the syslog socket
    write(log->sock, buf.c_str(), buf.size());

    // output to the console if requested
    if (log->options & LOG_CONS) {
        if ((fd = open("/dev/console", O_WRONLY|O_NOCTTY, 0)) < 0) return;
        buf += "\r\n";
        const char *p = index(buf.c_str(), '>') + 1;
        write(fd, p, buf.size() - (p - buf.c_str()));
        close(fd);
    }
}

