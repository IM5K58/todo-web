import { redirect } from 'next/navigation'

import { Screen } from '@/components/screen'
import {
  Button,
  Card,
  CopyField,
  ConfirmButton,
  ErrorText,
  Hint,
  LinkButton,
  ListRow,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import { avatarAltText, resolveAvatar, type ResolvedAvatar } from '@/lib/avatar'
import { messageFor } from '@/lib/search-params'
import { fetchMemberProfiles, type ProfilesReader } from '@/lib/tasks'
import type { GroupRole } from '@/lib/supabase/types'

import {
  leaveGroupAction,
  removeMemberAction,
  rotateInviteCodeAction,
  type GroupsErrCode,
  type GroupsOkCode,
} from './manage-actions'

/**
 * /groups — 내 그룹.
 *
 * Server Component. Every read below is shaped by what 0002_rls.sql actually
 * grants the signed-in user, which is narrower than "the rows they can see":
 *
 *   groups            SELECT is a COLUMN grant: (id, name, created_by,
 *                     created_at). `invite_code` is NOT in it, so `select('*')`
 *                     fails outright with "permission denied for column
 *                     invite_code". Named columns only, here and everywhere.
 *   group_members     Full-table SELECT, policy-filtered to
 *                     `group_id in private.current_user_group_ids()`. So the
 *                     roster query below cannot leak a group we are not in even
 *                     if the id list were wrong.
 *   profiles          [0003] SELECT is also a COLUMN grant (id, display_name,
 *                     avatar_emoji, timezone, created_at; [0007] added
 *                     default_group_id and avatar_url) — the auto_nudge_*
 *                     columns are excluded, so `select('*')` fails here too.
 *                     Policy: self, or someone we share a group with.
 *   invite_code       Reachable ONLY through rpc('get_invite_code'), which
 *                     re-checks `role = 'owner'` inside the function and raises
 *                     42501 for anyone else. It is therefore never fetched for
 *                     a non-owner: nothing to hide in the markup because
 *                     nothing was requested.
 *
 * The mutations all live in ./manage-actions.ts, and the confirmation copy for
 * 내보내기 spells out the invite-code rotation because `remove_member` performs
 * it in the same transaction (0001 §16) and there is no undo.
 */

// ---------------------------------------------------------------------------
// Notice copy
// ---------------------------------------------------------------------------

/**
 * Server Actions here end in `redirect('/groups?ok=…' | '?err=…')`, so the
 * result of a mutation is a URL you can reload. Both records are keyed by the
 * unions exported from manage-actions.ts: adding a code there breaks this file
 * until it has Korean copy, which is the point.
 */
const OK_MESSAGES: Record<GroupsOkCode, string> = {
  rotated:
    '새 초대 코드를 만들었어요. 이전 코드는 이제 쓸 수 없으니 친구들에게 새 코드를 다시 보내주세요.',
  removed:
    '멤버를 내보냈어요. 초대 코드도 함께 새로 바뀌었으니 남아 있는 친구들에게 새 코드를 다시 보내주세요.',
  left: '그룹에서 나왔어요.',
}

const ERR_MESSAGES: Record<GroupsErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  notowner: '그룹 방장만 할 수 있는 일이에요.',
  self: '스스로를 내보낼 수는 없어요. 아래 “그룹 나가기”를 사용해 주세요.',
  notdeployed: '이 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notmember: '이미 그 그룹의 멤버가 아니에요.',
  fail: '처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

const FALLBACK_NAME = '친구'

type MemberView = {
  userId: string
  displayName: string
  /**
   * [0007] Already-resolved avatar — profiles.avatar_url or the emoji.
   *
   * ⚠️⚠️ NEVER pass `userMetadata` when resolving a row that is not mine ⚠️⚠️
   * The Google login photo lives in MY JWT and there is no way to read a
   * teammate's auth metadata (see lib/avatar.ts). Handing my metadata to a
   * teammate's row would (1) paste my photo onto my friend's face and
   * (2) widen the "any https URL in user_metadata" hole from my own screen to
   * everyone's, because `auth.updateUser({ data })` lets a user write that bag
   * freely. Other people's rows get `avatarUrl` + `avatarEmoji`, nothing else.
   * That rule is enforced in one place — `lib/tasks.ts` `memberAvatar()` — and
   * this file follows it below.
   */
  avatar: ResolvedAvatar
  role: GroupRole
  isSelf: boolean
}

/**
 * One member's avatar, `<img>` when there is a photo and the emoji otherwise.
 *
 * A plain `<img>`, not `next/image`: `images.remotePatterns` only lists
 * `*.supabase.co`, so a Google photo stored in `avatar_url` (lh3…) would 400
 * through the optimizer. A 40px avatar has nothing to gain from it anyway.
 *
 * No `onError` fallback here — this is a Server Component and the emoji is
 * already the alt-less sibling in `ResolvedAvatar.emoji`. A broken URL leaves
 * the round grey well behind it, which is the same shape as the emoji case.
 */
function MemberAvatar({ member }: { member: MemberView }) {
  if (member.avatar.kind === 'image' && member.avatar.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.avatar.imageUrl}
        // The name is right next to it in text, so the alt is empty on purpose.
        alt={avatarAltText(member.displayName)}
        className="size-10 rounded-full object-cover"
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
      />
    )
  }
  return <span aria-hidden="true">{member.avatar.emoji}</span>
}

/** Owners first, then longest-standing — the same order the DB promotes heirs in. */
function sortMembers(a: MemberView, b: MemberView): number {
  if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
  return 0
}

/** What `get_invite_code` came back with, for one owned group. */
type InviteCodeState =
  | { kind: 'code'; value: string }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const okMessage = messageFor<GroupsOkCode>(OK_MESSAGES, params.ok)
  const errMessage = messageFor<GroupsErrCode>(ERR_MESSAGES, params.err)

  // 세션이 없으면 여기서 /login 으로 나갑니다. 판정 근거는 lib/auth.ts 에.
  const { supabase, userId } = await requireUserId()

  // ---- my memberships -----------------------------------------------------
  const { data: myMemberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id, role, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })

  if (membershipError) {
    return (
      <LoadFailure message="그룹 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." />
    )
  }

  const memberships = myMemberships ?? []

  // No group at all: sending the user to an empty shell of a screen would be a
  // dead end, so hand them straight to the one action that helps.
  if (memberships.length === 0) {
    redirect('/groups/new')
  }

  const groupIds = memberships.map((row) => row.group_id)
  const myRoleByGroup = new Map<string, GroupRole>(
    memberships.map((row) => [row.group_id, row.role]),
  )

  // ---- groups + full roster ----------------------------------------------
  const [groupsResult, rosterResult] = await Promise.all([
    // ★ Named columns. `select('*')` here fails: no column grant on invite_code.
    supabase.from('groups').select('id, name, created_by, created_at').in('id', groupIds),
    supabase
      .from('group_members')
      .select('group_id, user_id, role, joined_at')
      .in('group_id', groupIds)
      .order('joined_at', { ascending: true }),
  ])

  if (groupsResult.error) {
    return <LoadFailure message="그룹 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." />
  }

  const groups = groupsResult.data ?? []
  const roster = rosterResult.data ?? []
  const rosterFailed = Boolean(rosterResult.error)

  // ---- profiles for everyone on the roster --------------------------------
  const memberIds = [...new Set(roster.map((row) => row.user_id))]

  // ★ Named columns again — 0003 narrowed the profiles SELECT grant too, and
  // 0007 added avatar_url to it. The column list and the 42703 fallback for a
  // database that has not run 0007 yet both live in `fetchMemberProfiles`, so
  // /status and /groups cannot drift apart on what a member row is made of.
  const profilesResult = await fetchMemberProfiles(
    supabase as unknown as ProfilesReader,
    memberIds,
  )

  const profilesFailed = Boolean(profilesResult.error)
  const profileById = new Map(
    (profilesResult.data ?? []).map((row) => [row.id, row] as const),
  )

  // ---- invite codes, owned groups only ------------------------------------
  //
  // A non-owner never reaches this call, so there is no empty box to hide.
  const ownedGroupIds = groupIds.filter((id) => myRoleByGroup.get(id) === 'owner')

  const inviteCodes = new Map<string, InviteCodeState>(
    await Promise.all(
      ownedGroupIds.map(async (id): Promise<readonly [string, InviteCodeState]> => {
        const { data, error } = await supabase.rpc('get_invite_code', {
          p_group_id: id,
        })

        if (error) {
          return [
            id,
            {
              kind: 'error',
              message:
                error.code === 'PGRST202'
                  ? '초대 코드 기능이 아직 서버에 적용되지 않았어요.'
                  : error.code === '42501'
                    ? '초대 코드를 볼 권한이 없어요. 방장이 바뀌었을 수 있어요.'
                    : '초대 코드를 불러오지 못했어요. 새로고침해 주세요.',
            },
          ] as const
        }

        if (typeof data !== 'string' || !data) {
          return [
            id,
            { kind: 'error', message: '초대 코드를 불러오지 못했어요. 새로고침해 주세요.' },
          ] as const
        }

        return [id, { kind: 'code', value: data }] as const
      }),
    ),
  )

  // ---- render -------------------------------------------------------------
  return (
    <Screen>
      <PageHeader title="내 그룹" backHref="/" backLabel="오늘로 돌아가기" />

      {okMessage && (
        <div className="border-line bg-surface rounded-2xl border p-4">
          <SuccessText>{okMessage}</SuccessText>
        </div>
      )}
      {errMessage && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{errMessage}</ErrorText>
        </div>
      )}

      {groups.map((group) => {
        const myRole = myRoleByGroup.get(group.id) ?? 'member'
        const isOwner = myRole === 'owner'

        const members: MemberView[] = roster
          .filter((row) => row.group_id === group.id)
          .map((row) => {
            const profile = profileById.get(row.user_id)
            return {
              userId: row.user_id,
              displayName: profile?.display_name.trim() || FALLBACK_NAME,
              // ⚠️ Someone else's row: `avatarUrl` + `avatarEmoji` only.
              // Passing `userMetadata` here would paste MY Google photo onto
              // every face in this list — see the MemberView doc above.
              avatar: resolveAvatar({
                avatarUrl: profile?.avatar_url ?? null,
                avatarEmoji: profile?.avatar_emoji ?? null,
              }),
              role: row.role,
              isSelf: row.user_id === userId,
            }
          })
          .sort(sortMembers)

        const inviteCode = isOwner ? inviteCodes.get(group.id) : undefined

        return (
          <Card key={group.id} title={group.name}>
            {/* ---- 멤버 목록 ------------------------------------------- */}
            <div className="flex flex-col">
              <p className="text-muted mb-1 text-xs">
                멤버 {rosterFailed ? '—' : `${members.length}명`}
              </p>

              {rosterFailed ? (
                <ErrorText>
                  멤버 목록을 불러오지 못했어요. 화면을 새로고침해 주세요.
                </ErrorText>
              ) : (
                <ul className="flex flex-col">
                  {/*
                    The divider lives on the <li>, not on ListRow: ListRow's own
                    `border-b last:border-b-0` sees itself as the last child of
                    its <li> every time, so it would never draw.
                  */}
                  {members.map((member) => (
                    <li
                      key={member.userId}
                      className="border-line flex flex-col border-b last:border-b-0"
                    >
                      <ListRow
                        leading={<MemberAvatar member={member} />}
                        title={
                          <>
                            {member.displayName}
                            {member.isSelf && (
                              <span className="text-muted font-normal"> (나)</span>
                            )}
                          </>
                        }
                        trailing={
                          member.role === 'owner' ? (
                            <span className="bg-accent text-accent-fg inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium">
                              방장
                            </span>
                          ) : undefined
                        }
                      />

                      {/*
                        내보내기 — owner only, and never on their own row:
                        remove_member() refuses `p_user_id = auth.uid()` with
                        22023 and tells you to use 그룹 나가기 instead.
                      */}
                      {isOwner && !member.isSelf && (
                        <form
                          action={removeMemberAction}
                          className="flex flex-col items-end gap-2 pb-3"
                        >
                          <input type="hidden" name="groupId" value={group.id} />
                          <input type="hidden" name="userId" value={member.userId} />
                          <ConfirmButton
                            size="sm"
                            confirmLabel="네, 내보낼게요"
                            pendingLabel="내보내는 중…"
                            confirmMessage={
                              <>
                                {member.displayName}님을 이 그룹에서 내보낼까요? 내보내면{' '}
                                <strong>초대 코드도 같은 순간에 새 코드로 바뀝니다.</strong>{' '}
                                그래서 남아 있는 친구들이 저장해 둔 기존 코드는 더 이상
                                쓸 수 없고, 새 코드를 다시 보내주셔야 해요. 되돌릴 수 없어요.
                              </>
                            }
                          >
                            내보내기
                          </ConfirmButton>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {profilesFailed && !rosterFailed && (
                <Hint>
                  이름과 이모지를 불러오지 못해 기본값으로 보여주고 있어요. 인원수와
                  방장 표시는 정확해요.
                </Hint>
              )}
            </div>

            {/* ---- 초대 코드 (방장만) ---------------------------------- */}
            {isOwner && inviteCode && (
              <div className="border-line flex flex-col gap-3 border-t pt-4">
                {inviteCode.kind === 'code' ? (
                  <>
                    <CopyField
                      label="초대 코드"
                      value={inviteCode.value}
                      hint="이 코드를 아는 사람은 누구나 그룹에 들어올 수 있어요. 친구에게만 보내주세요."
                    />

                    <form action={rotateInviteCodeAction}>
                      <input type="hidden" name="groupId" value={group.id} />
                      <Button
                        type="submit"
                        variant="secondary"
                        pendingLabel="새로 만드는 중…"
                      >
                        코드 재발급
                      </Button>
                    </form>

                    <Hint>
                      재발급하면 지금 코드는 바로 못 쓰게 돼요. 코드가 새어 나갔을 때
                      사용하세요. 멤버를 내보낼 때도 코드가 자동으로 재발급됩니다.
                    </Hint>
                  </>
                ) : (
                  <ErrorText>{inviteCode.message}</ErrorText>
                )}
              </div>
            )}

            {/* ---- 나가기 ---------------------------------------------- */}
            <div className="border-line flex flex-col gap-3 border-t pt-4">
              <form action={leaveGroupAction}>
                <input type="hidden" name="groupId" value={group.id} />
                <ConfirmButton
                  confirmLabel="네, 나갈게요"
                  pendingLabel="나가는 중…"
                  confirmMessage={
                    isOwner ? (
                      <>
                        방장인 채로 나가면, 남아 있는 멤버 중{' '}
                        <strong>가장 먼저 들어온 사람이 자동으로 새 방장</strong>이 돼요.
                        초대 코드는 바뀌지 않고 새 방장이 그대로 이어받아요. 남는 사람이
                        아무도 없으면 그룹은 빈 채로 남습니다. 다시 들어오려면 초대
                        코드가 필요해요.
                      </>
                    ) : (
                      <>
                        이 그룹에서 나갈까요? 지금까지 적어둔 내 할 일 기록은 남지만,
                        친구들의 오늘은 더 이상 보이지 않아요. 다시 들어오려면 초대
                        코드가 필요해요.
                      </>
                    )
                  }
                >
                  그룹 나가기
                </ConfirmButton>
              </form>
            </div>
          </Card>
        )
      })}

      <Card title="다른 그룹">
        <Hint>그룹은 여러 개 만들거나 참여할 수 있어요.</Hint>
        <LinkButton href="/groups/new" variant="secondary">
          새 그룹 만들기
        </LinkButton>
        <LinkButton href="/groups/join" variant="secondary">
          초대 코드로 참여하기
        </LinkButton>
      </Card>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// Failure screen
// ---------------------------------------------------------------------------

/**
 * A read failed. Deliberately NOT an empty state: "아직 그룹이 없어요" for a
 * query that errored is a lie, and the user would go create a duplicate group.
 */
function LoadFailure({ message }: { message: string }) {
  return (
    <Screen>
      <PageHeader title="내 그룹" backHref="/" backLabel="오늘로 돌아가기" />
      <Card>
        <ErrorText>{message}</ErrorText>
        <LinkButton href="/groups" variant="secondary">
          다시 불러오기
        </LinkButton>
      </Card>
    </Screen>
  )
}
