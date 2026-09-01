import type { Metadata } from 'next'
import Link from 'next/link'

import { joinGroupAction } from '@/app/groups/actions'
import {
  Button,
  Card,
  ErrorText,
  Hint,
  Input,
  LinkButton,
  ListRow,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import { Screen } from '@/components/screen'

/**
 * /groups/join — 초대 코드로 참여.
 *
 * Server Component, same shape as /groups/new: a Server Action <form>, with
 * <Button> supplying the pending state through useFormStatus().
 *
 * THE CODE FORMAT IS READ OFF THE SQL, NOT GUESSED
 * ------------------------------------------------
 * `private.generate_invite_code()` (0001_init.sql §11) emits exactly 12
 * characters from 'ABCDEFGHJKMNPQRSTVWXYZ23456789' — 30 symbols with I, L, O,
 * U, 0 and 1 removed so a code copied off a photo is unambiguous. That is what
 * a real code looks like, and what the placeholder shows.
 *
 * The accepted window is wider: both `groups_invite_code_shape_chk` and the
 * guard inside `join_group_by_invite_code` use `^[A-Z0-9]{6,16}$`. So
 * maxLength is 16, not 12 — an older or hand-issued 6..16 code would be
 * honoured by the database, and the input must not be the thing that rejects
 * it. The action uppercases and strips separators before sending.
 */

export const metadata: Metadata = { title: '초대 코드로 참여' }

/** Longest code the database will accept (`^[A-Z0-9]{6,16}$`). */
const CODE_MAX = 16

/** What `private.generate_invite_code()` actually produces today. */
const CODE_LENGTH = 12

/**
 * One message per outcome. The two "wrong code" cases are separated on
 * purpose: 22023 means what was typed was never code-shaped (a typo, a stray
 * character), P0002 means it was well-formed but matches no group — which
 * usually means the code was rotated, and the next step is different.
 */
const ERRORS: Record<string, string> = {
  empty: '초대 코드를 입력해 주세요.',
  shape: `초대 코드는 영문 대문자와 숫자로만 이루어져 있어요 (보통 ${CODE_LENGTH}자리). 오타가 없는지 다시 봐주세요.`,
  not_found:
    '이 코드와 맞는 그룹이 없어요. 멤버가 바뀌면 초대 코드도 새로 바뀌니, 친구에게 지금 코드를 다시 받아 주세요.',
  schema:
    '서버에 그룹 기능이 아직 적용되지 않았어요. 잠시 후 다시 시도하고, 계속 이러면 알려주세요.',
  unknown: '그룹에 들어가지 못했어요. 잠시 후 다시 시도해 주세요.',
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function JoinGroupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 로그인 뒤 돌아올 곳이 홈이 아니라 이 화면이어야 해서 ?next= 를 붙입니다.
  const { supabase, userId } = await requireUserId('/login?next=%2Fgroups%2Fjoin')

  const params = await searchParams
  const errorMessage = ERRORS[one(params.e) ?? ''] ?? null
  // `join_group_by_invite_code` inserts with `on conflict do nothing` and
  // returns the group either way, so re-joining is a silent success at the SQL
  // level. joinGroupAction detects it by comparing memberships taken before
  // the call and sends the id back here as `?already=1&g=<id>`.
  const alreadyJoined = one(params.already) === '1'
  const alreadyGroupId = one(params.g) ?? null

  // ---- 이미 참여 중인 그룹 --------------------------------------------------
  const { data: memberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)

  const groupIds = (memberships ?? []).map((row) => row.group_id)

  // Column-scoped SELECT grant on public.groups — '*' would fail on
  // invite_code. Name the columns.
  const { data: groups, error: groupsError } =
    groupIds.length > 0
      ? await supabase
          .from('groups')
          .select('id, name, created_by, created_at')
          .in('id', groupIds)
          .order('created_at', { ascending: true })
      : { data: [], error: null }

  const existing = groups ?? []
  const readFailed = Boolean(membershipError || groupsError)
  const alreadyGroupName =
    existing.find((group) => group.id === alreadyGroupId)?.name ?? null

  return (
    <Screen>
      <PageHeader
        title="초대 코드로 참여"
        backHref="/"
        backLabel="홈으로"
        description="친구에게 받은 초대 코드를 넣으면 그 그룹에 들어가요."
      />

      {alreadyJoined && (
        <Card>
          <SuccessText>
            {alreadyGroupName
              ? `이미 "${alreadyGroupName}" 그룹의 멤버예요. 새로 들어갈 필요 없어요.`
              : '이미 그 그룹의 멤버예요. 새로 들어갈 필요 없어요.'}
          </SuccessText>
          <LinkButton href="/groups">내 그룹으로 가기</LinkButton>
        </Card>
      )}

      <Card title="초대 코드">
        <form action={joinGroupAction} className="flex flex-col gap-4">
          <Input
            name="code"
            label="코드"
            placeholder="ABCD23WXYZ89"
            maxLength={CODE_MAX}
            required
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="font-mono tracking-[0.2em] uppercase"
            error={errorMessage}
            hint={`영문 대문자와 숫자 ${CODE_LENGTH}자리예요. 헷갈리기 쉬운 I·L·O·U·0·1은 코드에 들어가지 않아요. 소문자로 적어도, 사이에 띄어쓰기나 -가 있어도 알아서 맞춰드려요.`}
          />

          <Button type="submit" pendingLabel="들어가는 중…">
            그룹 들어가기
          </Button>
        </form>
      </Card>

      {readFailed && (
        <Card>
          <ErrorText>
            지금 참여 중인 그룹 목록을 불러오지 못했어요. 코드 넣기는 그대로 하셔도 돼요.
          </ErrorText>
        </Card>
      )}

      {!readFailed && existing.length > 0 && (
        <Card title="이미 참여 중인 그룹">
          <Hint>
            여기 있는 그룹의 코드를 다시 넣어도 아무 일도 일어나지 않아요. 그냥 그대로
            멤버예요.
          </Hint>
          <div className="flex flex-col">
            {existing.map((group) => (
              <ListRow key={group.id} leading="👥" title={group.name} />
            ))}
          </div>
          <LinkButton href="/groups" variant="secondary">
            내 그룹 보기
          </LinkButton>
        </Card>
      )}

      <p className="text-muted text-center text-sm [word-break:keep-all]">
        그룹이 없나요?{' '}
        <Link href="/groups/new" className="text-accent underline underline-offset-4">
          새로 만들기
        </Link>
      </p>
    </Screen>
  )
}
