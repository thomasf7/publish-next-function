const core = require("@actions/core");
const { promisify } = require("util");
const { exec } = require("child_process");
const nextBuild = require.main.require(
  `${process.env.GITHUB_WORKSPACE}/node_modules/next/dist/build`
).default;
const fse = require("fs-extra");
const { join } = require("path");
const archiver = require("archiver");

const { parseNextConfiguration } = require("./parseNextConfiguration");
const { NextBuild } = require("./next");
const { proxiesJson, handler, functionJson, hostJson } = require("./templates");
const execAsyncInternal = promisify(exec);

async function run() {
  try {
    const config = loadConfig();
    const sourcePath = process.env.GITHUB_WORKSPACE;
    const buildOutputPath = join(sourcePath, config.buildOutputDir);

    await checkAzureCliIsAvailable();
    await build(sourcePath);
    await package(sourcePath, buildOutputPath, config);
    await deploy(sourcePath, buildOutputPath, config);
    await configureAppSettings(config);
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

function loadConfig() {
  const configJSON = core.getInput("configuration");
  if(!configJSON) {
    throw new Error("Configuration is missing");
  }
  const config = JSON.parse(configJSON);

  if(!config.subscriptionId) {
    throw new Error("Configuration value is missing: subscriptionId");
  }

  if(!config.resourceGroup) {
    throw new Error("Configuration value is missing: resourceGroup");
  }

  if(!config.location) {
    throw new Error("Configuration value is missing: location");
  }

  if(!config.name) {
    throw new Error("Configuration value is missing: name");
  }

  if(!config.storageAccount) {
    throw new Error("Configuration value is missing: storageAccount");
  }

  if(!config.buildOutputDir) {
    config.buildOutputDir = "build";
  }

  if(!config.assetsContainerName) {
    config.assetsContainerName = "assets";
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

async function build(sourcePath) {
  console.log("Building next application");
  const nextConfig = parseNextConfiguration(sourcePath);
  await nextBuild(sourcePath, nextConfig);
}

async function package(sourcePath, buildOutputPath, config) {
  console.log("Packaging next application");
  const buildPagesOutputPath = join(buildOutputPath, "pages");
  const buildAssetOutputPath = join(buildOutputPath, "assets");

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
      `https://${config.storageAccount}.blob.core.windows.net/${config.assetsContainerName}/`,
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

async function deploy(sourcePath, buildOutputPath, config) {
  const {
    subscriptionId,
    location,
    resourceGroup,
    storageAccount,
    assetsContainerName,
    name
  } = config;

  console.log("Deploying next application");

  try {
    console.log("Creating resource group...");
    await execAsyncInternal(
      `az group create --subscription ${subscriptionId} --name ${resourceGroup} --location ${location}`
    );
  } catch (error) {
    console.log("Unable to create resource group");
    throw error;
  }

  try {
    console.log("Creating storage account...");
    await execAsyncInternal(
      `az storage account create --subscription ${subscriptionId} --name ${storageAccount} --location ${location} --resource-group ${resourceGroup} --sku Standard_LRS`
    );
  } catch (error) {
    console.log("Unable to create storage account");
    throw error;
  }

  try {
    console.log(`Creating storage container...`);
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
    console.log("Creating function app...");
    await execAsyncInternal(
      `az functionapp create --subscription ${subscriptionId} --resource-group ${resourceGroup} --consumption-plan-location ${location} \
--name ${name} --storage-account ${storageAccount} --runtime node`
    );
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
        await sleep(5000);
      } else {
        throw new Error("Could not deploy package to Azure function app", e);
      }
    }
  }

  console.log(`Uploading assets to blob storage...`);
  try {
    await execAsyncInternal(
      `az storage blob upload-batch --subscription ${subscriptionId} --account-name ${storageAccount} --destination ${assetsContainerName} --destination-path _next --source ${join(
        buildOutputPath,
        "assets"
      )}`
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

  console.log(
    `Successfully deployed to https://${config.name}.azurewebsites.net/`
  );
}

async function configureAppSettings(config) {
    const appSecretsJSON = core.getInput("app-settings");
    if (appSecretsJSON) {
      const appSettings = JSON.parse(appSecretsJSON);
      const formattedAppSettings = Object.keys(appSettings).reduce((settings, key) => `${settings}${key}=${appSettings[key]} `, "");
      await execAsyncInternal(`az functionapp config appsettings set --settings ${formattedAppSettings} --resource-group ${config.resourceGroup} --name ${config.name}`);
    }
}

run();
