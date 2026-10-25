// 時刻順ID（ULID）生成ユーティリティ。
// mediaId/commentId に用いることで、S3 ListObjectsV2 の辞書順＝登録日時順になる。
// 外部依存を避けた最小実装。Crockford Base32 を使用。

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（I,L,O,U を除く）
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10; // タイムスタンプ部（48bit）
const RANDOM_LEN = 16; // ランダム部（80bit）

/** 乱数バイトを得る。ブラウザ/Nodeの Web Crypto を利用する。 */
function randomByte(): number {
  // globalThis.crypto は Node 20+ / ブラウザの双方で利用可能
  const buf = new Uint8Array(1);
  globalThis.crypto.getRandomValues(buf);
  // 0..255 を 0..31 に写像（上位ビットを使う）
  return Math.floor((buf[0]! / 256) * ENCODING_LEN);
}

function encodeTime(now: number): string {
  let time = now;
  const chars: string[] = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    chars[i] = ENCODING[mod]!;
    time = (time - mod) / ENCODING_LEN;
  }
  return chars.join('');
}

function encodeRandom(): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[randomByte()]!;
  }
  return out;
}

/**
 * ULID を生成する（26文字、辞書順＝生成時刻順）。
 * @param now エポックミリ秒。省略時は現在時刻。
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** 汎用の衝突しにくいID（グループ・アルバム・ユーザー等、順序不要なもの用）。 */
export function randomId(): string {
  return globalThis.crypto.randomUUID();
}
