var
  elasticsearch = require( "elasticsearch" ),
  URI = require( "URIjs" ),
  nconf = require( "nconf" ),
  request = require( "request" );

var elasticSearchClient = new elasticsearch.Client({
  host: nconf.get( "elasticsearch:host" ),
  log: nconf.get( "elasticsearch:log" )
});
exports._elasticSearchClient = elasticSearchClient;
exports.elasticFindStation = function elasticFindStation( q, options, cb ){
  options || ( options = {} );
  elasticSearchClient
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

exports.trimmedText = function trimmedText( el ){
  if( !el ){
    return "";
  }
  return el.text().trim();
};

exports.makeRequest = function makeRequest( options, cb ){
  if( nconf.get( "proxy" ) ){
    options.headers || ( options.headers = {} );
    options.headers[ "target-host" ] = options.url||options.uri;
    delete options.url;
    delete options.uri;
    options.url = nconf.get( "proxy" );
  }
  return request( options, cb );
};

exports.buildURI = function buildURI( options ){
  return new URI()
    .host( options.host||"" )
    .protocol( options.protocol||"http:" )
    .path( options.path||"" )
    .query( options.query )
    .toString();
};