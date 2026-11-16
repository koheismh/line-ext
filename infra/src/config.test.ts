import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTEXT_KEYS, resolveDeploySettings } from './config.js';

/** context の読み出し関数（テスト用）。 */
const contextOf =
  (values: Record<string, unknown>) =>
  (key: string): unknown =>
    values[key];

const PROD = {
  [CONTEXT_KEYS.appOrigin]: 'https://example.cloudfront.net',
  [CONTEXT_KEYS.ffmpegLayer]: 'ffmpeg:1',
};

describe('resolveDeploySettings', () => {
  it('infra/cdk.json の context から読む（環境変数なしで本番の構成になる）', () => {
    expect(resolveDeploySettings({}, contextOf(PROD))).toEqual({
      appOrigin: 'https://example.cloudfront.net',
      ffmpegLayer: 'ffmpeg:1',
    });
  });

  it('環境変数があればそちらを優先する（一時的な上書き）', () => {
    const env = {
      APP_ORIGIN: 'https://other.cloudfront.net',
      FFMPEG_LAYER_ARN: 'arn:aws:lambda:ap-northeast-1:123456789012:layer:ffmpeg:2',
    };
    expect(resolveDeploySettings(env, contextOf(PROD))).toEqual({
      appOrigin: 'https://other.cloudfront.net',
      ffmpegLayer: 'arn:aws:lambda:ap-northeast-1:123456789012:layer:ffmpeg:2',
    });
  });

  it('FFmpeg Layer の指定が無ければエラーにする（指定漏れで Layer が外れるのを防ぐ）', () => {
    expect(() =>
      resolveDeploySettings({}, contextOf({ [CONTEXT_KEYS.appOrigin]: 'https://example.cloudfront.net' })),
    ).toThrow(/FFmpeg Layer の指定がありません/);
    // 空の環境変数は未設定と同じ扱い（context に落ちる）
    expect(resolveDeploySettings({ FFMPEG_LAYER_ARN: '' }, contextOf(PROD)).ffmpegLayer).toBe('ffmpeg:1');
  });

  it('none は「Layer なし」の明示として受け付ける', () => {
    const settings = resolveDeploySettings({}, contextOf({ [CONTEXT_KEYS.ffmpegLayer]: 'none' }));
    expect(settings).toEqual({ appOrigin: '', ffmpegLayer: 'none' });
  });

  it('形式が不正な値はエラーにする', () => {
    expect(() => resolveDeploySettings({}, contextOf({ ...PROD, [CONTEXT_KEYS.ffmpegLayer]: 'ffmpeg' }))).toThrow(
      /FFmpeg Layer の指定が不正/,
    );
    expect(() =>
      resolveDeploySettings({}, contextOf({ ...PROD, [CONTEXT_KEYS.appOrigin]: 'https://example.cloudfront.net/' })),
    ).toThrow(/公開オリジンの形式が不正/);
  });

  it('infra/cdk.json に本番の設定が入っている（消すと Layer が外れたデプロイになるため）', () => {
    const cdkJson = JSON.parse(readFileSync(fileURLToPath(new URL('../cdk.json', import.meta.url)), 'utf8')) as {
      context: Record<string, unknown>;
    };
    const settings = resolveDeploySettings({}, contextOf(cdkJson.context));
    expect(settings.appOrigin).toMatch(/^https:\/\//);
    expect(settings.ffmpegLayer).not.toBe('none');
  });
});
