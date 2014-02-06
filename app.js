require( "http" ).globalAgent.maxSockets = 100;

var nconf = require( "nconf" );

nconf
  .argv()
  .env()
  .defaults({
    port: 8080,
    elasticsearch: {
      host: "localhost:9200",
      log: "error"
    }
  });

if( nconf.get( "newrelic" ) ){
  require( "newrelic" );
}
var
  pkg = require( "./package.json" ),
  restify = require( "restify" ),
  request = require( "request" ),
  async = require( "async" ),
  libxml = require( "libxmljs" ),
  util = require( "util" ),
  _ = require( "underscore" ),
  moment = require( "moment" ),
  qs = require( "querystring" ),
  url = require( "url" ),
  ua = require( "universal-analytics" ),
  logger = require( "./lib/logger" ),
  godot = require( "./lib/godot" ),
  helpers = require( "./lib/helpers" ),
  debug = require( "debug" )( "pt:volan:app" ),
  randomUA = require( "random-ua" );

var server = restify.createServer({
  name: pkg.name,
  version: pkg.version,
  log: logger.shim
});
server.use(restify.queryParser());
server.use(restify.bodyParser());
server.use(restify.fullResponse());
server.pre(function( req, res, next ){
  req.visitor = ua( nconf.get( "ga" ) );
  next();
});
var vm = require( "vm" );
server.get( "/volan", function( req, res, next ){
  var
    from = req.params.from,
    to = req.params.to,
    via = req.params.via;
  var appURL = req.headers.host;
  if( !from || !to ){
    var error = new Error( "Missing from or to parameter" );
    error.statusCode = 400;
    return next( error );
  }
  function onResponse( body, res, next ){
    var err;
    var parseStart = Date.now();
    var doc;
    try{
      doc = libxml.parseHtmlString( body );
    }catch(x){
      err = new Error( "Malformed HTML" );
      err.body = {
        statusCode: 400,
        message: "Menetrendek.hu is down"
      };
      return next( err );
    }
    var boxTable = doc.get( "//table[@class='boxtable']" );
    if( !boxTable ){
      err = new Error( "No timetable was found" );
      req.visitor
        .exception( util.format( "Missing boxtable\n%j", req.params ) )
        .timing( "search", "parse", Date.now() - parseStart, "missing boxtable" );
      err.body = {
        internalReason: "missing boxtable",
        message: err.message,
      };
      err.statusCode = 404;
      return next( err );
    }
    var titleElem = boxTable.get( "./tr[2]/td[1]/div/span/b" );

    var date, route;
    if( titleElem ){
      var parts = titleElem.text().split( " között " );
      route = parts[0];
      date = ( parts[1]||"" ).replace( " napon", "" );
    }

    var resultTable = boxTable.get( "//table[@class='resulttable']" );
    if( !resultTable ){
      req.visitor
        .timing( "search", "parse", Date.now() - parseStart, "missing resulttable" );
      res.setHeader( "X-Reason", "Missing resulttable" );
      res.json({
        timetable: []
      });
      return next();
    }
    var trs = resultTable.find( "./tr[@bgcolor]" );
    var rows = [];
    var counter = 0;
    trs.forEach( function( tr, i ){
      if( !i ){
        return; // unless i #skip the first row
      }
      var tds = tr.find( "./td" );
      if( tds.length < 2 ){
        return;
      }
      //return unless tds.length > 1
      if( counter % 2 === 0 ){
        var detailsParam = tds[ 0 ].get( "./img" ).attr( "onclick" ).value().replace( /.*showhide\(document.getElementById\('.*'\),'(.*)','.*'\).*/, "$1");
        rows.push({
          from: helpers.trimmedText( tds[ 1 ] ),
          to: helpers.trimmedText( tds[ 2 ] ),
          starttime: helpers.trimmedText( tds[ 3 ] ),
          destinationtime: helpers.trimmedText( tds[ 4 ] ),
          change: helpers.trimmedText( tds[ 5 ] ),
          totaltime: helpers.trimmedText( tds[ 6 ] ),
          distance: helpers.trimmedText( tds[ 7 ] ),
          details_param: {
            param: qs.escape( detailsParam )
          },
          details: helpers.buildURI({
            host: appURL,
            protocol: "http:",
            path: "/volan/details",
            query: {
              param: qs.escape( detailsParam )
            }
          })
        });
      }
      else{
        var spans = tds[0].find( "./*/span" );
        _.extend( rows[ rows.length - 1 ], {
          info: spans[0].text().trim(),
          types: _.compact( spans[1].text().trim().split( /\s?\/\s?/ ).map(function( s ){ return s.trim(); }) ),
          text: tds[1].text()
        });
      }
      counter = counter+1;
    });
    if( (/(1)|(true)/).test( req.params.wotransfer ) ){
      rows = rows.filter(function( row ){
        return +row.change === 0;
      });
    }
    req.visitor
        .timing( "search", "parse", Date.now() - parseStart );
    res.json({
      timetable: rows,
      date: date,
      route: route
    });
    next();
  }
  function findProperStation( query, fn ){
    var station, _state;
    var start = Date.now();
    helpers.elasticFindStation( query, {wildcard: false}, function( err, stations ){
      req.visitor
        .timing( "search", "finding-station", Date.now() - start, query );

      var station = stations && stations[ 0 ];
      fn( err, station );
    });
  }
  var fns = {
    from: findProperStation.bind( null, from ),
    to: findProperStation.bind( null, to )
  };
  if( via ){
    fns.via = findProperStation.bind( null, via );
  }
  var fnsStart = Date.now();
  async.parallel( fns, function( err, results ){
    req.visitor
      .timing( "search", "finding-stations", Date.now() - fnsStart, util.format( "from=%s, to=%s, via=%s", from, to, via ) );
    if( err ){
      return next( err );
    }
    if( !results.from || !results.to ){
      err = new Error( "missing to or from" );
      err.body = {
        message: err.message,
        internalReason: "from or to wasnt in db, or haven't been submitted",
        statusCode: 400
      };
      return next( err );
    }

    var date = moment( req.params.date||"", "YYYY.MM.DD" );
    date = ( date.isValid() ? date : moment() ).format( "YYYY-MM-DD" );
    var fromTime = ( req.params.fromtime||"" ).split( ":" ).map(Number).filter(function( val ){
      return val != null;
    }).map(function( val ){
      return ( "0" + val ).slice( -2 );
    });
    var form = {
      utirany:"oda",
      ind_stype:"megallo",
      honnan: results.from.name,
      honnan_settlement_id: results.from.stationId, // + ";00",
      honnan_ls_id: results.from.subId||0,
      erk_stype:"megallo",
      hova: results.to.name,
      hova_settlement_id: results.to.stationId, // + ";00",
      hova_ls_id: results.to.subId||0,
      //hova_is_id: "4872",
      keresztul_stype:"megallo",
      keresztul: results.via ? results.via.name : "",
      keresztul_settlement_id: results.via ? results.via.stationId : "",
      keresztul_ls_id: results.via ? result.via.subId||0 : "",
      keresztul_zoom:"",
      keresztul_eovx:"",
      keresztul_eovy:"",
      keresztul_site_code:"",
      datum: date,
      naptipus:0,
      napszak: fromTime.length ? 3 : 0,
      hour: fromTime[0]||0,
      min: fromTime[1]||0,
      target:0,
      rendezes:1,
      filtering:0,
      "var":0,
      maxvar:240,
      maxatszallas:5,
      preferencia:1,
      helyi:"No",
      maxwalk:700,
      talalatok:1,
      odavissza:0,
      ext_settings:"none",
      submitted:1
    };
    debug( "sending form: %j", form );
    var requestStart = Date.now();
    helpers.makeRequest({
      encoding: null,
      url: "http://ujmenetrend.cdata.hu/uj_menetrend/volan",
      headers: {
       "Referer": "http://ujmenetrend.cdata.hu/uj_menetrend/volan/",
        "User-Agent": randomUA.generate()
      }
    }, function( err, response, body ){
        if( err ){
          return next( err );
        }

        var doc;
        try{
          doc = libxml.parseHtmlString( body );
        }catch(x){
          logger.error( "failed to parse preflight request", x );
          //console.log( "body: " + body );
          err = new Error( "Malformed HTML" );
          err.body = {
            statusCode: 400,
            message: "Menetrendek.hu is down"
          };
          return next( err );
        }
        var evalPart = doc.find( "//script[text()]" ).filter(function( el ){
          return /eval/.test( el.text() );
        })[0];
        var sandbox = {
            document: {
              solution: { value: "", name: "" },
              getElementById: function(){
                return this.solution;
              }
            }
        };
        if( !evalPart ){
          var err = new Error( "Cannot find the secret" );
          err.body = {
            message: "Cannot find the secret",
            statusCode: 404
          };
          return next( err );
        }
        try{
           vm.runInNewContext( evalPart.text(),sandbox );
        }catch( x ){
          var err = new Error( "Failed the vm" );
          err.body = {
            message: "Internal vm error",
            statusCode: 500
          };
          return next( err );;;
        }
        form[ sandbox.document.solution.name ] = sandbox.document.solution.value;
        helpers.makeRequest({
          url: "http://ujmenetrend.cdata.hu/uj_menetrend/volan/talalatok.php",
          encoding: null,
          method: "POST",
          form: form,
          headers: {
            "Referer": "http://ujmenetrend.cdata.hu/uj_menetrend/volan/",
            "User-Agent": randomUA.generate(),
            "Cookie": response.headers["set-cookie"].join( ";" )
          },
        }, function( err, response, body ){
          req.visitor
            .timing( "search", "volan-request", Date.now() - requestStart, util.format( "%j", req.params ) );
            if( err ){
              return next( err );
            }
            onResponse( body, res, next );
        });
      });
    });

});

function detailsHandler( req, res, next ){
  var param = req.params.param;
  var appURL = req.headers.host;
  var requestStart = Date.now();
  helpers.makeRequest({
    url: "http://ujmenetrend.cdata.hu/uj_menetrend/volan/ajax_response_gen.php",
    method: "POST",
    encoding: null,
    headers: {
      "Host":"ujmenetrend.cdata.hu",
      "Origin":"http://ujmenetrend.cdata.hu",
      "Referer":"http://ujmenetrend.cdata.hu/uj_menetrend/volan/talalatok.php",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_7_4) AppleWebKit/537.1 (KHTML, like Gecko) Chrome/21.0.1180.79 Safari/537.1",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: qs.stringify({
      ajaxquery: "query=jarat_kifejtes_text&obj=kifejt_5&runs_array=" + param + "&mapobj=um_map2"
    })
  }, function( err, response, body ){

      req.visitor
        .timing( "details", "volan-request", Date.now() - requestStart );
      if( err ){
        return next( err );
      }
      var parseStart = Date.now();
      var doc = libxml.parseHtmlString( body ); // #body.toString( "utf-8" ).match( /(<table.*>.*<\/table>)/ )[0] )
      var circFix = function( text ){
        return ( text||"" )
          .replace( /õ/gm, "ő" )
          .replace( /û/gm, "ű" );
      };
      var rows = [];
      var trs = doc.find( "//tr" );

      trs.forEach(function( tr, i ){
        if( !i ){
          return;
        }
        var tds = tr.find( "./td" );
        if( tds.length === 2 ){
          return _.extend( rows[ rows.length - 1 ], {
            distance: tds[0].text().trim(),
            days: tds[1].text().trim()
          });
        }
        var busInfo = tds[5].get( "./a" );
        var busInfoUrl = busInfo ? busInfo.attr( "href" ).value() : null;
        busInfoQuery = busInfoUrl ? url.parse( busInfoUrl, true ).query : null;
        var info = tds[4].childNodes().filter(function( node ){
          return node.name() === "text";
        }).map(function( node ){
          return node.text();
        }).join( " - " ).trim();
        rows.push({
          company: tds[0].text().trim(),
          action: tds[1].text().trim(),
          station: circFix( tds[2].text().trim() ),
          time: tds[3].text().trim(),
          info: circFix( info ),
          businfo: busInfoUrl ? helpers.buildURI({
            host: appURL,
            path: "/volan/info",
            query: busInfoQuery
          }) : null,
          vehicle: tds[6].text().trim(),
          otherinfo: tds[7].text().trim()
        });
      });
      req.visitor
        .timing( "details", "parse", Date.now() - parseStart );
      res.json( rows );
      next();
    });
}

server.get( "/volan/details", detailsHandler );

server.post( "/volan/details", detailsHandler );
var elasticFindStation = function( q, options, cb ){
  options || ( options = {} );
  helpers._elasticSearchClient
    .search({
      index: "volan",
      body: {
        query: {
          query_string: {
            fields: [ "stationId", "name", "deaccent" ],
            query: q + ( options.wildcard ? "*" : "" )
          }
        }
      }
    }, function( err, result ){
      if( err || !( result && result.hits ) ){
        return cb( err||new Error( "result is empty" ) );
      }
      var hits = result.hits.hits.map(function( a ){
        return a._source;
      });
      if( options.order ){
        hits = hits.sort(function( a ){
          return !a.parent ? -1 : 1;
        });
      }
      cb( null, hits );
    });
};
server.get( "/volan/station", function( req, res, next ){
  var start = Date.now();

  var q = req.params.q;
  helpers.elasticFindStation( q, { wildcard: true, order: true }, function( err, result ){
    if( err ){
      return next( err );
    }
    req.visitor
      .timing( "station", "search-elastic", Date.now() - start );
    res.json( result );
    next();
  });
});

server.get( "/volan/info", function infoHandler( req, res, next ){
  var preRequestStart = Date.now();
  helpers.makeRequest({
    url: "http://ujmenetrend.cdata.hu/uj_menetrend/volan/"
  }, function( err, response ){
    req.visitor
        .timing( "info", "cookiefetch", Date.now() - preRequestStart );
    if( err ){
      return next( err );
    }
    var requestStart = Date.now();
    helpers.makeRequest({
      url: "http://ujmenetrend.cdata.hu/uj_menetrend/volan/talalat_kifejtes.php",
      qs: req.params,
      headers: {
        "cookie": response.headers[ "set-cookie" ].join( ";" )
      },
      encoding: null
    }, function( err, response, body ){
      req.visitor
        .timing( "info", "volan-request", Date.now() - requestStart );
      if( err ){
         return next( err );
      }
      var nbspFix = function( el ){
        return ( el.text()||"" )
          .replace( "&nbsp;", " " )
          .replace( "&nbsp", " " );
      };
      var parseStart = Date.now();
      var doc = libxml.parseHtmlString( body );
      var trs = doc.find( "//table[@class='kifejtestabla']/tr" );
      var rows = trs.filter(function( tr ){
        return !tr.attr( "bgcolor" );
      }).map(function( tr ){
        var tds = tr.find( "./td" );
        return {
          station: tds[0].text(),
          start: nbspFix( tds[1] ).trim(),
          departure: nbspFix( tds[2] ).trim(),
          start_real: nbspFix( tds[3] ).trim(),
          departure_real: nbspFix( tds[4] ).trim(),
          km: nbspFix( tds[5] ).trim(),
          description: nbspFix( tds[6] ).trim()
        };
      });
      req.visitor
        .timing( "info", "parse", Date.now() - parseStart );
      res.json({
        stations: rows
      });
      next();
    });
  });
});

server.get( "/volan/rss", function( req, res, next ){
  req.headers.accept = "text/xml";
  var start = Date.now();
  request( "http://www.volanbusz.hu/hu/rss/hirek?feedtype=mind", function( err, response, body ){
    req.visitor
      .timing( "rss", "volan-request", Date.now() - start );
    if( err ){
      return next( err );
    }
    var content = body
      .toString()
      .replace( /\.huhu\//gm, ".hu/hu/" );
    res.setHeader( "Content-Type", "text/xml" );
    res.end( content );
    next();
  });
});

function onListen( err ){
  if( err ){
    return logger.error( err );
  }
  logger.info( "server listening on port: %s in mode: %s", server.address().port, server.mode );
}
server
  .on( "uncaughtException", function (request, response, route, err ){
    logger.error( "uncaughtException: %e", err, err );
    request.visitor
      .exception( err + "" )
      .send();
  })
  .on( "listening", onListen )
  .on( "error", onListen )
  .on( "after", function( req, res, route ){

    req.visitor
      .pageview({ dp:req._path, dh: req.headers["x-forwarded-for"]||req.headers.host})
      .timing( "response", req.url, Date.now() - req._time, util.format( "%j", (route||{}).spec ) )
      .event( "clients", req.query.appname||req.headers["user-agent"] )
      .send();
    logger.info( "Request done (%s) with status %s in %s", req.url, res.statusCode, ((Date.now() - req._time)/1000).toFixed(2) );
  });
if( module.parent  ){
  module.exports = server;
}
else{
  server.listen( nconf.get( "port" ) );
}
