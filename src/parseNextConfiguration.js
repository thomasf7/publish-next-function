// Based on plugin by Daniel Condemarin
// https://github.com/danielcondemarin/serverless-nextjs-plugin/blob/master/packages/serverless-nextjs-plugin/lib/parseNextConfiguration.js

let nextLoadConfig;
let PHASE_PRODUCTION_BUILD;
try {
  nextLoadConfig = require(`${process.env.GITHUB_WORKSPACE}/node_modules/next-server/dist/server/config`).default;
  PHASE_PRODUCTION_BUILD = require(`${process.env.GITHUB_WORKSPACE}/node_modules/next-server/dist/lib/constants`)
    .PHASE_PRODUCTION_BUILD;
} catch (e) {
  // https://github.com/danielcondemarin/serverless-next.js/issues/157
  // Some files were moved in the dist/ directory in next.js 9.0.6
  // check the new location if the old location failed.
  nextLoadConfig = require(`${process.env.GITHUB_WORKSPACE}/node_modules/next/dist/next-server/server/config`).default;
  PHASE_PRODUCTION_BUILD = require(`${process.env.GITHUB_WORKSPACE}/node_modules/next/dist/next-server/lib/constants`)
    .PHASE_PRODUCTION_BUILD;
}

function parseNextConfiguration(nextConfigDir) {
  const nextConfiguration = nextLoadConfig(
    PHASE_PRODUCTION_BUILD,
    nextConfigDir
  );

  // Always use serverless configuration target
  nextConfiguration.target = "serverless";

  return nextConfiguration;
};

exports.parseNextConfiguration = parseNextConfiguration;