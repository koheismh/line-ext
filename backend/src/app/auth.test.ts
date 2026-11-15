import { describe, it, expect, beforeEach } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { loginOrRegisterFromLine } from './auth.js';
import { createGroup, issueInvite, revokeInvite } from './groups.js';
import { ORPHAN_CLAIM_GRACE_MS } from './invites.js';
import { metaKeys } from '../repo/keys.js';
import type { Invite, User } from '@photo-album/shared';

const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const NOW = '2026-06-01T00:00:00.000Z';
let mem: MemoryS3;

async function newInvite(nowMs = Date.parse(NOW)) {
  const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
  return issueInvite(ctx, g.groupId, 'admin', nowMs);
}

beforeEach(() => {
  mem = installMemoryS3(s3);
});

describe('loginOrRegisterFromLine（要件1-13）', () => {
  it('新規で招待なしは拒否され、user/identity が作られない', async () => {
    const r = await loginOrRegisterFromLine(ctx, 'line-sub-1', '太郎', NOW);
    expect(r).toEqual({ ok: false, reason: 'invite_required' });
    expect(mem.store.has(metaKeys.lineIdentity('line-sub-1'))).toBe(false);
    expect([...mem.store.keys()].some((k) => k.startsWith('users/'))).toBe(false);
  });

  it('有効な招待で新規登録でき、招待は使用済みになる', async () => {
    const invite = await newInvite();
    const r = await loginOrRegisterFromLine(ctx, 'line-sub-1', '太郎', NOW, invite.token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const user = mem.get(metaKeys.user(r.userId)) as User;
    expect(user.displayName).toBe('太郎');
    const inv = mem.get(metaKeys.inviteByHash(invite.inviteId)) as Invite;
    expect(inv.usedBy).toBe(r.userId);
  });

  it('既存ユーザーは招待なしでログインでき、表示名が更新される', async () => {
    const invite = await newInvite();
    const first = await loginOrRegisterFromLine(ctx, 'line-sub-1', '太郎', NOW, invite.token);
    const again = await loginOrRegisterFromLine(ctx, 'line-sub-1', '太郎2', NOW);
    expect(again).toEqual(first);
    if (!first.ok) return;
    expect((mem.get(metaKeys.user(first.userId)) as User).displayName).toBe('太郎2');
  });

  it('同じ招待を別のLINEアカウントが使うと invite_used で、未作成のまま', async () => {
    const invite = await newInvite();
    await loginOrRegisterFromLine(ctx, 'line-sub-1', '太郎', NOW, invite.token);
    const r = await loginOrRegisterFromLine(ctx, 'line-sub-2', '花子', NOW, invite.token);
    expect(r).toEqual({ ok: false, reason: 'invite_used' });
    expect(mem.store.has(metaKeys.lineIdentity('line-sub-2'))).toBe(false);
  });

  it('不正トークンは invite_invalid、失効は invite_revoked、期限切れは invite_expired', async () => {
    const r1 = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', NOW, 'bogus');
    expect(r1).toEqual({ ok: false, reason: 'invite_invalid' });

    const revoked = await newInvite();
    await revokeInvite(ctx, revoked.inviteId, 'admin', NOW);
    const r2 = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', NOW, revoked.token);
    expect(r2).toEqual({ ok: false, reason: 'invite_revoked' });

    const expired = await newInvite(Date.parse(NOW) - 1_000_000_000);
    const r3 = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', NOW, expired.token);
    expect(r3).toEqual({ ok: false, reason: 'invite_expired' });
    expect(mem.store.has(metaKeys.lineIdentity('line-sub-1'))).toBe(false);
  });

  it('孤児claim（使用済みだが利用者が無い）は猶予内は拒否、猶予後は再claimできる', async () => {
    const invite = await newInvite();
    const key = metaKeys.inviteByHash(invite.inviteId);
    const inv = mem.get(key) as Invite;
    mem.put(key, { ...inv, usedBy: 'ghost', usedAt: NOW });

    const within = new Date(Date.parse(NOW) + ORPHAN_CLAIM_GRACE_MS - 1000).toISOString();
    const r1 = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', within, invite.token);
    expect(r1).toEqual({ ok: false, reason: 'invite_used' });

    const after = new Date(Date.parse(NOW) + ORPHAN_CLAIM_GRACE_MS + 1000).toISOString();
    const r2 = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', after, invite.token);
    expect(r2.ok).toBe(true);
  });

  it('claim済みで利用者が実在する場合は猶予後も再claimできない', async () => {
    const invite = await newInvite();
    const first = await loginOrRegisterFromLine(ctx, 'line-sub-1', 'a', NOW, invite.token);
    expect(first.ok).toBe(true);
    const after = new Date(Date.parse(NOW) + ORPHAN_CLAIM_GRACE_MS + 1000).toISOString();
    const r = await loginOrRegisterFromLine(ctx, 'line-sub-2', 'b', after, invite.token);
    expect(r).toEqual({ ok: false, reason: 'invite_used' });
  });
});
