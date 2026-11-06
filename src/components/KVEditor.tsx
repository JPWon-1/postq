'use client'
import { t as i18nText } from '@/i18n'
import { useId } from 'react'
import { applyKVEdit, shouldShowPhantom } from '@/lib/kvRows'
import { ValueHover } from './ValueHover'
import type { KV } from '@/lib/variables'

// KV 편집기 제안 목록 — datalist 로 붙어서 "드롭다운 선택 + 자유 입력"이 동시에 된다.
// keys: Key 입력칸 제안. values: 소문자 키 → 그 키일 때 Value 입력칸 제안.
export type KVSuggest = {
  keys?: string[]
  values?: Record<string, string[]>
}


// Postman 스타일: 마지막 행이 채워지면 다음 입력을 위한 빈 행이 자동으로 따라온다 —
// "행 추가" 버튼을 눌러야 하는 마찰을 없앤다. phantom 행 커밋 규칙은 lib/kvRows.ts 참고.
export function KVEditor({ items, onChange, readOnly = false, suggest, inherited = [] }: {
  items: KV[]; onChange: (next: KV[]) => void; readOnly?: boolean; suggest?: KVSuggest
  /**
   * 폴더에서 물려받는 항목 — 같은 표 안에 회색 줄로 먼저 보여준다.
   *
   * 예전엔 표 아래 점선 상자에 따로 있었다. 그러면 '실제로 나갈 헤더' 를 알려면 두 목록을
   * 머리로 합쳐야 하고, 요청에 같은 키를 적었을 때 어느 쪽이 이기는지도 눈으로 안 보인다.
   * 한 표에 두면 위에서 아래로 읽는 것만으로 답이 나온다.
   */
  inherited?: KV[]
}) {
  const listId = useId()
  const keyListId = suggest?.keys?.length ? `${listId}-keys` : undefined
  // 값 제안은 행의 현재 key 에 따라 달라진다 (대소문자 무시 매칭)
  const valueOptionsFor = (key: string): string[] =>
    suggest?.values?.[key.trim().toLowerCase()] ?? []

  const showPhantom = !readOnly && shouldShowPhantom(items)
  const rows = showPhantom ? [...items, { key: '', value: '', enabled: true }] : items

  const set = (i: number, patch: Partial<KV>) => onChange(applyKVEdit(items, i, patch))

  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i))

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)]">
      {keyListId && (
        <datalist id={keyListId}>
          {suggest!.keys!.map(k => <option key={k} value={k} />)}
        </datalist>
      )}
      <table className="w-full table-fixed border-collapse text-ui-lg">
        <thead>
          <tr className="border-b border-border bg-surface-2/30 text-left">
            <th className="w-14 py-1.5 pl-2.5" aria-hidden />
            {/* 너비를 안 정하면 셋이 똑같이 나뉜다 — 1600px 창에서 각 360px 이 되어
                'orderId' 한 낱말이 360px 칸 왼쪽 끝에 붙고, 한 행이 멀리 떨어진 세 덩어리로
                읽힌다. 값이 제일 길고 설명은 대개 비어 있으니 그 비율로 준다. */}
            <th className="w-[28%] py-1.5 pl-2.5 text-ui-sm font-semibold text-faint-foreground">{i18nText('uiKey')}</th>
            <th className="w-[44%] py-1.5 pl-2.5 text-ui-sm font-semibold text-faint-foreground">{i18nText('uiValue')}</th>
            <th className="w-[28%] py-1.5 pl-2.5 text-ui-sm font-semibold text-faint-foreground">{i18nText('uiDescription')}</th>
            <th className="w-14" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {/* 물려받은 것부터. 여기서 고칠 수 없으니 입력칸이 아니라 글자로 낸다 —
              고칠 수 있는 것처럼 보이면 눌러 보고 나서야 아니라는 걸 안다. */}
          {inherited.filter(h => h.enabled && h.key.trim()).map((h, i) => {
            const overridden = items.some(x => x.enabled && x.key.trim().toLowerCase() === h.key.trim().toLowerCase())
            return (
              <tr key={`inh-${i}`} className="border-b border-border/70 bg-surface-2/30">
                <td className="py-1 pl-2.5 text-center" title={i18nText('uiItemsInheritedFromFolder')}>
                  <span className="text-ui-meta text-faint-foreground">↳</span>
                </td>
                <td className={`py-1.5 pl-2.5 font-mono text-ui-md ${overridden ? 'text-faint-foreground line-through' : 'text-muted-foreground'}`}>
                  {h.key}
                </td>
                <td className={`py-1.5 pl-2.5 font-mono text-ui-md ${overridden ? 'text-faint-foreground line-through' : 'text-muted-foreground'}`}>
                  {h.value}
                </td>
                <td className="py-1.5 pl-2.5 text-ui-sm text-faint-foreground">
                  {overridden ? i18nText('jsxReplacedByRequestedValue') : i18nText('jsxFolderCommon')}
                </td>
                <td aria-hidden />
              </tr>
            )
          })}
          {rows.length === 0 && inherited.length === 0 && (
            <tr>
              <td colSpan={5} className="px-2.5 py-4 text-center text-ui-md text-faint-foreground">
                {i18nText('uiThereAreNoItems')}
              </td>
            </tr>
          )}
          {rows.map((it, i) => {
            const isPhantom = i >= items.length
            return (
              <tr key={i} className={`border-b border-border/50 last:border-b-0 hover:bg-surface-2/30 focus-within:bg-surface-2/30 ${!it.enabled ? 'opacity-45' : ''}`}>
                <td className="py-1 pl-2.5">
                  <input
                    type="checkbox"
                    aria-label={it.key ? i18nText('dynamicActivated', { v0: String(it.key) }) : i18nText('jsxActivateItem')}
                    checked={it.enabled}
                    disabled={readOnly}
                    onChange={e => set(i, { enabled: e.target.checked })}
                    className="h-4 w-4 accent-accent cursor-pointer"
                  />
                </td>
                <td className="py-1 pl-1 pr-1">
                  <input
                    className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none placeholder:text-faint-foreground/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed"
                    aria-label={i18nText('dynamicKey', { v0: String(i + 1) })}
                    value={it.key}
                    disabled={readOnly}
                    placeholder={isPhantom ? i18nText('jsxNewKey') : 'key'}
                    list={keyListId}
                    onChange={e => set(i, { key: e.target.value })}
                  />
                </td>
                <td className="py-1 pl-1 pr-1">
                  {valueOptionsFor(it.key).length > 0 && (
                    <datalist id={`${listId}-v${i}`}>
                      {valueOptionsFor(it.key).map(v => <option key={v} value={v} />)}
                    </datalist>
                  )}
                  {/* 긴 값은 칸에서 잘린다 — 마우스를 올리면 전체를 낸다(환경 변수 표와 같은 방식) */}
                  <ValueHover aria-label={i18nText('dynamicValue2', { v0: String(i + 1) })}
                      value={it.value}>
                    <input
                      className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none placeholder:text-faint-foreground/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed"
                      aria-label={i18nText('dynamicValue2', { v0: String(i + 1) })}
                      value={it.value}
                      disabled={readOnly}
                      placeholder="value"
                      list={valueOptionsFor(it.key).length > 0 ? `${listId}-v${i}` : undefined}
                      onChange={e => set(i, { value: e.target.value })}
                    />
                  </ValueHover>
                </td>
                <td className="py-1 pl-1 pr-1">
                  <input
                    className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 text-ui-md text-muted-foreground outline-none placeholder:text-faint-foreground/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed"
                    aria-label={i18nText('dynamicDescription', { v0: String(i + 1) })}
                    value={it.description ?? ''}
                    disabled={readOnly}
                    placeholder={i18nText('uiDescriptionOptional')}
                    onChange={e => set(i, { description: e.target.value })}
                  />
                </td>
                <td className="pr-2 text-center">
                  {!readOnly && !isPhantom && (
                    <button
                      type="button"
                      aria-label={it.key ? i18nText('dynamicDeleteRow', { v0: String(it.key) }) : i18nText('jsxDeleteRow')}
                      className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      onClick={() => remove(i)}
                    >{i18nText('uiDelete')}</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
