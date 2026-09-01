'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { Button, Card, ErrorText, Hint, SuccessText } from '@/components/ui'
import { normalizeAvatarImage } from '@/lib/image-normalize'
import { createClient } from '@/lib/supabase/client'

import { createPost } from './actions'

/**
 * "오늘 뭐 했는지" 한 장 올리기 — 글 + 사진.
 *
 * ---------------------------------------------------------------------------
 * 왜 Client Component 인가
 * ---------------------------------------------------------------------------
 * 사진 파일은 Server Action 을 지나가지 않습니다. 브라우저가 Supabase Storage
 * 로 직접 올리고, 결과 경로만 createPost() 로 넘깁니다(app/timeline/actions.ts
 * 머리말, app/me/page.tsx 와 같은 판단). 그러면 "고른 파일 · 미리보기 ·
 * 업로드 진행 · 어느 단계에서 실패했는가" 가 전부 브라우저에만 있는 상태가
 * 되고, 그건 <form action> 하나로는 표현할 수 없습니다.
 *
 * ---------------------------------------------------------------------------
 * ★ 실패하면 방금 올린 파일을 즉시 지웁니다 ★
 * ---------------------------------------------------------------------------
 * 순서는 (1) Storage 업로드 → (2) posts INSERT 입니다. (2)가 실패하면 (1)의
 * 파일은 아무 게시물도 가리키지 않는 고아가 됩니다. 0010 ⑧ 의 정리 큐
 * 트리거는 **posts 행이 사라질 때만** 돌기 때문에 이 고아는 큐에 들어가지도
 * 않습니다 — 아무도 치우지 않습니다. 그래서 여기서 그 자리에서 remove()
 * 합니다. 0010 ⑥ 의 posts_delete_own_folder 정책이 그 문이고, 0010 ⑩ 의
 * 「앱이 책임져야 하는 정리 작업」 1번이 이 동작입니다.
 *
 * ---------------------------------------------------------------------------
 * 버킷 계약의 사본 (app/me/avatar-storage.ts 와 같은 처방)
 * ---------------------------------------------------------------------------
 * 아래 상수는 lib/posts.ts 에도 있습니다. 거기서 import 하지 **못합니다** —
 * lib/posts.ts 가 createAdminClient()(= 'server-only')를 부르므로 클라이언트
 * 컴포넌트가 그 모듈을 건드리는 순간 빌드가 깨집니다.
 *
 * ⚠️ 이건 방어선이 아닙니다 ⚠️ 진짜 방어선은 버킷의 file_size_limit(1 MiB)과
 * allowed_mime_types 이고, Storage API 를 직접 부르면 아래 검사는 없는
 * 것입니다. 여기 있는 이유는 하나 — 4MB 를 올려놓고 실패를 보는 대신, 고르는
 * 즉시 한국어로 알려 주기 위해서입니다. ★ 버킷보다 느슨하게 바꾸지 마세요 ★
 * 그러면 이 검사는 통과하고 서버가 거절하는 상태만 남습니다.
 */

/** 0010 ⑤ 의 버킷. **비공개** 입니다 — 사진은 서명 URL 로만 보입니다. */
const POSTS_BUCKET = 'posts'

/** 0010 ⑤ 의 file_size_limit 과 같은 값. lib/posts.ts 의 POST_PHOTO_MAX_BYTES. */
const MAX_UPLOAD_BYTES = 1024 * 1024

/**
 * 고른 원본의 상한. 버킷 한도(1 MiB)보다 **크게** 둡니다 — 폰 원본은 4~8MB
 * 이고 그걸 줄이는 것이 이 화면이 하는 일이기 때문입니다. 여기서 1 MiB 로
 * 막으면 정상적인 사진이 고르는 즉시 거절됩니다. 대신 무한정 받지도 않습니다:
 * 20MB 짜리를 저사양 기기에서 디코드하면 탭이 죽습니다.
 */
const MAX_PICK_BYTES = 12 * 1024 * 1024

/** 0010 ⑤ 가 앱에 지시한 값: "장변 1280px, q0.8". */
const MAX_EDGE = 1280
const QUALITY = 0.8

/** posts_body_len_chk 의 상한과 같은 값. */
const BODY_MAX = 2000

/** 버킷의 allowed_mime_types 와 같은 목록. svg·gif 는 일부러 없습니다(0010 ⑤). */
const ALLOWED_MIME: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
}

const ACCEPT_ATTR = Object.keys(ALLOWED_MIME).join(',')

/**
 * 랜덤 파일명. 0010 의 posts_photo_path_shape_chk 가 요구하는 모양
 * `[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)` 을 지킵니다.
 * (app/me/avatar-storage.ts 의 randomFileName 과 같은 규칙 — 거기서 import
 *  하지 않는 것은 그 파일이 아바타 버킷의 계약을 들고 있어서입니다.)
 */
function randomFileName(): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : // 보안 컨텍스트가 아니면 randomUUID 가 없습니다.
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `${id}.jpg`
}

/**
 * Postgres `char_length()` 는 코드 포인트를 셉니다. '😀'.length 는 2 지만
 * DB 에서는 1 입니다. 글자 수 표시가 서버 판정과 어긋나면, 아직 여유가 있는
 * 글이 저장에서 거절당합니다.
 */
function charLength(value: string): number {
  return Array.from(value).length
}

/** Storage 가 돌려주는 영어 메시지를 사용자가 읽을 한국어로. */
function uploadMessage(raw: string): string {
  const text = raw.toLowerCase()
  if (text.includes('exceeded') || text.includes('too large') || text.includes('payload')) {
    return '사진을 더 줄여야 해요. 조금 더 작은 사진으로 다시 시도해 주세요.'
  }
  if (text.includes('mime') || text.includes('content type')) {
    return 'JPG · PNG · WEBP 사진만 올릴 수 있어요.'
  }
  // 0010 ⑦ 의 트리거가 폴더당 200개를 넘기면 54000 으로 거부합니다.
  if (text.includes('54000') || text.includes('보관할 수 있습니다')) {
    return '저장된 사진이 너무 많아요. 예전 게시물을 지우면 자리가 돌아와요.'
  }
  if (text.includes('bucket not found')) {
    return '사진 저장소가 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.'
  }
  if (text.includes('row-level security') || text.includes('unauthorized') || text.includes('jwt')) {
    return '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.'
  }
  return '사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요.'
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

export type ComposerProps = {
  /** 올릴 그룹. 서버가 RLS 로 한 번 더 검사합니다. */
  groupId: string
  /** 경로 `<uid>/<파일>` 의 앞부분. 검증된 JWT 에서 온 값을 서버가 넘깁니다. */
  userId: string
  /** "○○에 올라가요" 한 줄용. 그룹이 여럿일 때 어디로 가는지 헷갈리지 않게. */
  groupName: string
}

export default function Composer({ groupId, userId, groupName }: ComposerProps) {
  const router = useRouter()

  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 미리보기 objectURL 은 반드시 회수합니다. 안 하면 사진을 고를 때마다 blob 이
  // 쌓이고, 모바일에서는 그게 곧 메모리 압박입니다(app/me/page.tsx 와 동일).
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const bodyLength = charLength(body)
  const tooLong = bodyLength > BODY_MAX
  const empty = body.trim().length === 0 && !file

  function clearFile() {
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    setDone(false)

    const picked = event.target.files?.[0] ?? null
    if (!picked) {
      setFile(null)
      return
    }

    if (!(picked.type in ALLOWED_MIME)) {
      clearFile()
      setError('JPG · PNG · WEBP 사진만 올릴 수 있어요.')
      return
    }
    if (picked.size > MAX_PICK_BYTES) {
      clearFile()
      setError('사진이 너무 커요. 조금 더 작은 사진으로 골라 주세요.')
      return
    }

    setFile(picked)
  }

  /**
   * 올린 파일 되돌리기. 실패해도 진행합니다 — 이미 사용자에게는 다른 실패를
   * 말하는 중이고, 정리 실패를 그 위에 겹쳐 봐야 할 수 있는 일이 없습니다.
   */
  async function removeUploaded(path: string) {
    try {
      const { error: removeError } = await createClient()
        .storage.from(POSTS_BUCKET)
        .remove([path])
      if (removeError) {
        console.error('[timeline] 고아 사진 삭제 실패', removeError.message)
      }
    } catch (cause) {
      console.error('[timeline] 고아 사진 삭제 중 예외', cause)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || empty || tooLong) return

    setBusy(true)
    setError(null)
    setDone(false)

    let uploadedPath: string | null = null

    if (file) {
      // ★ 고른 파일을 그대로 올리지 않습니다 ★ 두 가지 이유가 겹칩니다.
      //   1) EXIF — 휴대폰 사진에는 GPS 좌표가 박혀 있습니다. 버킷이 비공개라
      //      URL 이 새지는 않지만, 그룹 친구들은 어차피 그 사진을 봅니다.
      //      "밥 사진" 을 올렸는데 집 좌표가 같이 가는 것은 의도가 아닙니다.
      //   2) 용량 — 버킷이 1 MiB 입니다. 폰 원본(4~8MB)은 그 자리에서 실패하고,
      //      그게 0010 ⑤ 의 의도입니다("앱이 줄여서 올려라").
      // 실패하면 원본으로 되돌아가지 **않고** 그대로 실패합니다.
      const normalized = await normalizeAvatarImage(file, {
        maxEdge: MAX_EDGE,
        quality: QUALITY,
        maxBytes: MAX_UPLOAD_BYTES,
        fileName: randomFileName(),
      })

      if (!normalized.ok) {
        setBusy(false)
        setError(normalized.message)
        return
      }

      // 경로는 0010 이 요구하는 모양 그대로: <내 uuid>/<무작위>.jpg.
      // 깊이가 1 이 아니거나 첫 세그먼트가 내 uuid 가 아니면 storage 정책이
      // 거절하고, posts_photo_path_owner_chk 도 거절합니다.
      const objectPath = `${userId}/${normalized.file.name}`

      const { error: uploadError } = await createClient()
        .storage.from(POSTS_BUCKET)
        .upload(objectPath, normalized.file, {
          contentType: normalized.file.type,
          // 파일명이 매번 새로 만들어지므로 덮어쓸 대상이 없습니다.
          upsert: false,
        })

      if (uploadError) {
        console.error('[timeline] 사진 업로드 실패', uploadError.message)
        setBusy(false)
        setError(uploadMessage(uploadError.message))
        return
      }

      uploadedPath = objectPath
    }

    const result = await createPost(groupId, body, uploadedPath)

    if (!result.ok) {
      // ★ 고아 청소 ★ 파일 머리말 참고. 이 줄이 없으면 아무도 가리키지 않는
      // 파일이 버킷에 영원히 남고, 0010 ⑧ 의 큐도 그것을 못 잡습니다.
      if (uploadedPath) await removeUploaded(uploadedPath)
      setBusy(false)
      setError(result.message)
      return
    }

    setBody('')
    clearFile()
    setBusy(false)
    setDone(true)
    // 액션이 revalidatePath 로 서버 캐시를 비웠습니다. 이건 이 화면이 들고 있는
    // RSC 페이로드를 다시 받아 와 방금 올린 글이 바로 보이게 하는 쪽입니다.
    router.refresh()
  }

  return (
    <Card title="오늘 뭐 했어요?">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label htmlFor="post-body" className="sr-only">
          오늘 한 일
        </label>
        <textarea
          id="post-body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value)
            setError(null)
            setDone(false)
          }}
          rows={3}
          disabled={busy}
          placeholder="오늘 한 일을 적어보세요. 사진만 올려도 괜찮아요."
          aria-invalid={tooLong ? true : undefined}
          aria-describedby="post-body-count"
          className={`border-line bg-surface-2 text-fg placeholder:text-muted w-full resize-y rounded-xl border px-3 py-2.5 text-base leading-relaxed outline-none disabled:opacity-40 ${
            tooLong ? 'border-danger' : ''
          }`}
        />

        <div className="flex items-center justify-between gap-3">
          <p
            id="post-body-count"
            className={`text-xs tabular-nums ${tooLong ? 'text-danger' : 'text-muted'}`}
          >
            {bodyLength} / {BODY_MAX}자
          </p>
          {/* 파일 입력은 기본 스타일이 기기마다 제각각이라 라벨을 버튼처럼 씁니다.
              min-h-11 은 44px — iOS 최소 터치 타깃입니다. */}
          <label
            className={`border-line bg-surface text-fg inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-xl border px-4 text-sm font-medium transition active:scale-[0.99] ${
              busy ? 'pointer-events-none opacity-40' : ''
            }`}
          >
            사진 고르기
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              onChange={onPickFile}
              disabled={busy}
              className="sr-only"
            />
          </label>
        </div>

        {previewUrl && (
          <div className="flex flex-col gap-2">
            {/* next/image 가 아니라 <img> 입니다: 미리보기는 blob: URL 이라
                최적화 프록시가 다룰 수 있는 대상이 아닙니다. */}
            <img
              src={previewUrl}
              alt="고른 사진 미리보기"
              className="border-line max-h-72 w-full rounded-xl border object-contain"
            />
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={clearFile}>
              사진 빼기
            </Button>
          </div>
        )}

        <ErrorText>{error}</ErrorText>
        {done && <SuccessText>타임라인에 올렸어요.</SuccessText>}

        <Button type="submit" disabled={empty || tooLong} pending={busy} pendingLabel="올리는 중…">
          올리기
        </Button>

        <Hint>
          <strong className="text-fg">{groupName}</strong> 친구들에게 보여요. 사진은 올릴 때
          자동으로 줄이고 위치 정보를 지웁니다. 올린 글은 내가 지울 수 있어요.
        </Hint>
      </form>
    </Card>
  )
}
