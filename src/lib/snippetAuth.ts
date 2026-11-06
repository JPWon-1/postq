import { oauthFields, type SnippetAuth } from './snippetRequest'

const q = (s: string) => JSON.stringify(s)
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

/** Basic은 참조를 치환한 뒤 인코딩해야 한다. {{password}}를 미리 base64로 숨기지 않는다. */
export function jsAuth(auth: SnippetAuth): { prefix: string[]; value?: string } {
  if (!auth) return { prefix: [] }
  if (auth.type === 'basic') return { prefix: [], value: `'Basic ' + Buffer.from(${q(auth.username + ':' + auth.password)}, 'utf8').toString('base64')` }
  const fields = oauthFields(auth)
  const headers = auth.clientAuth === 'basic' ? `{ 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(${q(auth.clientId + ':' + auth.clientSecret)}, 'utf8').toString('base64') }` : "{ 'Content-Type': 'application/x-www-form-urlencoded' }"
  return { prefix: [
    `const tokenResponse = await fetch(${q(auth.tokenUrl)}, {`,
    "  method: 'POST', redirect: 'manual',",
    `  headers: ${headers},`,
    `  body: new URLSearchParams(${JSON.stringify(fields)}),`,
    '})', "if (!tokenResponse.ok) throw new Error('OAuth token request failed')",
    'const tokenData = await tokenResponse.json()', "if (!tokenData.access_token) throw new Error('OAuth access_token missing')", '',
  ], value: "'Bearer ' + tokenData.access_token" }
}
export function pythonAuth(auth: SnippetAuth): { prefix: string[]; value?: string } {
  if (!auth) return { prefix: [] }
  if (auth.type === 'basic') return { prefix: ['import base64'], value: `"Basic " + base64.b64encode(${q(auth.username + ':' + auth.password)}.encode("utf-8")).decode("ascii")` }
  return { prefix: [
    'import requests',
    `token_response = requests.post(${q(auth.tokenUrl)},`,
    `    data=${JSON.stringify(oauthFields(auth))},`,
    ...(auth.clientAuth === 'basic' ? [`    auth=(${q(auth.clientId)}, ${q(auth.clientSecret)}),`] : []),
    '    allow_redirects=False)', 'token_response.raise_for_status()', 'token_data = token_response.json()', '',
  ], value: '"Bearer " + token_data["access_token"]' }
}
export function curlAuth(auth: SnippetAuth): { prefix: string[]; args: string[] } {
  if (!auth) return { prefix: [], args: [] }
  if (auth.type === 'basic') return { prefix: [], args: [`  --user ${sq(auth.username + ':' + auth.password)}`] }
  const token = [
    `curl --fail-with-body -sS -X POST ${sq(auth.tokenUrl)}`,
    `-H 'Content-Type: application/x-www-form-urlencoded'`,
    ...(auth.clientAuth === 'basic' ? [`--user ${sq(auth.clientId + ':' + auth.clientSecret)}`] : []),
    ...Object.entries(oauthFields(auth)).map(([key, value]) => `--data-urlencode ${sq(key + '=' + value)}`),
  ].join(' ')
  return { prefix: [`access_token=$(${token} | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')`, ''], args: ['  -H "Authorization: Bearer $access_token"'] }
}
