'use client'
import { ToolButton } from './ToolButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestsByFolder } from '@/lib/requestsByFolder'
import { LAYOUT_KEYS, readStringArray, remove, scoped, writeJson } from '@/lib/localStore'
import { ModalFrame } from './ModalFrame'
import { ThemeToggle } from './ThemeToggle'
import { useToast } from './Toast'
import type { FolderRow, RequestRow } from '@/lib/ui-types'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { LoadFailed } from './LoadFailed'
import { setLanguagePreference, useLanguagePreference, useT } from '@/i18n'

/**
 * 표시 설정 — 브라우저에만 저장되는 것들을 한 자리에서 보고 되돌린다.
 *
 * 즐겨찾기·패널 폭은 전부 localStorage 에 있는데, 켜고 끄는 자리는
 * 있어도 '지금 무엇이 그렇게 되어 있는지' 보는 곳이 없었다. 즐겨찾기는 흔적조차 없다 —
 * 다른 브라우저에서 열면 왜 다른지 알 방법이 없다.
 *
 * 서버에 없는 값이라 프로젝트를 옮기거나 브라우저를 바꾸면 사라진다는 것도 여기서 말한다.
 */

type Group = { key: string; label: string; hint?: string; items: { id: string; label: string }[] }

// 지울 키 목록을 여기서 따로 들고 있었더니 실제 키와 어긋났다 — 새로 만든
// ah:responseCollapsed 가 빠져서, '초기화' 를 눌러도 접힌 응답 창이 안 돌아왔다.
// 이제 localStore 가 유일한 출처고, 목록이 실제 키인지는 테스트가 지킨다.
const readList = readStringArray
const writeList = writeJson

export function DisplaySettings({ workspaceId, onClose, embedded = false }: {
  workspaceId: string; onClose: () => void
  /** 설정 다이얼로그 안에 놓일 때 — 배경·닫기 없이 내용만 낸다 */
  embedded?: boolean
}) {
  const t = useT()
  const languagePreference = useLanguagePreference()
  const toast = useToast()
  const [groups, setGroups] = useState<Group[] | null>(null)
  // 이름 조회가 실패한 것과 요청이 실제로 지워진 것은 다른 말이어야 한다.
  const [nameError, setNameError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const favReqKey = scoped.favRequests(workspaceId)
    const favReqIds = readList(favReqKey)

    // 요청 즐겨찾기는 id 로만 저장돼 있어 이름을 붙여야 사람이 알아본다.
    // 지워진 요청은 id 만 남는데, 그것도 보여야 '왜 안 뜨지' 를 이해한다.
    const names = new Map<string, string>()
    let namesLoaded = true
    setNameError(null)
    if (favReqIds.length) {
      try {
        const folders = await fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
        const byFolder = await requestsByFolder(workspaceId, { slim: true })
        const lists = await Promise.all(folders.map(async f => {
          // 폴더 하나가 실패해도 나머지 이름은 붙인다 — 전부 '(삭제된 요청)' 으로 보이면
          // 지워진 줄 알고 즐겨찾기를 정리해 버린다.
          const rs = byFolder[f.id] ?? []
          return rs.map(r => [r.id, `${r.name} · ${f.name}`] as const)
        }))
        for (const [id, label] of lists.flat()) names.set(id, label)
      } catch (e) {
        // 이름을 못 붙여도 id 로는 지울 수 있다. 다만 '못 불러왔다' 를 '삭제됐다' 로
        // 바꿔 말하지는 않는다 — 지워진 줄 알고 즐겨찾기를 정리해 버린다.
        namesLoaded = false
        setNameError(errorText(e))
      }
    }

    setGroups([
      {
        key: favReqKey, label: t('favoriteRequests'),
        hint: t('favoritePinnedHint'),
        items: favReqIds.map(id => ({ id, label: names.get(id) ?? (namesLoaded ? t('deletedRequest', { id: id.slice(0, 8) }) : t('nameUnavailable', { id: id.slice(0, 8) })) })),
      },
    ])
  }, [workspaceId, t])
  useEffect(() => { load() }, [load])

  const removeItem = (key: string, id: string) => {
    writeList(key, readList(key).filter(x => x !== id))
    setGroups(gs => gs?.map(g => g.key === key ? { ...g, items: g.items.filter(i => i.id !== id) } : g) ?? null)
  }
  // 전부 해제는 되돌릴 수 없다(서버 사본이 없다) — 그래서 이 앱의 다른 파괴적 버튼처럼
  // 한 번 더 눌러야 실행되게 하고, 무엇이 몇 개 사라지는지 그 자리에서 말한다.
  const [clearArmed, setClearArmed] = useState('')
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])
  const armClear = (key: string) => {
    setClearArmed(key)
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setClearArmed(''), 3000)
  }
  const clearGroup = (key: string, label: string, count: number) => {
    writeList(key, [])
    setGroups(gs => gs?.map(g => g.key === key ? { ...g, items: [] } : g) ?? null)
    setClearArmed('')
    toast('info', t('clearedFavorites', { name: label, count }))
  }
  const resetLayout = () => {
    for (const k of LAYOUT_KEYS) remove(k)
    toast('info', t('layoutResetToast'))
  }

  return (
    <ModalFrame embedded={embedded} label={t('displaySettings')} width="w-[min(560px,94vw)]" onClose={onClose}>
        {!embedded && (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-ui-lg font-semibold text-foreground">{t('displaySettings')}</span>
            <ToolButton icon="close" type="button" aria-label={t('close')}
              className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={onClose} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 테마.
              헤더 톱니 메뉴에 있다가 그 메뉴를 없애면서 설정 목록 맨 아래 구석으로
              밀어 넣었더니 '사라졌다' 는 말을 들었다 — 구석의 작은 토글은 없는 것과 같다.
              밝기는 표시 설정이니 여기가 제자리고, 이 칸의 맨 위에 둔다. */}
          <section className="mb-6 flex items-center justify-between gap-5 border-b border-border py-5"><div>
            <span className="ah-label">{t('theme')}</span>
            <p className="pb-2 pt-1 text-ui-meta leading-relaxed text-faint-foreground">
              {t('themeSystemHint')}
            </p>
            </div><ThemeToggle />
          </section>

          <section className="mb-6 flex items-center justify-between gap-5 border-b border-border pb-5">
            <div>
              <label className="ah-label" htmlFor="display-language">{t('language')}</label>
              <p className="pt-1 text-ui-meta leading-relaxed text-faint-foreground">{t('languageSystemHint')}</p>
            </div>
            <select id="display-language" aria-label={t('language')} value={languagePreference}
              onChange={event => setLanguagePreference(event.target.value as 'system' | 'ko' | 'en')}
              className="rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1 text-ui-sm text-foreground">
              <option value="system">{t('system')}</option>
              <option value="ko">{t('korean')}</option>
              <option value="en">{t('english')}</option>
            </select>
          </section>


          <p className="mb-3 rounded-[var(--radius-sm)] border border-border bg-surface-2/50 px-2.5 py-2 text-ui-sm leading-relaxed text-faint-foreground">
            {t('browserStoragePrefix')} <b className="text-muted-foreground">{t('browserStorageOnly')}</b> {t('browserStorageSuffix')}
          </p>

          {!groups && <p className="py-6 text-center text-ui-md text-faint-foreground">{t('loading')}</p>}

          {nameError && <LoadFailed what={t('favoriteNames')} detail={nameError} onRetry={() => void load()} />}

          {groups?.map(g => (
            <section key={g.key} className="mb-4">
              <div className="flex flex-wrap items-baseline gap-2 pb-1">
                <span className="ah-label">{g.label}</span>
                <span className="text-ui-sm text-faint-foreground">{g.items.length === 0 ? t('none') : g.items.length}</span>
                {g.items.length > 0 && (clearArmed === g.key ? (
                  <button type="button"
                    className="ml-auto rounded-[var(--radius-sm)] bg-method-delete/10 px-1.5 py-0.5 text-ui-sm font-medium text-method-delete"
                    onClick={() => clearGroup(g.key, g.label, g.items.length)}>
                    {t('clearConfirmation', { count: g.items.length })}
                  </button>
                ) : (
                  <button type="button"
                    className="ml-auto rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-faint-foreground transition-colors hover:text-method-delete"
                    onClick={() => armClear(g.key)}>{t('clearAll')}</button>
                ))}
              </div>
              {/* 비었을 때는 큰 점선 박스를 두지 않는다 — 제목 옆에서 이미 '없음' 이라 말했고,
                  빈 상자 4개가 세로로 쌓이면 정작 채워진 그룹이 어디 있는지 안 보인다.
                  설명도 항목이 있을 때만 낸다(빈 그룹에 '맨 위에 고정됩니다' 는 아직 할 말이 아니다). */}
              {g.items.length > 0 && (
                <>
                  {g.hint && <p className="pb-1.5 text-ui-meta leading-relaxed text-faint-foreground">{g.hint}</p>}
                  <ul className="flex flex-col gap-0.5">
                  {g.items.map(it => (
                    <li key={it.id} className="group flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate text-ui-md text-foreground" title={it.label}>{it.label}</span>
                      <button type="button" aria-label={t('unpinItem', { name: it.label })} title={t('unpin')}
                        className="shrink-0 rounded-[var(--radius-sm)] px-1 text-ui-sm text-faint-foreground opacity-0 transition-opacity hover:text-method-delete group-hover:opacity-100 group-focus-within:opacity-100"
                        onClick={() => removeItem(g.key, it.id)}>{t('unpin')}</button>
                    </li>
                  ))}
                  </ul>
                </>
              )}
            </section>
          ))}

          <section className="border-t border-border pt-3">
            <span className="ah-label">{t('panelLayout')}</span>
            <p className="pb-2 pt-1 text-ui-meta leading-relaxed text-faint-foreground">
              {t('panelLayoutHint')}
            </p>
            <button type="button"
              className="rounded-[var(--radius-sm)] border border-border px-2.5 py-1 text-ui-sm font-medium text-muted-foreground transition-colors hover:border-accent hover:text-accent"
              onClick={resetLayout}>{t('resetLayout')}</button>
          </section>
        </div>
    </ModalFrame>
  )
}
