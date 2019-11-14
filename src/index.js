const core = require("@actions/core");
const github = require("@actions/github");
const { promisify } = require("util");
const { exec } = require("child_process");
const fse = require("fs-extra");
const { join } = require("path");
const archiver = require("archiver");

const execAsyncInternal = promisify(exec);

const { NextBuild } = require("./next");
const { proxiesJson, handler, functionJson, hostJson } = require("./templates");

async function run() {
  try {
    const config = loadConfig();

    await checkAzureCliIsAvailable();
    if (config.isPullRequest && config.action === "closed") {
      console.log("cleaning up closed pull request resources.");
      await clean(config);
    } else {
      await build(config);
      await package(config);
      await deploy(config);
      await configureAppSettings(config);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

function loadConfig() {
  const configJSON = core.getInput("configuration");
  const pullRequestJSON = core.getInput("pull-request");
  const appSecretsJSON = core.getInput("app-settings");

  if (!configJSON) {
    throw new Error("Configuration is missing");
  }

  const config = JSON.parse(configJSON);
  config.action = github.context.payload.action;
  config.sourcePath = process.env.GITHUB_WORKSPACE;
  config.isPullRequest = false;
  config.pullRequestId = undefined;
  config.eventName = github.context.eventName;
  config.appSecretsJSON = appSecretsJSON;

  if (pullRequestJSON) {
    config.isPullRequest = JSON.parse(pullRequestJSON);
    if (config.isPullRequest) {
      if (config.eventName !== "pull_request") {
        throw new Error(
          `Unable to run in pull request mode when event is not 'pull_request'. Actual event: ${eventName}`
        );
      } else {
        config.pullRequestId = github.context.payload.pull_request.id;
      }
    }
  }

  if (!config.subscriptionId) {
    throw new Error("Configuration value is missing: subscriptionId");
  }

  if (!config.resourceGroup) {
    throw new Error("Configuration value is missing: resourceGroup");
  }

  if (!config.location) {
    throw new Error("Configuration value is missing: location");
  }

  if (!config.name) {
    throw new Error("Configuration value is missing: name");
  }

  if (!config.storageAccount) {
    throw new Error("Configuration value is missing: storageAccount");
  }

  if (!config.buildOutputDir) {
    config.buildOutputDir = "build";
  }

  if (!config.assetsContainerName) {
    config.assetsContainerName = "assets";
  }

  config.buildOutputPath = join(config.sourcePath, config.buildOutputDir);
  config.buildPagesOutputPath = join(config.buildOutputPath, "pages");
  config.buildAssetOutputPath = join(config.buildOutputPath, "assets");

  if (config.isPullRequest && config.pullRequestId) {
    // if this is running as a PR action, adjust the config to deploy a unique instance for this PR

    // build a name from the provided name plus pull request id and make sure it doesn't exceed the 60 character limit
    const pullRequestSuffix = `-${config.pullRequestId}`;
    const nameLength = 60 - pullRequestSuffix.length;
    // trim the provided name so the pull request id will fit and remove any non-alphanumeric characters from the end
    const trimmedName = config.name
      .substring(0, nameLength)
      .replace(new RegExp("[^a-zA-Z0-9]+$"), "");
    config.name = `${trimmedName}-${config.pullRequestId}`;

    // use a shared pr storage account with pr prefix - make sure it doesn't exceed the 24 character name limit
    config.storageAccount = `pr${config.storageAccount}`.substring(0, 24);

    // use a unique container for assets for each PR inside the shared storage account
    config.assetsContainerName = `${config.assetsContainerName}-${config.pullRequestId}`;
  }

  return config;
}

async function checkAzureCliIsAvailable() {
  try {
    await execAsyncInternal(`az --version`);
  } catch (error) {
    console.log("Unable to find Azure CLI");
    throw new Error(error);
  }
}

async function build(config) {
  const { sourcePath } = config;

  console.log("Building next application");
  let nextBuild;
  try {
    nextBuild = require.main.require(
      `${sourcePath}/node_modules/next/dist/build`
    ).default;
  } catch (e) {
    throw new Error(
      "Unable to load next module. Make sure next is in your package.json and you have run 'npm install'."
    );
  }
  const { parseNextConfiguration } = require("./parseNextConfiguration");
  const nextConfig = parseNextConfiguration(sourcePath);
  await nextBuild(sourcePath, nextConfig);
}

async function package(config) {
  const {
    sourcePath,
    buildOutputPath,
    storageAccount,
    assetsContainerName,
    buildPagesOutputPath,
    buildAssetOutputPath
  } = config;

  console.log("Packaging next application");

  console.log("Scanning next build output");
  const buildOutput = new NextBuild(sourcePath);
  await buildOutput.init(buildPagesOutputPath);

  console.log("Processing SSR pages...");
  // Wrap non-static pages in custom handler
  for (const page of buildOutput.pages.filter(
    p => !p.isStatic && !p.isSpecial
  )) {
    // Copying to new folder
    await fse.copy(page.pageSourcePath, page.targetPath);

    // Wrapping with handler
    await fse.writeFile(
      join(page.targetFolder, "index.js"),
      handler(page.targetPageFileName),
      {
        encoding: "utf-8"
      }
    );

    // Adding function declaration
    await fse.writeFile(
      join(page.targetFolder, "function.json"),
      functionJson(page),
      {
        encoding: "utf-8"
      }
    );
  }

  console.log("Generating proxy configuration...");
  await fse.writeFile(
    join(buildPagesOutputPath, "proxies.json"),
    proxiesJson(
      `https://${storageAccount}.blob.core.windows.net/${assetsContainerName}/`,
      buildOutput.pages
    ),
    {
      encoding: "utf-8"
    }
  );

  console.log("Generating host configuration...");
  await fse.writeFile(join(buildPagesOutputPath, "host.json"), hostJson(), {
    encoding: "utf-8"
  });

  console.log("Copying static assets");
  await fse.copy(
    join(sourcePath, ".next/static"),
    join(buildAssetOutputPath, "static")
  );

  for (const staticPage of buildOutput.pages.filter(p => p.isStatic)) {
    await fse.copy(
      staticPage.pageSourcePath,
      join(buildAssetOutputPath, "pages", staticPage.targetPageFileName)
    );
  }

  console.log("Building Azure functions package");
  const packageFilename = "package.zip";

  await new Promise((resolve, reject) => {
    const output = fse.createWriteStream(
      join(buildOutputPath, packageFilename)
    );
    output.on("finish", resolve);
    output.on("error", reject);

    const archive = archiver("zip", {
      zlib: { level: 0 }
    });

    archive
      .glob(`**/*`, {
        ignore: packageFilename,
        cwd: buildPagesOutputPath
      })
      .on("error", reject)
      .pipe(output);
    archive.finalize();
  });

  await fse.writeFile(
    join(buildOutputPath, "packagename.txt"),
    packageFilename,
    {
      encoding: "utf-8"
    }
  );

  // Clean up directories
  await fse.remove(buildPagesOutputPath);
}

async function deploy(config) {
  const {
    sourcePath,
    buildOutputPath,
    subscriptionId,
    location,
    resourceGroup,
    storageAccount,
    assetsContainerName,
    name,
    buildAssetOutputPath,
    plan
  } = config;

  console.log("Deploying next application");

  try {
    console.log(`Creating resource group '${resourceGroup}'...`);
    await execAsyncInternal(
      `az group create --subscription ${subscriptionId} --name ${resourceGroup} --location ${location}`
    );
  } catch (error) {
    console.log("Unable to create resource group");
    throw error;
  }

  try {
    console.log(`Creating storage account '${storageAccount}'...`);
    await execAsyncInternal(
      `az storage account create --subscription ${subscriptionId} --name ${storageAccount} --location ${location} --resource-group ${resourceGroup} --kind StorageV2 --sku Standard_LRS`
    );
  } catch (error) {
    console.log("Unable to create storage account");
    throw error;
  }

  try {
    console.log(`Creating storage container '${assetsContainerName}'...`);
    await execAsyncInternal(
      `az storage container create --subscription ${subscriptionId} --name ${assetsContainerName} --account-name ${storageAccount}`
    );
  } catch (error) {
    console.log("Unable to create storage container");
    throw error;
  }

  try {
    console.log(`Setting storage container permissions...`);
    await execAsyncInternal(
      `az storage container set-permission --public-access blob --subscription ${subscriptionId} --account-name ${storageAccount} --name ${assetsContainerName}`
    );
  } catch (error) {
    console.log("Unable to set storage container permissions");
    throw error;
  }

  try {
    if (plan) {
      console.log(`Creating function app '${name}' using '${plan}' plan...`);
      await execAsyncInternal(
        `az functionapp create --subscription ${subscriptionId} --resource-group ${resourceGroup} --plan ${plan} \
  --name ${name} --storage-account ${storageAccount} --runtime node`
      );
    } else {
      console.log(`Creating function app '${name}' using consumption plan...`);
      await execAsyncInternal(
        `az functionapp create --subscription ${subscriptionId} --resource-group ${resourceGroup} --consumption-plan-location ${location} \
  --name ${name} --storage-account ${storageAccount} --runtime node`
      );
    }
  } catch (error) {
    console.log("Unable to create function app");
    throw error;
  }

  try {
    console.log(`Enabling package deploy...`);
    await execAsyncInternal(
      `az functionapp config appsettings set --settings WEBSITE_RUN_FROM_PACKAGE=1 --resource-group ${resourceGroup} --name ${name}`
    );
  } catch (error) {
    console.log("Could not enable package deployment");
    throw error;
  }

  console.log("Uploading package & assets...");
  const packagePath = join(buildOutputPath, "package.zip");
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      console.log(
        `Attempting to upload package (${attempt}/${maxAttempts})...`
      );
      await execAsyncInternal(
        `az functionapp deployment source config-zip --subscription ${subscriptionId} -n ${name} -g ${resourceGroup} --src ${packagePath}`
      );
      console.log(`Upload successful`);
      break;
    } catch (e) {
      if (attempt + 1 <= maxAttempts) {
        console.log(
          `Could not deploy package to Azure function app, waiting 5s and then retrying... ${e.message}`
        );
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw new Error("Could not deploy package to Azure function app", e);
      }
    }
  }

  console.log(`Uploading assets to blob storage...`);
  try {
    await execAsyncInternal(
      `az storage blob upload-batch --subscription ${subscriptionId} --account-name ${storageAccount} --destination ${assetsContainerName} --destination-path _next --source ${buildAssetOutputPath}`
    );
  } catch (e) {
    throw new Error("Could not upload assets to Azure blob storage", e);
  }

  console.log(`Uploading public assets to blob storage...`);
  try {
    await execAsyncInternal(
      `az storage blob upload-batch --subscription ${subscriptionId} --account-name ${storageAccount} --destination ${assetsContainerName} --destination-path public --source ${join(
        sourcePath,
        "public"
      )}`
    );
  } catch (e) {
    throw new Error("Could not upload public assets to Azure blob storage", e);
  }

  console.log(`Successfully deployed to https://${name}.azurewebsites.net/`);
}

async function configureAppSettings(config) {
  const { appSecretsJSON, resourceGroup, name } = config;
  if (appSecretsJSON) {
    const appSettings = JSON.parse(appSecretsJSON);
    const formattedAppSettings = Object.keys(appSettings).reduce(
      (settings, key) => `${settings}${key}=${appSettings[key]} `,
      ""
    );
    await execAsyncInternal(
      `az functionapp config appsettings set --settings ${formattedAppSettings} --resource-group ${resourceGroup} --name ${name}`
    );
  }
}

async function clean(config) {
  const {
    name,
    subscriptionId,
    resourceGroup,
    assetsContainerName,
    storageAccount
  } = config;

  console.log(`Deleting function app '${name}'...`);
  await execAsyncInternal(
    `az functionapp delete --subscription ${subscriptionId} --resource-group ${resourceGroup} --name ${name}`
  );

  console.log(`Deleting storage container '${assetsContainerName}'...`);
  await execAsyncInternal(
    `az storage container delete --subscription ${subscriptionId} --name ${assetsContainerName} --account-name ${storageAccount}`
  );
  await execAsyncInternal(`az extension add -n application-insights`);

  console.log(`Deleting app-insights '${name}'...`);
  await execAsyncInternal(
    `az monitor app-insights component delete --subscription ${subscriptionId} --resource-group ${resourceGroup} --app ${name}`
  );
}

run();
