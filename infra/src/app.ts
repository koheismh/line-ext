// CDKアプリのエントリ。環境ごとに Storage / Processing / AuthApi / Delivery の4スタックを構成する。

import { App } from 'aws-cdk-lib';
import { loadEnvConfig, resolveDeploySettings } from './config.js';
import { StorageStack } from './stacks/storageStack.js';
import { ProcessingStack } from './stacks/processingStack.js';
import { AuthApiStack } from './stacks/authApiStack.js';
import { DeliveryStack } from './stacks/deliveryStack.js';

const app = new App();
const config = loadEnvConfig();

const env = { region: config.region };

// デプロイ時の設定（公開オリジン・FFmpeg Layer）。本番の値は infra/cdk.json の context で Git 管理する。
// 環境変数 APP_ORIGIN / FFMPEG_LAYER_ARN があればそちらを優先する（一時的な上書き用）。
const deploy = resolveDeploySettings(process.env, (key) => app.node.tryGetContext(key));
const appOrigin = deploy.appOrigin;
const allowedOrigins = appOrigin ? [appOrigin] : ['https://localhost'];

const storage = new StorageStack(app, `PhotoAlbum-Storage-${config.envName}`, {
  env,
  config,
  allowedOrigins,
});

const processing = new ProcessingStack(app, `PhotoAlbum-Processing-${config.envName}`, {
  env,
  config,
  metaBucket: storage.metaBucket,
  mediaBucket: storage.mediaBucket,
  ffmpegLayer: deploy.ffmpegLayer,
});

// 参照は Storage → Processing → AuthApi → Delivery の一方向（AuthApi は削除キューを受け取るだけ）
const authApi = new AuthApiStack(app, `PhotoAlbum-AuthApi-${config.envName}`, {
  env,
  config,
  metaBucket: storage.metaBucket,
  mediaBucket: storage.mediaBucket,
  deletionQueue: processing.deletionQueue,
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
