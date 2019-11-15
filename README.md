# Publish Next Function Action

This action builds, packages and deploys a Next.js 9 serverless application to Azure Functions and Azure Storage.

Based on https://github.com/cschleiden/jetzt by Christopher Schleiden.

## Inputs

### `configuration`

JSON object containing deployment configuration e.g:

```json
{
    subscriptionId: "<subscriptionId>",
    resourceGroup: "<resourceGroup>",
    location: "<location>",
    name: "<function app name>",
    storageAccount: "<storageAccount>"
}
```

Expected values:

- subscriptionId: Id of the subscription to deploy to. Azure Login must have been run in the workflow prior to this action with appropriate permissions to access this subscription.
- resourceGroup: Name of the resource group to deploy into. Azure Login must have been run in the workflow prior to this action with appropriate permissions to access this resource group if it exists or with permissions to create this resource group if it does not exist.
- location: Azure location to create resources in.
- name: Name of the function app. This will be created in the resource group if it does not exist.
- storageAccount: Name of the storage account to use. This will be created in the resource group if it does not exist.
- plan: (Optional) Name of the function app or app service plan to deploy the function app into. You need to create this resource yourself. If omitted, a consumption plan in the location specified will be used.
- assetsContainerName: (Optional) Name of the container to deploy static assets into in the storage account. Default: "assets".

### `app-settings`

(Optional) JSON object containing any application settings you want to access from within your app e.g:

```json
{
    COSMOS_ENDPOINT: "<COSMOS_ENDPOINT>",
    COSMOS_KEY: "<COSMOS_KEY>",
    COSMOS_DATABASE: "<COSMOS_DATABASE>",
    COSMOS_CONTAINER: "<COSMOS_CONTAINER>"
}
```

These settings are available from within your app by using `process.env`, e.g. `process.env.COSMOS_ENDPOINT`.

### `pull-request`

(Optional) Boolean value indicating whether the deployment should be treated as a pull request.

If true, this will:

- Use a unique name for the function app in the format `${configuration.name}-${pull_request_id}`.
- Use a separate storage account name in the format `pr${storageaccount}`.
- Use a unique container for each pull request within this storage account.

If true and the pull request action is `closed`, the function app and storage container named above will be deleted.

If true, the event type *must* be `pull_request`. Any other value will cause the action to fail.

If true, the `github_token` input must be set with the `GITHUB_TOKEN` to get the test deployment environment details in a PR comment.

### `github_token`

(Optional) Github token value that will allow the action to comment the PR test environment details as a comment in the PR.

If set, this token value will be used to call the Git client to create a comment in the PR after the deployment with the latest PR changes is complete. This has to be set with `${{ secrets.GITHUB_TOKEN }}`

## Example usage

### CI Workflow usage

This will run on every push to master branch.

```yml
name: CI
on:
  push:
    branches: master
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout
      uses: actions/checkout@v1
    - name: Azure Login
      uses: Azure/login@v1
      with:
        creds: ${{ secrets.AZURE_CREDENTIALS }}
    - name: npm install
      run: npm ci
    - name: Publish next function
      uses: thomasf7/publish-next-function@master
      with:
        configuration: ${{ secrets.CONFIGURATION }}
        app-settings: ${{ secrets.APPSETTINGS }}
```

### Pull Request Workflow usage

This will run a job to deploy a unique function when a PR is opened or re-opened, or a change is made to files in the PR. It will also run to clean up the resources created for the PR when it is closed.

```yml
name: Pull Request
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  pull_request:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout
      if: github.event.action != 'closed'
      uses: actions/checkout@v1
    - name: npm install
      if: github.event.action != 'closed'
      run: npm ci
    - name: Azure Login
      uses: Azure/login@v1
      with:
        creds: ${{ secrets.AZURE_CREDENTIALS }}
    - name: Publish next function
      uses: thomasf7/publish-next-function@master
      with:
        configuration: ${{ secrets.CONFIGURATION }}
        app-settings: ${{ secrets.APPSETTINGS }}
        github_token: ${{ secrets.GITHUB_TOKEN }}
        pull-request: true
```
