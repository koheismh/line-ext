// Lambda 共通設定（ランタイム・ログ保存期間）。
// steering「Node.js の現行サポートLTS」: nodejs20.x は 2026-04-30 に Lambda で非推奨になったため nodejs24.x を使う。
// aws-cdk-lib 2.160 には Runtime.NODEJS_24_X 定数が無いため名前で定義する（esbuild ターゲットは node24 になる）。

import { RemovalPolicy } from 'aws-cdk-lib';
import { Runtime, RuntimeFamily } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config.js';

export const LAMBDA_RUNTIME = new Runtime('nodejs24.x', RuntimeFamily.NODEJS, {
  supportsInlineCode: true,
});

/** 保存期間付きのロググループ（既定の無期限保存によるコスト増を防ぐ）。 */
export function lambdaLogGroup(scope: Construct, id: string, config: EnvConfig): LogGroup {
  return new LogGroup(scope, id, {
    retention: config.logRetention,
    removalPolicy: RemovalPolicy.DESTROY, // ログはスタック削除時に消してよい
  });
}
