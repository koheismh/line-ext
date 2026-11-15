// アルバムの一覧（表紙付きカードのグリッド）。表紙がないアルバムは装飾色のプレースホルダを出す。
import { Link } from 'react-router-dom';
import type { AlbumListItem } from '@photo-album/shared';
import { cx, decoClassName } from './ui/index.js';
import styles from './AlbumGrid.module.css';

export function AlbumGrid({ albums }: { albums: AlbumListItem[] }) {
  return (
    <ul className={styles.grid}>
      {albums.map((album) => (
        <li key={album.albumId}>
          <Link to={`/albums/${encodeURIComponent(album.albumId)}`} className={styles.card}>
            <span className={styles.cover}>
              {album.coverPreviewUrl ? (
                <img src={album.coverPreviewUrl} alt="" loading="lazy" className={styles.image} />
              ) : (
                <span className={cx(styles.placeholder, decoClassName(album.albumId))} aria-hidden="true">
                  🖼️
                </span>
              )}
            </span>
            <span className={styles.title}>{album.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
