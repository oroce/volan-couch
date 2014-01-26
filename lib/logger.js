"use strict";

var
  bunyan = require( "bunyan" ),
  winston = require( "winston" ),
  pkg = require( "../package.json" ),
  nconf = require( "nconf" );
require( "winston-loggly" ),
// shameslessly stolen from: https://github.com/flatiron/winston/issues/280

var
  winstonCommon = require( "winston/lib/winston/common" ),
  _log = winstonCommon.log;
function errorToStack( obj ){
  var copy,k,i;

  if( obj == null || typeof obj !== "object" ){
    return obj;
  }

  if(obj instanceof Error ){
    return obj.stack;
  }

  if( obj instanceof Date || obj instanceof RegExp ){
    return obj;
  }

  if( obj instanceof Array ){
    copy = [];
    for (i in obj) {
      copy[ i ] = errorToStack( obj[i] );
    }
    return copy;
  }
  else{
    copy = {};
    for( k in obj ){
      if( obj.hasOwnProperty( k ) ){
        copy[ k ] = errorToStack( obj[ k ] );
      }
    }
  }
}

winstonCommon.log = function (options) {
  if( options != null && typeof options === "object" && typeof options.meta === "object" ){
    options.meta = errorToStack( options.meta );
  }
  return _log( options );
};


function Bunyan2Winston(wlog) {
    this.wlog = wlog;
}
Bunyan2Winston.prototype.write = function write(rec) {
  console.log("writing", rec );
    var wlevel;
    if (rec.level <= bunyan.INFO) {
        wlevel = "info";
    } else if (rec.level <= bunyan.WARN) {
        wlevel = "warn";
    } else {
        wlevel = "error";
    }

    var msg = rec.msg;
    delete rec.msg;

    delete rec.v;
    delete rec.level;
    
    rec.time = String(rec.time);
    this.wlog.log(wlevel, msg, rec);
};



var log = new ( winston.Logger )({
  exitOnError: true,
  handleExceptions: !true,
  transports: [ new ( winston.transports.Console )({timestamp: true, handleExceptions: !true}) ]
});

if( nconf.get( "loggly" ) ){
  log.add( winston.transports.Loggly, {
    "subdomain": nconf.get( "loggly:subdomain" ),
    "inputToken": nconf.get( "loggly:token" )
  });
}


var shim = bunyan.createLogger({
  name: pkg.name,
  streams: [{
      type: "raw",
      level: "trace",
      stream: new Bunyan2Winston(log)
  }]
});


exports.shim = shim;
module.exports = log;