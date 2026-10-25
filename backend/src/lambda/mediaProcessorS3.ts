// MediaProcessor の実装（Lambda側）。S3 Range取得・マジックバイト検証・Sharpプレビュー生成。
// 動画(FFmpeg)は Lambda Layer 前提。Layer未配備時はプレビュー生成を失敗させ error(preview_failed) にする。

import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3Client } from '@aws-sdk/client-s3';
import type { Media } from '@photo-album/shared';
import type { MediaProcessor, ValidationOutcome } from '../app/processing.js';
import { mediaKeys } from '../repo/keys.js';

const s3 = new S3Client({});

/** 先頭バイトを Range で取得してマジックバイトを確認する。 */
async function readMagicBytes(bucket: string, key: string, length = 16): Promise<Uint8Array> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${length - 1}` }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return bytes;
}

/** マジックバイトから実MIMEを推定する（拡張子に依存しない）。 */
function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    return 'image/webp';
  }
  // MP4/MOV: ftyp ボックス（4-7に 'ftyp'）
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // brand で mp4/mov を厳密判定しないが、動画コンテナとして扱う
    return 'video/mp4';
  }
  return null;
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
      const declaredKind = media.kind;
      const sniffedKind =
        sniffed === null ? null : sniffed.startsWith('video/') ? 'video' : 'photo';
      const ok = byteSize !== null && sniffedKind !== null && sniffedKind === declaredKind;
      return {
        ok,
        byteSize,
        mimeType: sniffed,
        videoCodec: null, // コーデック判定は FFprobe 前提（Layer配備時に拡張）
        capturedAt: null, // EXIF は Sharp メタデータから取得可能（将来拡張）
      };
    },

    async generatePreview(media: Media): Promise<void> {
      const originalKey = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
      const previewKey = mediaKeys.preview(media.albumId, media.mediaId);

      if (media.kind === 'photo') {
        // 動的import（SharpはLambda実行環境のLinuxネイティブバイナリを使用）
        const sharp = (await import('sharp')).default;
        const obj = await s3.send(new GetObjectCommand({ Bucket: mediaBucket, Key: originalKey }));
        const input = await obj.Body!.transformToByteArray();
        const output = await sharp(Buffer.from(input))
          .rotate() // EXIFの向きを反映
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        await s3.send(
          new PutObjectCommand({
            Bucket: mediaBucket,
            Key: previewKey,
            Body: output,
            ContentType: 'image/jpeg',
          }),
        );
        return;
      }

      // 動画: FFmpeg Layer 前提。未配備なら例外→ error(preview_failed) になる。
      throw new Error('動画プレビュー生成は FFmpeg Layer 配備後に有効化されます。');
    },
  };
}
