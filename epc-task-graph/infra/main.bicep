// サーバー版（複数人編集）の Azure リソース一式。
//   Static Web Apps (Standard: 社内テナント限定の Entra ID ログイン + マネージド Functions)
//   Azure SQL Database (サーバーレス・無料枠を使い切ったら自動一時停止)
// 手順は docs/azure-deployment.md を参照。
targetScope = 'resourceGroup'

@description('リソース名の接頭辞（英小文字・数字、3〜12文字）')
@minLength(3)
@maxLength(12)
param prefix string = 'crelations'

@description('Azure SQL の場所')
param location string = resourceGroup().location

@description('Static Web Apps の場所（対応リージョンのみ）')
@allowed(['eastasia', 'eastus2', 'centralus', 'westus2', 'westeurope'])
param swaLocation string = 'eastasia'

@description('SQL 管理者ログイン名')
param sqlAdminLogin string

@description('SQL 管理者パスワード')
@secure()
param sqlAdminPassword string

@description('Entra ID アプリ登録のクライアントID')
param aadClientId string

@description('Entra ID アプリ登録のクライアントシークレット')
@secure()
param aadClientSecret string

@description('Azure SQL の無料枠を使う（サブスクリプションにつき1DB）')
param useSqlFreeLimit bool = true

var suffix = uniqueString(resourceGroup().id)
var sqlServerName = '${prefix}-sql-${suffix}'
var sqlDbName = '${prefix}-db'

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

// SWA マネージド Functions は送信元IPが固定されないため「Azure サービスからのアクセス」を許可する。
resource sqlAllowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: sqlDbName
  location: location
  sku: {
    name: 'GP_S_Gen5'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    autoPauseDelay: 60
    minCapacity: json('0.5')
    useFreeLimit: useSqlFreeLimit
    freeLimitExhaustionBehavior: useSqlFreeLimit ? 'AutoPause' : null
    requestedBackupStorageRedundancy: 'Local'
  }
}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-swa-${suffix}'
  location: swaLocation
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    // デプロイは GitHub Actions（デプロイトークン）から行う
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    AAD_CLIENT_ID: aadClientId
    AAD_CLIENT_SECRET: aadClientSecret
    SQL_CONNECTION_STRING: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Database=${sqlDbName};User ID=${sqlAdminLogin};Password=${sqlAdminPassword};Encrypt=true;TrustServerCertificate=false;Connection Timeout=60;'
  }
}

output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output loginRedirectUri string = 'https://${swa.properties.defaultHostname}/.auth/login/aad/callback'
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
