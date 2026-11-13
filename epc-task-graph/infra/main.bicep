// サーバー版（複数人編集）の Azure リソース一式。
//   Static Web Apps (Standard: 社内テナント限定の Entra ID ログイン + マネージド Functions)
//   Azure SQL Database (サーバーレス・無料枠。超過分は従量課金で継続 / 自動一時停止からの再開に対応)
//   Application Insights + 障害/予算アラート（alertEmails を指定した場合）
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

@description('無料枠を使い切った後の挙動。BillOverUsage=従量課金で継続（推奨） / AutoPause=月末まで DB 停止（課金なし・サービス停止）')
@allowed(['BillOverUsage', 'AutoPause'])
param sqlFreeLimitExhaustion string = 'BillOverUsage'

@description('SQL の自動一時停止までの分数（60 以上。-1 で無効=常時課金）')
param sqlAutoPauseDelayMinutes int = 60

@description('アプリが DB に接続する専用ユーザー名（infra/sql/create-app-user.sql で作成）')
param sqlAppLogin string = 'crelations_app'

@description('アプリ専用ユーザーのパスワード（create-app-user.sql と同じ値）')
@secure()
param sqlAppPassword string

@description('障害・予算超過アラートの通知先メール。空なら アラート/予算 は作成しない')
param alertEmails array = []

@description('月額予算（サブスクリプションの通貨）。80% / 100% 到達で通知')
param monthlyBudget int = 30

@description('予算の開始月（月初日の yyyy-MM-01。通常は既定のまま）')
param budgetStartMonth string = utcNow('yyyy-MM-01')

var suffix = uniqueString(resourceGroup().id)
var sqlServerName = '${prefix}-sql-${suffix}'
var sqlDbName = '${prefix}-db'
var enableAlerts = !empty(alertEmails)

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
    autoPauseDelay: sqlAutoPauseDelayMinutes
    minCapacity: json('0.5')
    useFreeLimit: useSqlFreeLimit
    freeLimitExhaustionBehavior: useSqlFreeLimit ? sqlFreeLimitExhaustion : null
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

// ---- 監視（Application Insights + アラート + 予算） ----

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (enableAlerts) {
  name: '${prefix}-alerts'
  location: 'global'
  properties: {
    groupShortName: 'crel-alert'
    enabled: true
    emailReceivers: [for (mail, i) in alertEmails: {
      name: 'mail${i}'
      emailAddress: mail
      useCommonAlertSchema: true
    }]
  }
}

// /api/health は匿名で到達でき DB には触れない。死活（SWA/Functions）の外形監視。
resource healthTest 'Microsoft.Insights/webtests@2022-06-15' = if (enableAlerts) {
  name: '${prefix}-health'
  location: location
  tags: {
    'hidden-link:${appInsights.id}': 'Resource'
  }
  kind: 'standard'
  properties: {
    SyntheticMonitorId: '${prefix}-health'
    Name: 'api-health'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'apac-jp-kaw-edge' }
      { Id: 'apac-sg-sin-azr' }
      { Id: 'apac-hk-hkn-azr' }
    ]
    Request: {
      RequestUrl: 'https://${swa.properties.defaultHostname}/api/health'
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: false
    }
  }
}

resource healthAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (enableAlerts) {
  name: '${prefix}-health-down'
  location: 'global'
  tags: {
    'hidden-link:${appInsights.id}': 'Resource'
    'hidden-link:${healthTest.id}': 'Resource'
  }
  properties: {
    description: '/api/health が 2 拠点以上で応答しません（サービス停止の可能性）'
    severity: 1
    enabled: true
    scopes: [
      healthTest.id
      appInsights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: healthTest.id
      componentId: appInsights.id
      failedLocationCount: 2
    }
    actions: [
      { actionGroupId: alertGroup.id }
    ]
  }
}

// DB 接続不能・内部エラーは API が 5xx を返す。再開待ちの一時的な混入を除くため 15 分で 3 件超を異常とする。
resource errorAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (enableAlerts) {
  name: '${prefix}-api-5xx'
  location: location
  properties: {
    displayName: 'C-Relations API 5xx'
    description: 'API が 15 分間に 3 件を超える 5xx を返しました（DB 接続不能・内部エラーなど）'
    enabled: true
    severity: 2
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      appInsights.id
    ]
    criteria: {
      allOf: [
        {
          query: 'requests | where toint(resultCode) >= 500'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 3
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        alertGroup.id
      ]
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (enableAlerts) {
  name: '${prefix}-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${budgetStartMonth}T00:00:00Z'
    }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: alertEmails
      }
      actual100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: alertEmails
      }
    }
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    AAD_CLIENT_ID: aadClientId
    AAD_CLIENT_SECRET: aadClientSecret
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    // 管理者ではなくアプリ専用ユーザーで接続する（作成: infra/sql/create-app-user.sql）。
    // Connection Timeout は API 側の再試行予算（約35秒）に収まるよう 30 秒。
    SQL_CONNECTION_STRING: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Database=${sqlDbName};User ID=${sqlAppLogin};Password=${sqlAppPassword};Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;'
  }
}

output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output loginRedirectUri string = 'https://${swa.properties.defaultHostname}/.auth/login/aad/callback'
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
