// -----------------------------------------
// Distributed testing
// -----------------------------------------
//
// This file defines remoteTest, remoteStart, and remoteStartFile.
//
// This file contains the API for distributing load tests across multiple nodeload instances. See
// NODELOADLIB.md for instructions on running a distributed test. 
//
// Distributed tests work as follows:
// 1. One node is designated as master, and the others are slaves
// 2. The master node POSTs a string containing valid javascript to http://slave/remote on each slave
// 3. Each slave executes the javascript by calling eval().
// 4. Each slave periodically POSTs statistics as a JSON string back to the master at http://master/remote/progress
// 5. The master aggregates these statistics and generates reports just like a regular, non-distributed 
//    nodeloadlib instance
//

/** Returns a test that can be scheduled with `remoteStart(spec)` (See TEST_OPTIONS in api.js for a list
    of the configuration values supported in the test specification */
var remoteTest = exports.remoteTest = function(spec) {
    return "(function() {\n" +
            "  var remoteSpec = JSON.parse('" + JSON.stringify(spec) + "');\n" +
            "  remoteSpec.requestGenerator = " + spec.requestGenerator + ";\n" +
            "  remoteSpec.requestLoop = " + spec.requestLoop + ";\n" +
            "  remoteSpec.reportFun = " + spec.reportFun + ";\n" +
            "  addTest(remoteSpec);\n" +
            "})();";
}

/** Run the list of tests, created by remoteTest(spec), on the specified slaves. Slaves periodically
report statistics to master. When tests complete, callback is called. If stayAliveAfterDone == true, the
nodeload HTTP server will remain running. Otherwise, the server will automatically terminate. */
var remoteStart = exports.remoteStart = function(master, slaves, tests, callback, stayAliveAfterDone) {
    var remoteFun = tests.join('\n') + '\nstartTests();';
    remoteSubmit(master, slaves, remoteFun, callback, stayAliveAfterDone);
}

/** Same as remoteStart(...), except runs a .js script rather than tests created using remoteTest(spec).
The script should use `addTest()` and `startTests()` to create and start tests, as if it were to run on
the local machine, not remoteTest(). */
var remoteStartFile = exports.remoteStartFile = function(master, slaves, filename, callback, stayAliveAfterDone) {
    fs.readFile(filename, function (err, data) {
        if (err != null) throw err;
        data = data.toString().replace(/^#![^\n]+\n/, '// removed shebang directive from runnable script\n');
        remoteSubmit(master, slaves, data, callback, stayAliveAfterDone);
    });
}

// =================
// Private
// =================
var SLAVE_CONFIG = null;
var WORKER_POOL = null;
var REMOTE_TESTS = {};

/** Creates a RemoteWorkerPool with the given master and slave and runs the specified code, fun, on every
slave node in the pool. fun is a string containing valid Javascript. callback and stayAliveAfterDone are
the same as for remoteStart(). */
function remoteSubmit(master, slaves, fun, callback, stayAliveAfterDone) {
    var finished = function() {
        SCHEDULER.stopAll();
        TEST_MONITOR.stop();
        
        callback && callback();

        if (!stayAliveAfterDone && !SLAVE_CONFIG) {
            checkToExitProcess();
        }
    }
    
    WORKER_POOL = new RemoteWorkerPool(master, slaves, fun);
    WORKER_POOL.start(finished, stayAliveAfterDone);

    // Start the master's scheduler so that received stats are processed by STATS_MANAGER
    TEST_MONITOR.start();
    SCHEDULER.startAll();
}

/** Converts this nodeload instance into a slave node by defining the global variable SLAVE_CONFIG. A
slave node differ from normal (master) node because it sends statistics to a master node. */
function registerSlave(id, master) {
    SLAVE_CONFIG = new RemoteSlave(id, master);
    TEST_MONITOR.on('test', function(test) { SLAVE_CONFIG.addTest(test) });
    TEST_MONITOR.on('update', function() { SLAVE_CONFIG.reportProgress() });
    TEST_MONITOR.on('end', function() { SLAVE_CONFIG.clearTests() });
}

/** Process data POSTed by a slave to http://master/remote/newTest indicating that addTest() was called
*/
function receiveTestCreate(report) {
    if (WORKER_POOL.slaves[report.slaveId] === undefined) { return; }

    var localtest = REMOTE_TESTS[report.spec.name];
    if (localtest === undefined) {
        localtest = { spec: report.spec, stats: {}, jobs: [], fun: null }
        REMOTE_TESTS[report.spec.name] = localtest;
        TEST_MONITOR.addTest(localtest);
    }
}

/** Merge in the statistics data POSTed by a slave to http://master/remote/progress */
function receiveTestProgress(report) {
    if (WORKER_POOL.slaves[report.slaveId] === undefined) { return; }

    WORKER_POOL.slaves[report.slaveId].state = "running";

    // Slave report contains {testname: { stats: { statsname -> stats data }}. See RemoteSlave.reportProgress(); 
    for (var testname in report.data) {
        var localtest = REMOTE_TESTS[testname];
        var remotetest = report.data[testname];
        if (localtest) {
            for (var s in remotetest.stats) {
                var remotestat = remotetest.stats[s];
                var localstat = localtest.stats[s];
                if (localstat === undefined) {
                    var backend = statsClassFromString(remotestat.interval.type);
                    localstat = new Reportable([backend, remotestat.interval.params], remotestat.name, remotestat.trend);
                    localtest.stats[s] = localstat;
                }
                localstat.merge(remotestat.interval);
            }
        } else {
            qputs("WARN: received remote progress report from '" + report.slaveId + "' for unknown test: " + testname);
        }
    }
}

/** A RemoteSlave represents a slave nodeload instance. RemoteSlave.reportProgress() POSTs statistics as
a JSON object to http://master/remote/progress. The object contains:
{
    slaveId: my unique id assigned by the master node
    report: { 
        test-name: { 
            stats: {    
                // mirrors the fields of Reportable
                name: name of stat
                trend: should history of this stat be tracked
                interval: stats data from current interval
            }
        }
    }
}
*/
function RemoteSlave(id, master) {
    this.id = id;
    this.tests = [];
    if (master) {
        master = master.split(':');
        this.masterhost = master[0];
        this.master = http.createClient(master[1], master[0]);
    }
}
RemoteSlave.prototype = {
    addTest: function(test) {
        this.tests.push(test);
        this.sendReport_('/remote/newTest', {slaveId: this.id, spec: test.spec});
    },
    clearTests: function() {
        this.tests = [];
    },
    reportProgress: function() {
        var reports = {};
        for (var i in this.tests) {
            var test = this.tests[i];
            var stats = {};
            for (var s in test.stats) {
                stats[s] = {
                    name: test.stats[s].name,
                    trend: test.stats[s].trend,
                    interval: test.stats[s].interval
                }
            }
            reports[test.spec.name] = { stats: stats };
        }
        this.sendReport_('/remote/progress', {slaveId: this.id, data: reports});
    },
    sendReport_: function(url, object) {
        if (this.master) {
            var s = JSON.stringify(object);
            var req = this.master.request('POST', url, {'host': this.masterhost, 'content-length': s.length});
            req.write(s);
            req.end();
        }
    }
}


/** Represents a pool of nodeload instances with one master and multiple slaves. master and each slave is
specified as a string "host:port". Each slave node executes the Javascript specified in the "fun" string.
A slave indicates that is has completed its task when http://slave/remote/state returns a 410 status.
When all slaves are done, "callback" is executed. */
function RemoteWorkerPool(master, slaves, fun) {
    this.master = master;
    this.slaves = {};
    this.fun = fun;
    this.callback = null;
    this.pingId = null;
    this.progressId = null;

    for (var i in slaves) {
        var slave = slaves[i].split(":");
        this.slaves[slaves[i]] = {
            id: slaves[i],
            state: "notstarted",
            host: slave[0], 
            client: http.createClient(slave[1], slave[0])
        };
    }
}
RemoteWorkerPool.prototype = {
    /** Run the Javascript in the string RemoteWorkerPool.fun on each of the slave node and register a
    periodic alive check for each slave. */
    start: function(callback, stayAliveAfterDone) {
        // Construct a Javascript string which converts a nodeloadlib instance to a slave, executes the
        // contents of "fun" by placing it in an anonymous function call:
        //      registerSlave(slave-id, master-host:port);
        //      (function() { 
        //          contents of "fun", which usually contains calls to addTest(), startTests(), etc
        //      })()
        var fun = "(function() {" + this.fun + "})();";
        for (var i in this.slaves) {
            var slave = this.slaves[i],
                slaveFun = '';

            if (this.master) {
                slaveFun = "registerSlave('" + i + "','" + this.master  + "');\n" + fun;
            } else {
                slaveFun = "registerSlave('" + i + "');\n" + fun;
            }
            
            // POST the Javascript string to each slave which will eval() it.
            var r = slave.client.request('POST', '/remote', {'host': slave.host, 'content-length': slaveFun.length});
            r.write(slaveFun);
            r.end();
            slave.state = "running";
        }

        // Register a period ping to make sure slave is still alive
        var worker = this;
        this.pingId = setInterval(function() { worker.sendPings() }, NODELOAD_CONFIG.SLAVE_PING_INTERVAL_MS);
        this.callback = callback;
    },
    /** Called after each round of slave pings to see if all the slaves have finished. A slave is "finished"
        if it reports that it finished successfully, or if it fails to respond to a ping and flagged with
        an error state. When all slaves are finished, the overall test is considered complete and the user 
        defined callback function is called. */
    checkFinished_: function() {
        for (var i in this.slaves) {
            if (this.slaves[i].state != "done" && this.slaves[i].state != "error") {
                return;
            }
        }
        qprint("\nRemote tests complete.");
        
        var callback = this.callback;
        clearInterval(this.pingId);
        this.callback = null;
        this.slaves = {};
        
        callback && callback();
    },
    /** Issue a GET request to each slave at "http://slave/remote/state". This function is called every
        SLAVE_PING_PERIOD seconds. If a slave fails to respond in that amount of time, it is flagged with
        an error state. A slave will report that it is "done" when its SCHEDULER is no longer running, i.e.
        all its tests ran to completion (or no tests were started, because "fun" didn't call to startTests()). */
    sendPings: function() {
        var worker = this;
        // Read the response from ping() (GET /remote/state)
        var pong = function(slave) { return function(response) {
            if (slave.state == "ping") {
                if (response.statusCode == 200) {
                    slave.state = "running";
                } else if (response.statusCode == 410) {
                    qprint("\n" + slave.id + " done.");
                    slave.state = "done";
                }
            }
        }}
        // Send GET to /remote/state
        var ping = function(slave) {
            slave.state = "ping";
            var r = slave.client.request('GET', '/remote/state', {'host': slave.host, 'content-length': 0});
            r.on('response', pong(slave));
            r.end();
        }

        // Verify every slave responded to the last round of pings. Send ping to slave that are still alive.
        for (var i in this.slaves) {
            if (this.slaves[i].state == "ping") {
                qprint("\nWARN: slave " + i + " unresponsive.");
                this.slaves[i].state = "error";
            } else if (this.slaves[i].state == "running") {
                ping(this.slaves[i]);
            }
        }
        this.checkFinished_();
    }
}

/** Handler for all the requests to /remote. See http.js#startHttpServer(). */
function serveRemote(url, req, res) {
    var readBody = function(req, callback) {
        var body = '';
        req.on('data', function(chunk) { body += chunk });
        req.on('end', function() { callback(body) });
    }
    var sendStatus = function(status) {
        res.writeHead(status, {"Content-Length": 0});
        res.end();
    }
    if (req.method == "POST" && url == "/remote") {
        readBody(req, function(remoteFun) {
            qputs("\nReceived remote command:\n" + remoteFun);
            eval(remoteFun);
            sendStatus(200);
        });
    } else if (req.method == "GET" && req.url == "/remote/state") {
        if (SCHEDULER.running == true) {
            sendStatus(200);
        } else {
            sendStatus(410);
        }
        res.end();
    } else if (req.method == "POST" && url == "/remote/newTest") {
        readBody(req, function(data) {
            receiveTestCreate(JSON.parse(data));
            sendStatus(200);
        });
    } else if (req.method == "POST" && url == "/remote/progress") {
        readBody(req, function(data) {
            receiveTestProgress(JSON.parse(data));
            sendStatus(200);
        });
    } else {
        sendStatus(405);
    }
}
