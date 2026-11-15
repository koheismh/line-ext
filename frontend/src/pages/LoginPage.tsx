// ログイン画面（未ログイン時）。ログイン後は returnTo（同一オリジンの相対パス）へ戻る。
// 招待URLから開いた場合は招待トークンをログイン開始に引き継ぐ（新規登録は招待が必要, 要件1-13）。
import { BRAND } from '../brand.js';
import { Alert, Card, buttonClassName } from '../components/ui/index.js';
import styles from './LoginPage.module.css';

/** login_error の理由ごとの利用者向けメッセージ（要件1-10, 1-13）。 */
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  invite_required:
    '新規登録には招待が必要です。招待してくれた方から届いた招待URLを開いてからログインしてください。',
  invite_invalid: '招待が無効です。招待URLをご確認ください。',
  invite_revoked: 'この招待は失効しています。新しい招待を依頼してください。',
  invite_expired: 'この招待は期限切れです。新しい招待を依頼してください。',
  invite_used: 'この招待はすでに使用されています。新しい招待を依頼してください。',
};
const DEFAULT_LOGIN_ERROR = 'キャンセルされたか、エラーが発生しました。もう一度お試しください。';

/** ログイン開始URL（戻り先と、あれば招待トークンを付ける）。 */
export function loginStartUrl(returnTo: string, inviteToken: string | null): string {
  const invite = inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : '';
  return `/api/auth/line/start?returnTo=${encodeURIComponent(returnTo)}${invite}`;
}

export function LoginPage({
  returnTo,
  loginError,
  inviteToken,
}: {
  returnTo: string;
  /** URL の login_error（無ければ null） */
  loginError: string | null;
  /** 招待URL（/invite?token=）から開いた場合のトークン */
  inviteToken: string | null;
}) {
  return (
    <main className={styles.page}>
      <Card roomy className={styles.card}>
        <div className={styles.hero} aria-hidden="true">
          <span>📸</span>
          <span>🎞️</span>
          <span>💬</span>
        </div>
        <h1 className={styles.title}>{BRAND.name}</h1>
        <p className={styles.tagline}>{BRAND.tagline}</p>

        {inviteToken && (
          <Alert tone="info" icon="💌" role="note">
            グループへの招待が届いています。ログインすると参加の画面に進みます。
          </Alert>
        )}
        {loginError !== null && (
          <Alert tone="danger" title="ログインできませんでした">
            {LOGIN_ERROR_MESSAGES[loginError] ?? DEFAULT_LOGIN_ERROR}
          </Alert>
        )}

        <a
          href={loginStartUrl(returnTo, inviteToken)}
          className={buttonClassName({ variant: 'line', size: 'lg', block: true })}
        >
          LINEでログイン
        </a>
        <p className={styles.note}>
          ログインすると、LINE の表示名がこのアプリでの名前として使われます。
          {!inviteToken && (
            <>
              <br />
              はじめて使う方は、招待してくれた方から届いた招待URLを開いてからログインしてください。
            </>
          )}
        </p>
      </Card>
    </main>
  );
}
