'use client'
import { t as i18nText } from '@/i18n'
import { AUTH_LABEL, type AuthConfig, type AuthType } from '@/lib/requestAuth'

function AuthField({ label, placeholder, value, onChange }: { label: string; placeholder?: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 ah-label">
      {label}
      <input
        aria-label={label}
        className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-md font-normal normal-case tracking-normal text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}

// 요청은 '상속' 가능, 폴더 공통 인증은 상속 불가(부모가 없음).
const REQUEST_TYPES: AuthType[] = ['none', 'inherit', 'bearer', 'basic', 'apikey', 'oauth2cc']
const FOLDER_TYPES: AuthType[] = ['none', 'bearer', 'basic', 'apikey', 'oauth2cc']

/**
 * 인증 편집기 — 요청 인증 탭과 폴더 공통 인증 편집기가 공유한다.
 * 판별 유니온의 콜백 내 내로잉 문제를 피해 값은 느슨한 레코드로 읽고, 타입 변경 시엔 필드를 재구성한다.
 */
export function AuthEditor({ value, onChange, allowInherit = false, footer }: {
  value: AuthConfig
  onChange: (a: AuthConfig) => void
  /** 요청 편집기는 true(상속 옵션 노출), 폴더 편집기는 false. */
  allowInherit?: boolean
  footer?: React.ReactNode
}) {
  const val = (k: string): string => (value as unknown as Record<string, string>)[k] ?? ''
  const setField = (k: string, v: string) => onChange({ ...value, [k]: v } as AuthConfig)
  const types = allowInherit ? REQUEST_TYPES : FOLDER_TYPES
  const credential = value.type === 'bearer' || value.type === 'basic' || value.type === 'apikey' || value.type === 'oauth2cc'

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">
        {i18nText('uiAuthenticationMethod')}
        <select
          aria-label={i18nText('uiAuthenticationMethod')}
          className="ah-input font-normal normal-case tracking-normal"
          value={value.type}
          onChange={e => {
            const t = e.target.value as AuthType
            onChange(
              t === 'bearer' ? { type: 'bearer', token: val('token') }
                : t === 'basic' ? { type: 'basic', username: val('username'), password: val('password') }
                  : t === 'apikey' ? { type: 'apikey', key: val('key') || 'X-Api-Key', value: val('value'), in: (val('in') as 'header' | 'query') || 'header' }
                    : t === 'oauth2cc' ? { type: 'oauth2cc', tokenUrl: val('tokenUrl'), clientId: val('clientId'), clientSecret: val('clientSecret'), scope: val('scope'), clientAuth: (val('clientAuth') as 'body' | 'basic') || 'body' }
                      : t === 'inherit' ? { type: 'inherit' }
                        : { type: 'none' },
            )
          }}
        >
          {types.map(t => <option key={t} value={t}>{AUTH_LABEL[t]}</option>)}
        </select>
      </label>

      {value.type === 'none' && (
        <p className="text-ui-md leading-relaxed text-faint-foreground">{i18nText('uiNoAuthorizationIfNecessaryYouCanEnterAuthorizationDirectly')}</p>
      )}
      {value.type === 'inherit' && (
        <p className="text-ui-md leading-relaxed text-faint-foreground">{i18nText('uiUseTheCommonAuthenticationSetUpForTheFolder')}</p>
      )}
      {value.type === 'bearer' && (
        <AuthField label={i18nText('uiToken')} placeholder={i18nText('uiEnterTokenOrValueDirectlyIfLeftBlankThe')} value={val('token')} onChange={v => setField('token', v)} />
      )}
      {value.type === 'basic' && (<>
        <AuthField label={i18nText('uiUsername')} placeholder={i18nText('uiUserOrUser')} value={val('username')} onChange={v => setField('username', v)} />
        <AuthField label={i18nText('uiPassword')} placeholder={i18nText('uiPasswordIfLeftBlankTheSavedValueIsMaintained')} value={val('password')} onChange={v => setField('password', v)} />
      </>)}
      {value.type === 'apikey' && (<>
        <AuthField label={i18nText('uiKeyName')} placeholder="X-Api-Key" value={val('key')} onChange={v => setField('key', v)} />
        <AuthField label={i18nText('uiValue')} placeholder={i18nText('uiApiKeyOrEnterTheValueDirectlyIfLeftBlank')} value={val('value')} onChange={v => setField('value', v)} />
        <label className="flex flex-col gap-1 ah-label">
          {i18nText('uiLocation')}
          <select aria-label={i18nText('uiLocation')} className="w-40 ah-input font-normal normal-case tracking-normal"
            value={val('in') || 'header'} onChange={e => setField('in', e.target.value)}>
            <option value="header">{i18nText('uiHeader')}</option>
            <option value="query">{i18nText('uiQueryParameters')}</option>
          </select>
        </label>
      </>)}
      {value.type === 'oauth2cc' && (<>
        <AuthField label={i18nText('uiTokenURL')} placeholder="https://idp/oauth/token" value={val('tokenUrl')} onChange={v => setField('tokenUrl', v)} />
        <AuthField label="Client ID" placeholder="{{clientId}}" value={val('clientId')} onChange={v => setField('clientId', v)} />
        <AuthField label="Client Secret" placeholder={i18nText('uiClientSecretIfLeftBlankTheStoredValueIsRetained')} value={val('clientSecret')} onChange={v => setField('clientSecret', v)} />
        <AuthField label={i18nText('uiScopeOptional')} placeholder="read write" value={val('scope')} onChange={v => setField('scope', v)} />
        <label className="flex flex-col gap-1 ah-label">
          {i18nText('uiPassingClientAuthentication')}
          <select aria-label={i18nText('uiPassingClientAuthentication')} className="w-40 ah-input font-normal normal-case tracking-normal"
            value={val('clientAuth') || 'body'} onChange={e => setField('clientAuth', e.target.value)}>
            <option value="body">{i18nText('uiBodyClientIdSecret')}</option>
            <option value="basic">{i18nText('uiBasicHeader')}</option>
          </select>
        </label>
        <p className="text-ui-sm leading-relaxed text-faint-foreground">{i18nText('uiTokenURLWhenRunning')} <code className="font-mono">client_credentials</code> {i18nText('uiIssuedInjectedIntoBearerTokensAreCachedOnThe')}</p>
      </>)}

      {credential && (
        <p className="text-ui-sm leading-relaxed text-faint-foreground">
          {i18nText('uiForAllValues')} {i18nText('variablePlaceholder')} {i18nText('uiAvailableWhenExecutedItIsInjectedAsTheAuthorization')}
        </p>
      )}
      {footer}
    </div>
  )
}
