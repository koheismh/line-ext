// アップロードを統括するフック。タスク15のロジックを結線する。
//  容量判定 → 回線ガード → 単一/マルチパート分岐 → 完了 or 保留記録
//  ファイルごとの成否を返し（要件4-23）、完了したファイルの保留記録を消す（要件9-6）。
//  送信中は離脱確認と画面スリープ抑止を行う（要件4-25）。
// UIは戻り値の状態と関数を使う。

import { useState, useCallback, useEffect } from 'react';
import { MULTIPART_THRESHOLD_BYTES } from '@photo-album/shared';
import { api, errorMessage } from '../../services/api.js';
import { classifyConnection, decideUpload, isGuardSuppressed, suppressGuard } from './networkGuard.js';
import { sumSizes } from './size.js';
import { computePartCount, uploadParts, PART_SIZE } from './multipartUploader.js';
import { addPending, clearPendingFor, type PendingUpload } from './pendingStore.js';

export type UploadPhase = 'idle' | 'confirm' | 'uploading' | 'done';

/** ファイルごとの結果。 */
export interface FileResult {
  name: string;
  ok: boolean;
  /** 失敗時の利用者向け説明 */
  message?: string;
}

export interface UploadState {
  phase: UploadPhase;
  /** confirm 時の理由 */
  reason?: 'cellular' | 'unknown';
  /** 進捗 0〜1 */
  progress: number;
  /** 直近のアップロードのファイルごとの結果 */
  results: FileResult[];
}

/** 1ファイルが大容量(マルチパート対象)か。単体50MB以上 or 動画（要件4-11）。 */
function needsMultipart(file: File): boolean {
  return file.size >= MULTIPART_THRESHOLD_BYTES || file.type.startsWith('video/');
}

/** 送信中の離脱確認と画面スリープ抑止（可能な環境のみ）。 */
function useUploadingGuards(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    let lock: WakeLockSentinel | null = null;
    let released = false;
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (released) void l.release();
          else lock = l;
        })
        .catch(() => {
          // 省電力モード等で取得できない場合は何もしない
        });
    }
    return () => {
      released = true;
      window.removeEventListener('beforeunload', onBeforeUnload);
      void lock?.release();
    };
  }, [active]);
}

export function useUpload(albumId: string) {
  const [state, setState] = useState<UploadState>({ phase: 'idle', progress: 0, results: [] });
  const [queued, setQueued] = useState<File[]>([]);

  useUploadingGuards(state.phase === 'uploading');

  /** 実アップロード（ガード通過後）。1件失敗しても残りは続ける。 */
  const runUpload = useCallback(
    async (files: File[]) => {
      const results: FileResult[] = [];
      setState({ phase: 'uploading', progress: 0, results: [] });
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        try {
          await uploadOne(albumId, file, (p) => {
            setState({ phase: 'uploading', progress: (i + p) / files.length, results: [...results] });
          });
          results.push({ name: file.name, ok: true });
          await clearPendingFor(albumId, file);
        } catch (err) {
          results.push({
            name: file.name,
            ok: false,
            message: errorMessage(err, err instanceof Error ? err.message : 'アップロードに失敗しました。'),
          });
        }
        setState({ phase: 'uploading', progress: (i + 1) / files.length, results: [...results] });
      }
      setState({ phase: 'done', progress: 1, results: [...results] });
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
        setState({ phase: 'confirm', progress: 0, results: [], reason: decision.reason });
      }
    },
    [runUpload],
  );

  /** confirm に対する「それでもアップロード」。24時間抑制して実行。 */
  const approve = useCallback(async () => {
    suppressGuard();
    const files = queued;
    setQueued([]);
    await runUpload(files);
  }, [queued, runUpload]);

  /** confirm に対する「保留にする」。IndexedDB に記録してキャンセル（サーバAPIは呼ばない, 要件9-3）。 */
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
    setState({ phase: 'idle', progress: 0, results: [] });
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
      headers: { 'content-type': file.type }, // 署名に含めた Content-Type と一致させる
    });
    if (!res.ok) throw new Error(`アップロードに失敗しました (${res.status})`);
    onProgress(1);
    return;
  }

  // マルチパート
  const partCount = computePartCount(file.size, PART_SIZE);
  const init = await api.uploads.initMultipart(albumId, { ...common, partCount });
  await uploadParts(file, init.partUrls, {
    reissue: (partNumbers) => api.uploads.reissueParts(init.mediaId, init.uploadId, partNumbers),
    onProgress: (done, total) => onProgress(done / total),
  });
  await api.uploads.complete(init.mediaId, init.uploadId);
}
