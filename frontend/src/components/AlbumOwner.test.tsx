import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AlbumOwner } from './AlbumOwner.js';

function renderOwner(album: Parameters<typeof AlbumOwner>[0]['album']) {
  return render(
    <MemoryRouter>
      <AlbumOwner album={album} />
    </MemoryRouter>,
  );
}

describe('AlbumOwner', () => {
  it('グループのアルバムはグループ名と見られる人を示し、グループの画面へのリンクにする', () => {
    renderOwner({ ownerType: 'group', ownerId: 'g 1', ownerName: '家族' });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/groups/g%201');
    expect(link.textContent).toContain('グループ「家族」のアルバム');
    expect(link.textContent).toContain('メンバー全員が見られます');
  });

  it('個人アルバムは自分だけのものと示し、リンクにしない', () => {
    renderOwner({ ownerType: 'user', ownerId: 'u1', ownerName: null });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('自分だけのアルバム')).toBeTruthy();
    expect(screen.getByText('ほかの人には見えません')).toBeTruthy();
  });
});
