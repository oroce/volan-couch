/**
 * New Relic agent configuration.
 *
 * See lib/config.defaults.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
var nconf = require( "nconf" );
var pkg = require( "./package.json" );
exports.config = {
  /**
   * Array of application names.
   */
  app_name : [ pkg.name ],
  /**
   * Your New Relic license key.
   */
  license_key : nconf.get( "newrelic" ),
  logging : {
    /**
     * Level at which to log. 'trace' is most useful to New Relic when diagnosing
     * issues with the agent, 'info' and higher will impose the least overhead on
     * production applications.
     */
    level : "trace"
  }
};
