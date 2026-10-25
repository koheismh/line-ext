// app層が使うバケット名などの実行時設定。
// 環境変数(CDKが注入)から読み、ドメイン・repoに引き渡す。

export interface AppContext {
  /** メタデータバケット名 */
  metaBucket: string;
  /** メディアバケット名 */
  mediaBucket: string;
}

/** 環境変数から AppContext を構築する。欠落は起動時に検知する。 */
export function loadAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const metaBucket = env.META_BUCKET;
  const mediaBucket = env.MEDIA_BUCKET;
  if (!metaBucket || !mediaBucket) {
    throw new Error('必須の環境変数(META_BUCKET / MEDIA_BUCKET)が未設定です。');
  }
  return { metaBucket, mediaBucket };
}
