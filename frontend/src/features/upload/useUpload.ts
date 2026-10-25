// アップロードを統括するフック。タスク15のロジックを結線する。
//  容量判定 → 回線ガード → 単一/マルチパート分岐 → 完了 or 保留記録
// UIは戻り値の状態と関数を使う。

import { useState, useCallback } from 'react';
import { MAX_PHOTO_BYTES } from '@photo-album/shared';
import { api } from '../../services/api.js';
import { classifyConnection, decideUpload, isGuardSuppressed, suppressGuard } from './networkGuard.js';
import { sumSizes } from './size.js';
import { computePartCount, uploadParts, PART_SIZE } from './multipartUploader.js';
import { addPending, type PendingUpload } from './pendingStore.js';

export type UploadPhase = 'idle' | 'confirm' | 'uploading' | 'done' | 'error';

export interface UploadState {
  phase: UploadPhase;
  /** confirm 時の理由 */
  reason?: 'cellular' | 'unknown';
  /** 進捗 0〜1 */
  progress: number;
  error?: string;
}

/** 1ファイルが大容量(マルチパート対象)か。単体50MB以上 or 動画。 */
function needsMultipart(file: File): boolean {
  return file.size >= MAX_PHOTO_BYTES || file.type.startsWith('video/');
}

export function useUpload(albumId: string) {
  const [state, setState] = useState<UploadState>({ phase: 'idle', progress: 0 });
  const [queued, setQueued] = useState<File[]>([]);

  /** 実アップロード（ガード通過後）。 */
  const runUpload = useCallback(
    async (files: File[]) => {
      setState({ phase: 'uploading', progress: 0 });
      try {
        let doneCount = 0;
        for (const file of files) {
          await uploadOne(albumId, file, (p) => {
            const overall = (doneCount + p) / files.length;
            setState({ phase: 'uploading', progress: overall });
          });
          doneCount++;
        }
        setState({ phase: 'done', progress: 1 });
      } catch (err) {
        setState({ phase: 'error', progress: 0, error: (err as Error).message });
      }
    },
    [albumId],
  );

  /** ファイル選択時のエントリ。ガード判定して proceed か confirm を決める。 */
  const start = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const total = sumSizes(files.map((f) => f.size));
      const decision = decideUpload({
        totalBytes: total,
        fileCount: files.length,
        verdict: classifyConnection(),
        suppressed: isGuardSuppressed(),
      });
      if (decision.action === 'proceed') {
        await runUpload(files);
      } else {
        setQueued(files);
        setState({ phase: 'confirm', progress: 0, reason: decision.reason });
      }
    },
    [runUpload],
  );

  /** confirm に対する「それでもアップロード」。24時間抑制して実行。 */
  const approve = useCallback(async () => {
    suppressGuard();
    await runUpload(queued);
    setQueued([]);
  }, [queued, runUpload]);

  /** confirm に対する「保留にする」。IndexedDB に記録してキャンセル。 */
  const defer = useCallback(async () => {
    const reason = state.reason ?? 'unknown';
    for (const file of queued) {
      const item: PendingUpload = {
        id: crypto.randomUUID(),
        albumId,
        fileName: file.name,
        byteSize: file.size,
        lastModified: file.lastModified,
        mimeType: file.type,
        reason,
        createdAt: new Date().toISOString(),
      };
      await addPending(item);
    }
    setQueued([]);
    setState({ phase: 'idle', progress: 0 });
  }, [albumId, queued, state.reason]);

  return { state, start, approve, defer };
}

/** 1ファイルをアップロードする（単一PUT or マルチパート）。 */
async function uploadOne(
  albumId: string,
  file: File,
  onProgress: (p: number) => void,
): Promise<void> {
  const common = {
    declaredMimeType: file.type,
    declaredByteSize: file.size,
    displayFileName: file.name,
    fileLastModified: new Date(file.lastModified).toISOString(),
  };

  if (!needsMultipart(file)) {
    const { uploadUrl } = await api.uploads.initSingle(albumId, common);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'content-type': file.type },
    });
    if (!res.ok) throw new Error(`アップロードに失敗しました (${res.status})`);
    onProgress(1);
    return;
  }

  // マルチパート
  const partCount = computePartCount(file.size, PART_SIZE);
  const init = await api.uploads.initMultipart(albumId, { ...common, partCount });
  const parts = await uploadParts(file, init.partUrls, {
    reissue: (partNumbers) => api.uploads.reissueParts(init.mediaId, init.uploadId, partNumbers),
    onProgress: (done, total) => onProgress(done / total),
  });
  await api.uploads.complete(init.mediaId, init.uploadId, parts);
}
