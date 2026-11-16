// アルバムの所属（自分だけ／グループ）の表示。
// アルバムは必ずどちらかに属する。どこに属し、だれが見られるかを画面に常に示す（要件3-12）。
// グループのアルバムは、そのグループの画面（アルバム・メンバー・招待）へのリンクにする。
import { Link } from 'react-router-dom';
import type { AlbumDetail } from '@photo-album/shared';
import styles from './AlbumOwner.module.css';

export function AlbumOwner({
  album,
}: {
  album: Pick<AlbumDetail, 'ownerType' | 'ownerId' | 'ownerName'>;
}) {
  if (album.ownerType === 'group') {
    return (
      <Link to={`/groups/${encodeURIComponent(album.ownerId)}`} className={styles.owner}>
        <span aria-hidden="true">👥</span>
        <span>{album.ownerName ? `グループ「${album.ownerName}」のアルバム` : 'グループのアルバム'}</span>
        <span className={styles.note}>メンバー全員が見られます</span>
      </Link>
    );
  }
  return (
    <span className={styles.owner}>
      <span aria-hidden="true">🔒</span>
      <span>自分だけのアルバム</span>
      <span className={styles.note}>ほかの人には見えません</span>
    </span>
  );
}
