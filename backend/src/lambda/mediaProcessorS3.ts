// MediaProcessor の実装（Lambda側）。S3 Range取得・マジックバイト検証・Sharp/FFmpegプレビュー生成。
//  - 写真: Sharp（Lambda Layer で供給。SHARP_LAYER_ARN）。EXIFの向きを反映し、メタデータ（位置情報等）は出力に含めない
//  - 動画: FFmpeg/ffprobe（Lambda Layer で供給。FFMPEG_LAYER_ARN。既定パス /opt/bin/ffmpeg, /opt/bin/ffprobe）
//    原本は丸ごと落とさず、署名付きURLを入力にして必要部分だけ読む（design: 大容量動画）
// ツールが未配備の場合はプレビュー生成を失敗させ error(preview_failed) にする（配備後に再処理できる）。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Media } from '@photo-album/shared';
import type { MediaProcessor, ValidationOutcome } from '../app/processing.js';
import { mediaKeys } from '../repo/keys.js';
import { s3 } from '../repo/s3Client.js';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? '/opt/bin/ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? '/opt/bin/ffprobe';
/** FFmpeg/ffprobe に渡す原本の署名付きURLの有効期限（秒）。Lambda 内でのみ使う。 */
const TOOL_INPUT_URL_TTL = 15 * 60;
/** プレビューの最大辺（px）。 */
const PREVIEW_MAX_EDGE = 512;

/** 先頭バイトを Range で取得してマジックバイトを確認する。 */
async function readMagicBytes(bucket: string, key: string, length = 16): Promise<Uint8Array> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${length - 1}` }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return bytes;
}

/** マジックバイトから実MIMEを推定する（拡張子に依存しない）。 */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // WebP: RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  // MP4/MOV: ftyp ボックス（4-7に 'ftyp'）
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    // HEIF/AVIF 等の静止画コンテナは動画として扱わない
    if (['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return null;
    // MOV(H.264) も同じ ISO BMFF 系のため video/mp4 として配信する（Chrome 等での再生互換性を優先）
    return 'video/mp4';
  }
  return null;
}

/** 原本を FFmpeg/ffprobe に読ませるための短命な署名付きURL。 */
async function originalReadUrl(bucket: string, key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: TOOL_INPUT_URL_TTL,
  });
}

/**
 * ffprobe で映像コーデックを取得する。
 * @returns コーデック名（例: h264, hevc）。映像ストリームが無ければ null。ffprobe 未配備なら undefined（判定不能）。
 */
async function probeVideoCodec(url: string): Promise<string | null | undefined> {
  if (!existsSync(FFPROBE_PATH)) return undefined;
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      url,
    ],
    { timeout: 60_000 },
  );
  const codec = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return codec.length > 0 ? codec : null;
}

/**
 * FFmpeg で冒頭付近の表示可能なフレームを JPEG で取り出す。
 * 先頭が黒いフェードイン対策として 1 秒目から thumbnail フィルタで代表フレームを選ぶ。短い動画は 0 秒目で再試行。
 */
async function extractVideoFrame(url: string): Promise<Buffer> {
  if (!existsSync(FFMPEG_PATH)) {
    throw new Error('FFmpeg が未配備です（FFMPEG_LAYER_ARN を設定して再デプロイし、再処理してください）。');
  }
  let lastErr: unknown;
  for (const seek of ['1', '0']) {
    try {
      const { stdout } = await execFileAsync(
        FFMPEG_PATH,
        [
          '-hide_banner', '-loglevel', 'error',
          '-ss', seek,
          '-i', url,
          '-vf', `thumbnail=30,scale=${PREVIEW_MAX_EDGE}:${PREVIEW_MAX_EDGE}:force_original_aspect_ratio=decrease`,
          '-frames:v', '1',
          '-map_metadata', '-1',
          '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
      );
      if (stdout.length > 0) return stdout;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('動画からフレームを取得できませんでした。');
}

export function createMediaProcessor(mediaBucket: string): MediaProcessor {
  return {
    async validate(media: Media): Promise<ValidationOutcome> {
      const originalKey = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
      // 実サイズ
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: mediaBucket, Key: originalKey }),
      );
      const byteSize = head.ContentLength ?? null;
      // マジックバイト
      const magic = await readMagicBytes(mediaBucket, originalKey);
      const sniffed = sniffMime(magic);
      // 申告種別と実種別の整合（写真/動画の大分類）
      const sniffedKind =
        sniffed === null ? null : sniffed.startsWith('video/') ? 'video' : 'photo';
      let ok = byteSize !== null && byteSize > 0 && sniffedKind !== null && sniffedKind === media.kind;

      // 動画はコーデックを記録する（判定不能なら null のまま）。映像ストリームが無ければ不正ファイル
      let videoCodec: string | null = null;
      if (ok && media.kind === 'video') {
        try {
          const codec = await probeVideoCodec(await originalReadUrl(mediaBucket, originalKey));
          if (codec === null) ok = false;
          else if (codec !== undefined) videoCodec = codec;
        } catch (err) {
          // ffprobe 自体の失敗（破損ファイル等）は不正ファイルとして扱う
          console.warn('[processor] ffprobe failed', { mediaId: media.mediaId, message: (err as Error).message });
          ok = false;
        }
      }

      return {
        ok,
        byteSize,
        mimeType: sniffed,
        videoCodec,
        capturedAt: null, // EXIF撮影日時の抽出は未対応（tasks.md 参照）
      };
    },

    async generatePreview(media: Media): Promise<void> {
      const originalKey = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
      const previewKey = mediaKeys.preview(media.albumId, media.mediaId);

      let output: Buffer;
      if (media.kind === 'photo') {
        // 動的import（SharpはLambda実行環境のLinuxネイティブバイナリを使用）
        const sharp = (await import('sharp')).default;
        const obj = await s3.send(new GetObjectCommand({ Bucket: mediaBucket, Key: originalKey }));
        const input = await obj.Body!.transformToByteArray();
        output = await sharp(Buffer.from(input))
          .rotate() // EXIFの向きを反映
          .resize(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 }) // withMetadata() を呼ばないため EXIF（位置情報含む）は出力されない
          .toBuffer();
      } else {
        output = await extractVideoFrame(await originalReadUrl(mediaBucket, originalKey));
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: mediaBucket,
          Key: previewKey,
          Body: output,
          ContentType: 'image/jpeg',
        }),
      );
    },
  };
}
