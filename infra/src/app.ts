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

// 配信ドメイン確定前の暫定。実際の許可オリジンは DeliveryStack 構築後に SSM/コンテキストで差し込む。
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'https://localhost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
});

new DeliveryStack(app, `PhotoAlbum-Delivery-${config.envName}`, {
  env,
  config,
  api: authApi.api,
});

app.synth();
