import { Card, ConfirmButton, EmptyState, ErrorText, Hint } from '@/components/ui'
import type { TimelineData, TimelinePost } from '@/lib/posts'

import { deletePost } from './actions'

/**
 * 타임라인 목록 — 최신순.
 *
 * Server Component 입니다. 이 화면에 클라이언트 상태가 필요한 곳은 삭제
 * 확인 한 군데뿐이고, 그건 <ConfirmButton>(components/ui.tsx) 이 이미 들고
 * 있습니다. 목록 전체를 클라이언트로 넘기면 서명 URL 이 RSC 페이로드가 아니라
 * 클라이언트 props 로 흐르게 되는데, 얻는 것 없이 표면만 넓어집니다.
 *
 * ---------------------------------------------------------------------------
 * 사진은 왜 <img> 이고 왜 만료되는가
 * ---------------------------------------------------------------------------
 * 0010 ⑤ 가 버킷을 **비공개** 로 만들었습니다. 그래서 여기 오는 URL 은
 * lib/posts.ts 가 service_role 로 발급한 **서명 URL** 이고 1시간 뒤 만료
 * 됩니다. 그게 이 기능의 핵심입니다 — 공개 버킷과 달리, 그룹을 나간 사람이
 * 들고 있던 주소가 영원히 살아 있지 않습니다.
 *
 * next/image 가 아니라 평범한 <img> 인 이유는 next.config.ts 그대로입니다:
 * `unoptimized: true` 에 `remotePatterns: []` 라서 /_next/image 는 어떤
 * 원격 URL 도 거부합니다. 그 목록에 Supabase 를 다시 넣는 것은 인증 없는
 * 이미지 프록시를 여는 일이고, 서명 URL 을 거기에 통과시키면 서명의 의미가
 * 사라집니다.
 *
 * ---------------------------------------------------------------------------
 * 삭제는 본인만 — 버튼을 아예 안 그립니다
 * ---------------------------------------------------------------------------
 * 0010 ③ 의 posts_delete_own 은 남의 글에 대한 DELETE 를 **조용히 0행** 으로
 * 만듭니다. 예외가 아닙니다. 그러니 남의 글에 삭제 버튼을 그려 두면 눌러도
 * 아무 일이 안 일어나는 버튼이 됩니다. 정상 경로는 `isMine` 이 아닐 때 버튼을
 * 렌더하지 않는 것이고, 서버 쪽 0행 판정은 그래도 실패로 보고합니다
 * (app/timeline/actions.ts 의 deletePost — 조용한 성공 금지).
 */

/**
 * 게시물 한 장의 시각.
 *
 * 0010 ① 의 판단대로 posts 에는 날짜 버킷 컬럼이 없고 created_at 하나뿐입니다
 * (그 컬럼 주석: "타임라인은 절대 시각을 보여 주면 됩니다"). 보는 사람의
 * 프로필 시간대로 그립니다 — 같은 순간을 각자 자기 시계로 읽는 것이 맞습니다.
 *
 * Intl 이 던질 수 있으므로 감쌉니다. 시각 한 줄 때문에 피드가 죽으면 안 됩니다.
 */
function formatPostTime(iso: string, timeZone: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''

  const format = (zone: string) =>
    new Intl.DateTimeFormat('ko-KR', {
      timeZone: zone,
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(at)

  try {
    return format(timeZone)
  } catch {
    try {
      return format('Asia/Seoul')
    } catch {
      return ''
    }
  }
}

// ---------------------------------------------------------------------------
// 한 장
// ---------------------------------------------------------------------------

function PostCard({
  post,
  timeZone,
  groupId,
}: {
  post: TimelinePost
  timeZone: string
  groupId: string
}) {
  const when = formatPostTime(post.createdAt, timeZone)

  return (
    <article className="border-line bg-surface flex flex-col gap-3 rounded-2xl border p-4">
      <header className="flex items-center gap-3">
        <div className="bg-surface-2 grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-lg">
          {post.avatar.kind === 'image' && post.avatar.imageUrl ? (
            // alt 가 빈 문자열인 이유: 바로 옆에 이름이 글자로 있습니다.
            // "○○님의 프로필 사진" 을 읽어 주면 이름을 두 번 듣습니다.
            <img
              src={post.avatar.imageUrl}
              alt=""
              className="size-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span aria-hidden="true">{post.avatar.emoji}</span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-fg truncate text-sm font-medium">
            {post.displayName}
            {post.isMine && <span className="text-muted font-normal"> (나)</span>}
          </p>
          {when && (
            <p className="text-muted text-xs tabular-nums">
              {/* dateTime 은 기계가 읽는 절대 시각. 화면 글자는 사람의 시간대. */}
              <time dateTime={post.createdAt}>{when}</time>
            </p>
          )}
        </div>
      </header>

      {post.body && (
        // whitespace-pre-wrap: 사용자가 넣은 줄바꿈을 그대로 살립니다.
        // keep-all: 한국어가 단어 중간에서 끊기지 않게.
        <p className="text-fg text-base leading-relaxed whitespace-pre-wrap [word-break:keep-all]">
          {post.body}
        </p>
      )}

      {post.photoUrl && (
        <img
          src={post.photoUrl}
          alt={post.body ? '' : `${post.displayName}님이 올린 사진`}
          className="border-line w-full rounded-xl border object-contain"
          loading="lazy"
          decoding="async"
        />
      )}

      {post.photoFailed && (
        // ★ 조용히 빼지 않습니다 ★ 사진이 있는 글에서 사진만 사라지면 글쓴이는
        // 업로드가 실패한 줄 알고 같은 글을 다시 올립니다.
        <p className="text-muted border-line bg-surface-2 rounded-xl border px-3 py-2 text-xs [word-break:keep-all]">
          사진을 불러오지 못했어요. 화면을 새로고침하면 다시 보일 수 있어요.
        </p>
      )}

      {post.isMine && (
        <form action={deletePost} className="self-end">
          <input type="hidden" name="postId" value={post.id} />
          {/* 삭제 뒤 이 그룹의 타임라인으로 돌아오기 위한 값입니다. */}
          <input type="hidden" name="g" value={groupId} />
          <ConfirmButton
            size="sm"
            confirmMessage="이 게시물을 지울까요? 사진도 함께 사라지고, 되돌릴 수 없어요."
            confirmLabel="네, 지울게요"
            pendingLabel="지우는 중…"
          >
            지우기
          </ConfirmButton>
        </form>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// 목록
// ---------------------------------------------------------------------------

export type FeedProps = {
  data: TimelineData
  /** 보는 사람의 프로필 시간대. 시각을 그 시계로 읽어 줍니다. */
  timeZone: string
  /** 삭제 폼이 돌아올 그룹. */
  groupId: string
  groupName: string
}

export default function Feed({ data, timeZone, groupId, groupName }: FeedProps) {
  // 실패와 "아직 아무도 안 올림" 은 완전히 다른 상태입니다. 실패를 빈 목록으로
  // 삼키면 "친구들이 아무것도 안 했다" 는 거짓말이 됩니다.
  if (data.error) {
    return (
      <Card title="타임라인을 불러오지 못했어요">
        <ErrorText>{data.error}</ErrorText>
        <Hint>아직 아무것도 지워지지 않았어요. 다시 불러오면 그대로 보일 거예요.</Hint>
        {/* 소프트 내비게이션은 라우터 캐시에서 그대로 나올 수 있어서, 정말로
            다시 조회하려면 실제 문서 요청이어야 합니다(app/page.tsx 와 동일). */}
        <a
          href={`/?g=${groupId}&tab=feed`}
          className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 불러오기
        </a>
      </Card>
    )
  }

  if (data.posts.length === 0) {
    return (
      <Card>
        <EmptyState
          title="아직 올라온 게 없어요"
          description={`${groupName}의 첫 글을 남겨보세요. 계획이 아니라 오늘 한 일을 적는 곳이에요.`}
        />
      </Card>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="sr-only">타임라인</h2>

      {data.posts.map((post) => (
        <PostCard key={post.id} post={post} timeZone={timeZone} groupId={groupId} />
      ))}

      {/* ★ 상한을 숨기지 않습니다 ★ 말하지 않으면 오래된 글이 "사라진" 것처럼
          보입니다. 꽉 찼을 때만 "더 있을 수 있다" 고 덧붙입니다. */}
      <p className="text-muted px-1 text-xs [word-break:keep-all]">
        {data.reachedLimit
          ? `최근 ${data.limit}개만 보여주고 있어요. 더 예전 글은 여기에 나오지 않아요.`
          : `${data.posts.length}개 · 최근 ${data.limit}개까지 보여줘요.`}
      </p>
    </section>
  )
}
