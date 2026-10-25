// マルチパート並列アップロード（フロント）。requirements 要件4-11〜4-13 準拠。
//  - ファイルをパートに分割し、並列（上限あり）でS3へ直接PUT
//  - パート単位の指数バックオフ再試行（一部失敗で全体をやり直さない）
//  - 署名URL期限切れ時はパートURLを再発行して継続

import { MULTIPART_CONCURRENCY } from '@photo-album/shared';

/** 分割サイズ（暫定8MB）。S3のパート最小は5MB。 */
export const PART_SIZE = 8 * 1024 * 1024;

export interface PartUrl {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** パート数を算出する。 */
export function computePartCount(byteSize: number, partSize: number = PART_SIZE): number {
  return Math.max(1, Math.ceil(byteSize / partSize));
}

/** ファイルを指定パート番号のスライスに切り出す。 */
export function sliceForPart(file: Blob, partNumber: number, partSize: number = PART_SIZE): Blob {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(start + partSize, file.size);
  return file.slice(start, end);
}

export interface MultipartUploaderDeps {
  /** パートURL再発行（期限切れ時）。 */
  reissue: (partNumbers: number[]) => Promise<PartUrl[]>;
  /** 進捗コールバック（完了パート数 / 全体）。 */
  onProgress?: (done: number, total: number) => void;
  /** テスト用の sleep 差し替え。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 1パートをPUTし、ETagを返す。失敗時は指数バックオフで最大3回再試行。
 * 403/期限切れが疑われる場合は reissue でURLを再取得する。
 */
async function putPartWithRetry(
  file: Blob,
  part: PartUrl,
  deps: MultipartUploaderDeps,
): Promise<UploadedPart> {
  const sleep = deps.sleep ?? defaultSleep;
  let url = part.url;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = sliceForPart(file, part.partNumber);
      const res = await fetch(url, { method: 'PUT', body });
      if (res.status === 403) {
        // 署名切れの可能性 → URL再発行
        const [fresh] = await deps.reissue([part.partNumber]);
        if (fresh) url = fresh.url;
        throw new Error('part url expired');
      }
      if (!res.ok) throw new Error(`part upload failed: ${res.status}`);
      const etag = (res.headers.get('etag') ?? '').replaceAll('"', '');
      return { partNumber: part.partNumber, etag };
    } catch (err) {
      lastErr = err;
      await sleep(2 ** attempt * 200); // 200ms, 400ms, 800ms
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('part upload failed');
}

/**
 * 全パートを並列アップロードする（並列数は MULTIPART_CONCURRENCY）。
 * @returns Complete に渡す UploadedPart[]（partNumber昇順）
 */
export async function uploadParts(
  file: Blob,
  partUrls: PartUrl[],
  deps: MultipartUploaderDeps,
): Promise<UploadedPart[]> {
  const total = partUrls.length;
  const results: UploadedPart[] = [];
  let done = 0;
  let index = 0;

  async function worker(): Promise<void> {
    while (index < partUrls.length) {
      const current = partUrls[index++]!;
      const uploaded = await putPartWithRetry(file, current, deps);
      results.push(uploaded);
      done++;
      deps.onProgress?.(done, total);
    }
  }

  const workers = Array.from(
    { length: Math.min(MULTIPART_CONCURRENCY, partUrls.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results.sort((a, b) => a.partNumber - b.partNumber);
}
