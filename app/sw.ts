import {
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  Serwist,
  StaleWhileRevalidate,
  type RuntimeCaching,
} from 'serwist'

// 오프라인 문서가 읽을 스냅샷의 localStorage 키. 값 하나만 가져오고, 나머지는
// esbuild 의 treeShaking 이 떨어냅니다 (lib/offline.ts 최상위는 부수효과 없음).
// 상대 경로인 이유: 이 워커는 Next 모듈 그래프 밖에서 esbuild 로 번들되므로
// tsconfig 의 '@/*' 별칭 해석에 기대지 않습니다.
import { OFFLINE_SNAPSHOT_KEY } from '../lib/offline'

// `self.__SW_MANIFEST` and `SerwistPushSubscriptionChangeEvent` come from
// types/serwist.d.ts.
declare const self: ServiceWorkerGlobalScope

// ---------------------------------------------------------------------------
// Build-time constants
// ---------------------------------------------------------------------------

/**
 * Inlined by esbuild `define` in app/serwist/[path]/route.ts. The worker is
 * bundled outside the Next.js pipeline, so `process` does not exist here at
 * runtime and NEXT_PUBLIC_* is not inlined for it automatically.
 *
 * This is the fallback key for `pushsubscriptionchange` on engines that fire
 * the event without a usable `oldSubscription.options.applicationServerKey`.
 */
const VAPID_PUBLIC_KEY = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim()

const DEFAULT_TITLE = '매일 할거 적기'
const DEFAULT_BODY = '새 알림이 도착했어요.'
const DEFAULT_ICON = '/icons/icon-192.png'
const SUBSCRIBE_ENDPOINT = '/api/push/subscribe'

interface PushPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
  icon?: string
  badge?: string
}

// ---------------------------------------------------------------------------
// base64url -> Uint8Array
//
// Intentionally duplicated from lib/push/subscribe.ts rather than imported:
// that module is a "use client" React-land module and reaches for `window`,
// which does not exist in a worker. Ten lines of duplication beats dragging
// the client bundle into the service worker graph.
// ---------------------------------------------------------------------------
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64String.trim()
  // base64 decodes 4 chars -> 3 bytes, so the input must be a multiple of 4.
  // A 65-byte P-256 VAPID key is 87 base64url chars; 87 % 4 === 3, so exactly
  // one "=" is appended.
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  // base64url substitutes "-" for "+" (62) and "_" for "/" (63); decoding
  // reverses that mapping.
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = self.atob(base64)
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

function parsePayload(data: PushMessageData | null): PushPayload {
  if (!data) return {}
  try {
    const parsed: unknown = data.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PushPayload
    }
  } catch {
    /* not JSON -- fall through to text */
  }
  try {
    const text = data.text()
    return text.trim() ? { body: text } : {}
  } catch {
    return {}
  }
}

/**
 * Subscribing with `userVisibleOnly: true` is a promise to the push service
 * that EVERY delivery produces a visible notification. Break it and Chrome /
 * Edge substitute their own "This site has been updated in the background"
 * notice, debit the origin's push budget, and eventually revoke the
 * subscription outright. So this function must show something no matter what
 * arrives -- including a push with no payload, an unparseable payload, or a
 * `showNotification` call that itself rejects.
 */
async function handlePush(event: PushEvent): Promise<void> {
  const payload = parsePayload(event.data)
  const url = typeof payload.url === 'string' ? payload.url : '/'
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : 'nudge'
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : DEFAULT_TITLE
  const body =
    typeof payload.body === 'string' && payload.body.trim()
      ? payload.body.trim()
      : DEFAULT_BODY

  // `renotify` is missing from some lib.dom revisions; widen rather than drop
  // the option. It also REQUIRES a tag -- showNotification throws a TypeError
  // with renotify and no tag, which is exactly the failure this whole function
  // exists to avoid.
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    icon: typeof payload.icon === 'string' ? payload.icon : DEFAULT_ICON,
    badge: typeof payload.badge === 'string' ? payload.badge : DEFAULT_ICON,
    tag,
    renotify: true,
    lang: 'ko',
    data: { url, receivedAt: Date.now() },
  }

  try {
    await self.registration.showNotification(title, options)
    return
  } catch {
    /* fall through to the minimal notification */
  }

  try {
    // Minimal, option-free retry: no renotify, no icon, nothing that can throw
    // on an engine that rejected the rich version.
    await self.registration.showNotification(DEFAULT_TITLE, { body: DEFAULT_BODY })
  } catch {
    // Nothing further is possible. Swallow so the promise handed to
    // waitUntil() still resolves -- a rejected waitUntil is itself treated as
    // a userVisibleOnly violation.
  }
}

// ---------------------------------------------------------------------------
// notificationclick
// ---------------------------------------------------------------------------

async function focusOrOpen(rawUrl: string): Promise<void> {
  let target: URL
  try {
    target = new URL(rawUrl, self.location.origin)
  } catch {
    target = new URL('/', self.location.origin)
  }
  // Never let a payload-supplied URL send the user off-origin.
  if (target.origin !== self.location.origin) {
    target = new URL('/', self.location.origin)
  }

  // includeUncontrolled matters: a tab opened before this worker took control
  // is otherwise invisible to matchAll.
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  const sameOrigin = clients.filter((client) => {
    try {
      return new URL(client.url).origin === target.origin
    } catch {
      return false
    }
  })

  // Prefer a tab already showing the target (path + query + hash), so a nudge
  // for today's list does not re-navigate a tab the user is mid-typing in.
  const exact = sameOrigin.find((client) => {
    const current = new URL(client.url)
    return (
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash === target.hash
    )
  })

  const client = exact ?? sameOrigin[0]
  if (client) {
    // client.focus() rejects when the window cannot be focused (no user
    // activation on some engines). Letting that escape would abort the handler
    // before the openWindow fallback below ever runs.
    try {
      const focused = await client.focus()
      if (!exact && 'navigate' in focused) {
        try {
          await focused.navigate(target.href)
        } catch {
          // WindowClient.navigate is unimplemented on iOS Safari; the focused
          // tab simply stays where it was.
        }
      }
      return
    } catch {
      /* fall through to openWindow */
    }
  }

  if (self.clients.openWindow) {
    try {
      await self.clients.openWindow(target.href)
    } catch {
      /* nothing else to try */
    }
  }
}

// ---------------------------------------------------------------------------
// pushsubscriptionchange
// ---------------------------------------------------------------------------

async function notifyResubscribeFailed(): Promise<void> {
  try {
    await self.registration.showNotification('알림이 꺼졌어요', {
      body: '앱을 열고 알림을 다시 켜주세요.',
      icon: DEFAULT_ICON,
      badge: DEFAULT_ICON,
      tag: 'push-resubscribe-failed',
      lang: 'ko',
      data: { url: '/' },
    })
  } catch {
    /* best effort */
  }
}

/**
 * POST the replacement subscription and ACTUALLY CHECK THE RESULT.
 *
 * This event commonly fires days after the last visit, in a worker woken with
 * no page attached. The Supabase session cookie may well have expired, in
 * which case the route answers 401 -- which, if ignored, is indistinguishable
 * from success. The old endpoint has already been discarded by the push
 * service at that point, so the user goes permanently silent with no signal.
 */
async function persistFromWorker(
  subscription: PushSubscription,
  oldEndpoint: string | undefined,
): Promise<boolean> {
  const body = JSON.stringify({
    subscription: subscription.toJSON(),
    oldEndpoint,
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(SUBSCRIBE_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (response.ok) return true
      // 4xx other than 408/429 will not fix itself on a retry.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        return false
      }
    } catch {
      /* offline or DNS failure -- retry once */
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
  return false
}

async function resubscribe(event: SerwistPushSubscriptionChangeEvent): Promise<void> {
  const oldEndpoint = event.oldSubscription?.endpoint
  let next = event.newSubscription ?? null

  if (!next) {
    // Chrome usually hands us `oldSubscription.options.applicationServerKey`.
    // Firefox and WebKit routinely fire this event with no options object at
    // all -- giving up there would make an expired subscription unrecoverable
    // until the user happens to tap the button again. Fall back to the key
    // compiled in at build time.
    const fromOld = event.oldSubscription?.options?.applicationServerKey ?? null
    let applicationServerKey: BufferSource | null = fromOld

    if (!applicationServerKey) {
      if (!VAPID_PUBLIC_KEY) {
        await notifyResubscribeFailed()
        return
      }
      try {
        applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      } catch {
        await notifyResubscribeFailed()
        return
      }
    }

    try {
      next = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    } catch {
      // Possible if permission was revoked between the two events. Nothing to
      // persist, and a notification would be noise if the user turned it off
      // deliberately.
      return
    }
  }

  const ok = await persistFromWorker(next, oldEndpoint)
  if (!ok) await notifyResubscribeFailed()
}

// ---------------------------------------------------------------------------
// 오프라인 문서 (읽기 전용)
//
// ═══ 무엇을 캐시하지 않기로 했는가, 그리고 왜 ═══════════════════════════════
//
// 이 앱의 화면은 전부 동적 SSR 입니다. `/` 의 HTML 안에는 로그인한 사람의
// 이름, 그룹 이름, 오늘 할 일 제목이 그대로 들어 있습니다. 그걸 Cache API 에
// 넣으면 원점(origin) 단위로 남습니다 — 기기를 함께 쓰는 다음 사람이,
// 로그아웃한 뒤에도, 남의 하루를 그대로 보게 됩니다. 그래서:
//
//   · 인증된 HTML 을 캐시에 넣지 않습니다.
//   · RSC 페이로드(`RSC: 1` 요청)도 넣지 않습니다 — HTML 과 같은 내용입니다.
//   · /api 응답도 넣지 않습니다.
//
// 대신 오프라인 문서를 **워커가 그 자리에서 만들어 냅니다.** 캐시 항목이 아예
// 없으므로 샐 것도 없고, 프리캐시 매니페스트에 새 URL 을 넣지 않아도 됩니다.
// 후자가 특히 중요합니다: 아래 Serwist 설정의 주석대로, 프리캐시에 실패하는
// URL 이 하나라도 들어가면 install 이 통째로 깨지고 그러면 푸시가 죽습니다.
// 실기기에서 검증이 끝난 그 경로를 오프라인 화면 때문에 위험에 빠뜨릴 이유가
// 없습니다.
//
// 전용 /offline 라우트를 만들지 않은 이유도 같습니다. 매니페스트가 담는 것은
// `.next/static/**` 와 `public/**` 뿐이라(@serwist/turbopack 의
// generateGlobPatterns) 어떤 페이지 HTML 도 프리캐시되지 않습니다. 그러니
// /offline 도 런타임에 한 번 받아 캐시에 넣어 둬야 하는데, 그 시점에
//   (a) 세션이 없으면 proxy.ts 가 /login 으로 302 를 보내고(로그인 화면이
//       오프라인 화면으로 캐시됨),
//   (b) 다음 배포에서 청크 해시가 바뀌면 캐시된 HTML 이 사라진 청크를
//       가리켜 빈 화면이 됩니다.
// 두 실패 모두 결과가 "오프라인일 때 아무것도 안 보임"입니다. 정확히 이
// 기능이 존재하는 이유를 무효로 만드는 실패라서, 의존성이 0인 쪽을 택했습니다.
//
// 대가는 이 아래의 손으로 쓴 HTML/CSS 입니다. 색은 app/globals.css 의 토큰을
// 그대로 옮겨 적었습니다(Tailwind 산출물은 파일명이 해시라 워커가 가리킬 수
// 없습니다). 팔레트를 바꾸면 여기도 같이 바꿔야 합니다.
// ---------------------------------------------------------------------------

/**
 * 오프라인일 때 내비게이션에 돌려줄 문서.
 *
 * 안에서 하는 일은 딱 하나 — lib/offline.ts 가 써 둔 스냅샷을 읽어 그리기.
 * 체크박스도, 추가 폼도, 삭제 버튼도 없습니다. 이번 범위는 읽기 전용이고,
 * 누를 수 있게 만들어 놓고 저장이 안 되는 것보다 아예 없는 편이 정직합니다.
 *
 * 목록은 textContent 로만 넣습니다. innerHTML 이었다면 localStorage 를 고칠 수
 * 있는 누구든(확장, 콘솔) 이 문서에 스크립트를 심을 수 있습니다.
 */
const OFFLINE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>오프라인 · 매일 할거 적기</title>
<style>
:root{
--bg:oklch(0.98 0.002 250);--surface:oklch(1 0 0);--surface-2:oklch(0.96 0.003 250);
--fg:oklch(0.21 0.006 250);--muted:oklch(0.52 0.008 250);--line:oklch(0.91 0.004 250);
--accent:oklch(0.62 0.17 258);--accent-fg:oklch(0.99 0 0);
}
@media (prefers-color-scheme:dark){:root{
--bg:oklch(0.17 0.005 250);--surface:oklch(0.21 0.006 250);--surface-2:oklch(0.25 0.007 250);
--fg:oklch(0.95 0.003 250);--muted:oklch(0.66 0.009 250);--line:oklch(0.3 0.008 250);
--accent:oklch(0.7 0.15 258);--accent-fg:oklch(0.17 0.005 250);
}}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--fg);min-height:100dvh;
font-family:system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;
-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
main{max-width:28rem;margin:0 auto;display:flex;flex-direction:column;gap:1.25rem;
padding:1.5rem max(1rem,env(safe-area-inset-right)) calc(2rem + env(safe-area-inset-bottom)) max(1rem,env(safe-area-inset-left));
padding-top:calc(1.5rem + env(safe-area-inset-top))}
.banner{border:1px solid var(--line);background:var(--surface-2);border-radius:1rem;
padding:0.875rem 1rem;display:flex;gap:0.625rem;align-items:flex-start}
.banner b{font-size:0.875rem;font-weight:600;display:block}
.banner span{font-size:0.8125rem;color:var(--muted);line-height:1.6;word-break:keep-all;display:block;margin-top:0.25rem}
h1{font-size:1.5rem;font-weight:600;letter-spacing:-0.01em}
h2{font-size:1rem;font-weight:600}
.meta{color:var(--muted);font-size:0.875rem;margin-top:0.25rem}
.card{border:1px solid var(--line);background:var(--surface);border-radius:1rem;padding:1.25rem}
ul{list-style:none;margin-top:0.5rem}
li{display:flex;gap:0.75rem;align-items:center;min-height:3.5rem;
padding:0.75rem 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
.box{width:1.5rem;height:1.5rem;flex:0 0 auto;border-radius:0.375rem;border:1px solid var(--line);
display:grid;place-items:center;color:transparent}
.box.on{border-color:var(--accent);background:var(--accent);color:var(--accent-fg)}
.box svg{display:block}
.t{font-size:0.875rem;line-height:1.6;word-break:keep-all;min-width:0;flex:1}
.t.on{color:var(--muted);text-decoration:line-through}
.hint{color:var(--muted);font-size:0.875rem;line-height:1.6;word-break:keep-all}
.empty{text-align:center;padding:2rem 0.5rem}
.empty strong{display:block;font-size:0.875rem;font-weight:500;margin-bottom:0.5rem}
button{width:100%;height:3rem;border:0;border-radius:0.75rem;background:var(--accent);
color:var(--accent-fg);font-size:1rem;font-weight:500;font-family:inherit;cursor:pointer;
touch-action:manipulation;transition:transform .15s}
button:active{transform:scale(.99)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms !important}}
</style>
</head>
<body>
<main>
  <p class="banner" role="status">
    <span aria-hidden="true">📴</span>
    <span style="flex:1">
      <b>오프라인 — 마지막으로 본 내용이에요</b>
      <span id="stamp">지금은 인터넷에 연결돼 있지 않아요. 아래 목록은 최신이 아닐 수 있어요.</span>
    </span>
  </p>

  <header>
    <h1>오늘 할 일</h1>
    <p class="meta" id="meta"></p>
  </header>

  <section class="card">
    <h2>할 일</h2>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>
      <strong>보여드릴 목록이 없어요</strong>
      <p class="hint">인터넷에 연결된 상태로 앱을 한 번 열면, 그때 본 오늘 목록을 여기서 다시 볼 수 있어요.</p>
    </div>
  </section>

  <p class="hint">연결되기 전까지는 체크하거나 새로 적을 수 없어요. 지금 화면은 보기 전용이에요.</p>

  <button type="button" id="retry">다시 시도하기</button>
</main>
<script>
(function () {
  var KEY = ${JSON.stringify(OFFLINE_SNAPSHOT_KEY)};
  var MAX_AGE = 36 * 60 * 60 * 1000;

  function today() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) { return ''; }
  }

  // lib/offline.ts 의 readTodaySnapshot() 과 같은 규칙입니다:
  // 형식이 맞아야 하고, 오늘이어야 하고, 너무 오래되지 않아야 합니다.
  function read() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;

    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return null; }
    if (!snap || snap.v !== 1) return null;
    if (typeof snap.date !== 'string' || !Array.isArray(snap.tasks)) return null;
    if (typeof snap.savedAt !== 'number' || !isFinite(snap.savedAt)) return null;

    // 어제 목록을 오늘 것처럼 보여주지 않습니다.
    if (snap.date !== today()) return null;

    var age = Date.now() - snap.savedAt;
    if (age < -60000 || age > MAX_AGE) return null;

    return snap;
  }

  function tick() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '3');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'm5 12.5 4.5 4.5L19 7');
    svg.appendChild(p);
    return svg;
  }

  var snap = read();
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  var meta = document.getElementById('meta');
  var stamp = document.getElementById('stamp');

  if (!snap || snap.tasks.length === 0) {
    list.hidden = true;
    empty.hidden = false;
  } else {
    var done = 0;
    for (var i = 0; i < snap.tasks.length; i++) {
      var task = snap.tasks[i];
      if (task.done) done++;

      var li = document.createElement('li');

      var box = document.createElement('span');
      box.className = task.done ? 'box on' : 'box';
      box.setAttribute('aria-hidden', 'true');
      if (task.done) box.appendChild(tick());

      var text = document.createElement('span');
      text.className = task.done ? 't on' : 't';
      // ★ textContent ★ — 이 값은 localStorage 에서 왔습니다.
      text.textContent = String(task.title);

      var sr = document.createElement('span');
      sr.textContent = task.done ? ' (완료)' : '';
      sr.style.position = 'absolute';
      sr.style.width = '1px'; sr.style.height = '1px';
      sr.style.overflow = 'hidden'; sr.style.clip = 'rect(0 0 0 0)';
      text.appendChild(sr);

      li.appendChild(box);
      li.appendChild(text);
      list.appendChild(li);
    }

    var parts = [];
    if (snap.groupName) parts.push(snap.groupName);
    parts.push(done + ' / ' + snap.tasks.length + ' 완료');
    meta.textContent = parts.join(' · ');

    var when = '';
    try {
      when = new Date(snap.savedAt).toLocaleTimeString('ko-KR', {
        hour: 'numeric', minute: '2-digit'
      });
    } catch (e) { when = ''; }
    stamp.textContent = when
      ? '오늘 ' + when + '에 본 목록이에요. 그 뒤에 바뀐 내용은 반영돼 있지 않아요.'
      : '이 목록은 최신이 아닐 수 있어요.';
  }

  document.getElementById('retry').addEventListener('click', function () {
    location.reload();
  });

  // 'online' 은 "확인해 볼 만하다"는 신호일 뿐입니다. 여기서는 다시 불러오는
  // 것 말고 할 일이 없고, 여전히 안 되면 이 화면이 다시 나올 뿐입니다.
  addEventListener('online', function () { location.reload(); });
})();
</script>
</body>
</html>
`

/** 매번 새 Response 를 만듭니다. body 는 한 번만 읽을 수 있어서 재사용이 불가능합니다. */
function offlineDocument(): Response {
  return new Response(OFFLINE_HTML, {
    // 503 이 더 정직한 HTTP 이지만 200 을 씁니다. 크롬의 설치 판정은
    // "오프라인에서 start_url 이 200 을 주는가"를 보고, 이 앱은 홈 화면에
    // 설치돼서 쓰이는 것이 전제입니다.
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 이 문서가 HTTP 캐시에 남아 온라인일 때 다시 나오면 최악입니다.
      'Cache-Control': 'no-store, must-revalidate',
    },
  })
}

/**
 * 내비게이션 한 건.
 *
 * 온라인이면 하는 일이 없습니다 — 네트워크 응답을 그대로 통과시킵니다.
 * 여기서 절대 하지 않는 것: 그 응답을 캐시에 넣기(위 주석 참고).
 *
 * `fetch(event.request)` 로 원본 Request 를 그대로 넘기는 것이 중요합니다.
 * 내비게이션 Request 는 redirect:'manual' 이라 /auth/callback 같은 3xx 가
 * opaqueredirect 로 오고, 그걸 respondWith 로 돌려주면 브라우저가 알아서
 * 따라갑니다. 새 Request 를 만들면 그 성질이 사라져 로그인 왕복이 깨집니다.
 */
async function handleNavigation(event: FetchEvent): Promise<Response> {
  // navigationPreload 가 켜져 있으므로 이미 나가 있는 요청이 있습니다. 그걸
  // 안 쓰면 브라우저가 취소하면서 콘솔 경고를 내고, 왕복 한 번이 낭비됩니다.
  try {
    const preloaded = (await event.preloadResponse) as Response | undefined
    if (preloaded) return preloaded
  } catch {
    /* 프리로드가 실패했을 뿐입니다 — 아래에서 평범하게 다시 시도합니다 */
  }

  try {
    return await fetch(event.request)
  } catch {
    // 여기 오는 경우는 "네트워크가 없다" 하나뿐입니다. 서버가 500 을 주면
    // fetch 는 성공하고 그 500 이 위에서 그대로 나갑니다.
    return offlineDocument()
  }
}

// ---------------------------------------------------------------------------
// 런타임 캐시 정책
//
// @serwist/turbopack 의 defaultCache 를 쓰지 않습니다. 그 목록에는 이 앱에서
// 위험한 규칙이 셋 있습니다(9.5.12 기준, node_modules 에서 확인):
//
//   1. `others` — NetworkFirst, matcher 는 `sameOrigin && !/api/`.
//      바로 위의 `pages` 규칙은 **요청**의 Content-Type 헤더가 text/html 인지
//      보는데, 문서 내비게이션 GET 에는 Content-Type 요청 헤더가 없습니다.
//      그래서 `pages` 는 절대 맞지 않고 모든 HTML 문서가 `others` 로 떨어져
//      캐시됩니다 — 로그인한 사용자의 완성된 HTML 이 통째로 말입니다.
//   2. `pages-rsc` / `pages-rsc-prefetch` — RSC 페이로드. HTML 과 같은 내용
//      (이름·그룹명·할 일 제목)이 들어 있습니다.
//   3. `apis` — /api GET 응답.
//
// 셋 다 원점 단위 저장소에 남고 로그아웃해도 지워지지 않습니다. 기기를 함께
// 쓰면 그대로 새는 경로입니다. 그래서 "내용이 없는 것만 캐시한다"로 뒤집었습니다.
//
// 온라인 동작은 달라지지 않습니다. 저 규칙들은 전부 NetworkFirst 라 온라인에서는
// 어차피 네트워크가 먼저였고, 캐시가 쓰이던 유일한 순간은 오프라인이었으며,
// 그 자리를 이제 위의 오프라인 문서가 정직하게 대신합니다.
// ---------------------------------------------------------------------------

const IMMUTABLE_ASSET_EXPIRY = new ExpirationPlugin({
  maxEntries: 128,
  maxAgeSeconds: 30 * 24 * 60 * 60,
  maxAgeFrom: 'last-used',
})

const runtimeCaching: RuntimeCaching[] = [
  {
    // 빌드 산출물. 파일명에 콘텐츠 해시가 박혀 있어 내용이 바뀌면 URL 이
    // 바뀝니다. 사용자 데이터가 들어갈 수 없는 유일한 부류입니다.
    matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname.startsWith('/_next/static/'),
    handler: new CacheFirst({ cacheName: 'next-static', plugins: [IMMUTABLE_ASSET_EXPIRY] }),
  },
  {
    // public/ 의 아이콘과 매니페스트. 프리캐시에도 들어 있고, 이건 그 그물을
    // 빠져나간 경우(다른 크기 요청 등)를 위한 보조입니다. 역시 공용 파일입니다.
    matcher: ({ sameOrigin, url }) =>
      sameOrigin &&
      (url.pathname.startsWith('/icons/') ||
        url.pathname === '/manifest.json' ||
        url.pathname === '/favicon.ico'),
    handler: new StaleWhileRevalidate({
      cacheName: 'app-shell-assets',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 32,
          maxAgeSeconds: 30 * 24 * 60 * 60,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },
  {
    // 나머지 전부: HTML, RSC, /api, /auth, 교차 출처. 캐시하지 않습니다.
    matcher: () => true,
    handler: new NetworkOnly(),
  },
]

/**
 * 예전 defaultCache 가 만들어 둔 캐시를 지웁니다.
 *
 * 정책을 바꿔도 이미 설치된 기기에는 그때 저장된 남의 HTML 과 RSC 가 그대로
 * 남습니다. 새 워커가 활성화될 때 한 번 치웁니다.
 *
 * ★ 이름을 나열해서 지웁니다 ★ "우리 것 말고 다 지우기"로 하면 Serwist 의
 * 프리캐시(serwist-precache-*)까지 날려서 install 이 이미 끝난 워커가 자기
 * 자산을 잃습니다.
 */
const RETIRED_CACHES = [
  'pages',
  'pages-rsc',
  'pages-rsc-prefetch',
  'others',
  'apis',
  'next-data',
  'static-data-assets',
  'cross-origin',
  'next-static-js-assets',
  'static-js-assets',
  'static-style-assets',
  'static-image-assets',
]

async function purgeRetiredCaches(): Promise<void> {
  try {
    await Promise.all(
      RETIRED_CACHES.map((name) => caches.delete(name).catch(() => false)),
    )
  } catch {
    // 캐시 스토리지 자체를 못 쓰는 환경. activate 를 실패시키지 않습니다 —
    // 실패한 activate 는 워커를 못 쓰게 만들고, 그러면 푸시도 같이 죽습니다.
  }
}

// ---------------------------------------------------------------------------
// Listener registration
//
// Serwist's docs are explicit: custom listeners must be added BEFORE
// serwist.addEventListeners(), or Serwist's own handlers can claim the event
// first.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  event.waitUntil(focusOrOpen(typeof data?.url === 'string' ? data.url : '/'))
})

self.addEventListener('pushsubscriptionchange', (event) => {
  const changeEvent = event as unknown as SerwistPushSubscriptionChangeEvent
  changeEvent.waitUntil(resubscribe(changeEvent))
})

/**
 * 문서 내비게이션만 가로챕니다.
 *
 * Serwist 보다 먼저 등록되므로, 여기서 respondWith 를 부르면 그 요청은
 * Serwist 라우터에 닿지 않습니다. 그래서 조건을 최대한 좁게 잡습니다 —
 * 프리캐시 자산 서빙이나 푸시 관련 요청을 실수로 채가면 안 됩니다.
 *
 * Next 의 클라이언트 사이드 이동(RSC fetch)은 mode 가 'navigate' 가 아니라
 * 여기 걸리지 않습니다. 그런 요청은 오프라인에서 그냥 실패하고, 라우터가
 * 하드 내비게이션으로 재시도하면 그때 이 핸들러가 받습니다.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request

  if (request.method !== 'GET') return
  if (request.mode !== 'navigate') return

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  // 다른 출처로 나가는 내비게이션은 우리가 대답할 일이 아닙니다.
  if (url.origin !== self.location.origin) return

  event.respondWith(handleNavigation(event))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(purgeRetiredCaches())
})

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,
  runtimeCaching,
  // No `fallbacks` entry on purpose. A fallback URL must ALSO be present in
  // the precache manifest, and precaching a route that 404s or redirects
  // (e.g. through auth) fails the install step outright -- which takes push
  // down with it.
  //
  // 오프라인 폴백은 위의 'fetch' 리스너가 담당합니다. 워커가 그 자리에서
  // 만들어 내는 문서라서 프리캐시할 URL 자체가 없고, 따라서 install 을
  // 위험에 빠뜨리지 않습니다.
})

serwist.addEventListeners()
