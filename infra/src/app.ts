// CDKアプリのエントリ。環境ごとにスタックを構成する。
// 現時点では StorageStack を定義。後続タスクで Auth/Processing/Delivery を追加する。

import { App } from 'aws-cdk-lib';
import { loadEnvConfig } from './config.js';
import { StorageStack } from './stacks/storageStack.js';
import { ProcessingStack } from './stacks/processingStack.js';
import { AuthApiStack } from './stacks/authApiStack.js';
import { DeliveryStack } from './stacks/deliveryStack.js';

const app = new App();
const config = loadEnvConfig();

const env = { region: config.region };

// アプリの公開オリジン（CloudFrontドメイン）。初回デプロイ後に APP_ORIGIN で指定して再デプロイする。
// 例: APP_ORIGIN=https://d3gshsyo8qdxa8.cloudfront.net
const appOrigin = process.env.APP_ORIGIN ?? '';
const allowedOrigins = appOrigin ? [appOrigin] : ['https://localhost'];

const storage = new StorageStack(app, `PhotoAlbum-Storage-${config.envName}`, {
  env,
  config,
  allowedOrigins,
});

new ProcessingStack(app, `PhotoAlbum-Processing-${config.envName}`, {
  env,
  config,
  metaBucket: storage.metaBucket,
  mediaBucket: storage.mediaBucket,
});

const authApi = new AuthApiStack(app, `PhotoAlbum-AuthApi-${config.envName}`, {
  env,
  config,
  metaBucket: storage.metaBucket,
  mediaBucket: storage.mediaBucket,
  ...(appOrigin
    ? { allowedOrigin: appOrigin, lineCallbackUrl: `${appOrigin}/api/auth/line/callback` }
    : {}),
});

new DeliveryStack(app, `PhotoAlbum-Delivery-${config.envName}`, {
  env,
  config,
  api: authApi.api,
});

app.synth();
