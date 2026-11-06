# 접속 보호 — 혼자 쓸 때와 팀으로 쓸 때

postq 에는 **로그인이 없다.** 이 앱에 닿는 사람은 누구나 모든 기능을 쓴다 — 요청을 만들고 고치고 지우고,
환경의 비밀값을 넣은 채로 요청을 실행하고, 이력을 본다. 개인용 도구라 일부러 이렇게 두었다.

그래서 기본값은 **이 컴퓨터 안에서만 닿게** 되어 있다.

| 띄우는 방법 | 기본으로 받는 주소 |
|---|---|
| `postq-server` 단독 | `POSTQ_HOST` 가 없으면 `127.0.0.1` |
| `npm run dev` | Rust API·화면(next dev) 둘 다 `127.0.0.1` |
| `docker compose up` | 컨테이너 안은 `0.0.0.0`, 호스트에는 `127.0.0.1:3000` 만 연다 (`ports: "127.0.0.1:3000:3000"`) |
| 데스크톱 앱(Tauri) | 언제나 `127.0.0.1` |

## 바깥에 열면 무엇이 위험한가

`POSTQ_HOST=0.0.0.0` 이나 도커의 `-p 3000:3000` 처럼 루프백 밖에 열면(서버가 기동할 때 경고를 찍는다), 그 주소에
닿는 사람은 아래를 모두 할 수 있다.

- **저장된 비밀값을 쓴다.** 환경 변수의 secret, 요청·폴더의 인증값(Bearer·Basic·OAuth 비밀), 쿠키 저장소의
  세션 쿠키가 실행할 때 서버에서 채워진다. 값을 화면으로 내려보내지는 않지만, 그 값으로 대상 API 를 부를 수 있다.
- **서버를 거쳐 요청을 보낸다.** 실행은 서버가 대신 보낸다(프록시). 열린 서버는 그 서버가 닿는 내부망 주소로
  요청을 보내는 발판이 된다. 사설망 주소 차단(`BLOCK_PRIVATE_NETWORKS=1`)은 기본이 꺼져 있다.
- **데이터를 바꾸거나 지운다.** 요청·시나리오·스케줄·환경을 고치고 지울 수 있다. 스케줄은 서버가 혼자 돌린다.
- **MCP 도구를 부른다.** `/api/mcp/mcp` 로 Claude 같은 클라이언트를 붙여 같은 일을 시킬 수 있다.

앱은 이름을 묻지 않는다. 외부 API가 전달한 실행자·수정자 정보는 호환용 메타데이터이며 신원을 증명하지 않는다.

**혼자 쓰면 루프백에서 바꾸지 말 것.** 다른 기기에서 써야 하면 SSH 터널(`ssh -L 3000:127.0.0.1:3000 <서버>`)이나
VPN 안에서 루프백 그대로 쓰는 편이 가장 간단하고 안전하다.

## 팀으로 쓰려면 — 앞단 프록시로 SSO 를 붙인다

여러 사람이 한 서버를 써야 하면 postq 앞에 **인증 프록시**를 두고, postq 자체는 그 프록시에서만 닿게 한다.
postq 는 프록시가 무엇을 하든 상관하지 않는다 — 들어온 요청은 모두 통과시킨다. 그러니 **프록시를 거치지 않는
길이 없어야 한다**(postq 의 포트를 바깥에 직접 열지 않는다).

```
브라우저 ──HTTPS──▶ 인증 프록시 (oauth2-proxy · Pomerium · Cloudflare Access · Tailscale 등)
                     │ 로그인 안 했으면 IdP(Google·GitHub·Okta·Keycloak 등)로 보낸다
                     ▼
                   postq :3000   ← 프록시만 닿는 주소(같은 도커 네트워크, 127.0.0.1 등)
```

### 예: oauth2-proxy + 도커 compose

> 아래는 뼈대이며 이 저장소에서 돌려 보지 않았다. IdP 설정(클라이언트 ID·비밀·허용할 이메일 도메인)과 TLS 는
> 쓰는 환경에 맞춰 채우고, 각 옵션은 oauth2-proxy 공식 문서로 확인한다. `!reset` 은 docker compose 2.24 이상에서 된다.

```yaml
# docker-compose.sso.yml — docker compose -f docker-compose.yml -f docker-compose.sso.yml up -d
services:
  postq:
    ports: !reset []            # postq 는 호스트에 열지 않는다 — 프록시만 내부 네트워크로 닿는다
    environment:
      # postq 는 루프백이 아닌 Host 를 거절한다(DNS 리바인딩 방지). 프록시가 넘기는 Host(공개 도메인)를 적는다.
      POSTQ_ALLOWED_HOSTS: postq.example.com
  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
    ports:
      - "4180:4180"             # 앞에 TLS 를 끝내는 리버스 프록시(Caddy·nginx 등)를 두는 것을 권한다
    environment:
      OAUTH2_PROXY_HTTP_ADDRESS: 0.0.0.0:4180
      OAUTH2_PROXY_UPSTREAMS: http://postq:3000/
      OAUTH2_PROXY_PROVIDER: google             # github · oidc 등
      OAUTH2_PROXY_CLIENT_ID: ${OAUTH2_CLIENT_ID}
      OAUTH2_PROXY_CLIENT_SECRET: ${OAUTH2_CLIENT_SECRET}
      OAUTH2_PROXY_COOKIE_SECRET: ${OAUTH2_COOKIE_SECRET}
      OAUTH2_PROXY_EMAIL_DOMAINS: example.com
      OAUTH2_PROXY_REDIRECT_URL: https://postq.example.com/oauth2/callback
      OAUTH2_PROXY_COOKIE_SECURE: "true"
      OAUTH2_PROXY_REVERSE_PROXY: "true"
      OAUTH2_PROXY_SKIP_AUTH_ROUTES: ^/api/health$   # 헬스체크만 로그인 없이
```

**`POSTQ_ALLOWED_HOSTS`** — postq 는 요청의 `Host` 가 루프백 이름(`localhost`·`127.0.0.1`·`::1`)이거나 이 목록(쉼표로
나눈 호스트 이름, 포트 없이)에 있을 때만 받는다. `/api` 는 브라우저가 보낸 `Origin` 이 요청한 주소(호스트·포트)와 정확히 같아야 한다. 프록시
뒤에 두거나 LAN 주소로 열면 그 이름을 적어야 화면이 403 없이 뜬다.
HTTPS 를 끝내는 프록시는 `X-Forwarded-Proto: https` 를 넘겨야 한다(Caddy·nginx 의 일반 설정). 안 넘기면 화면의 `/api` 요청이
다른 출처로 보여 403 이 난다.

프록시를 붙여도 남는 것:

- **사람마다 권한을 나누지 않는다.** 프록시를 통과한 사람은 모두 같은 권한이다. 누구는 보기만 하게 하려면
  프록시 쪽에서 들어올 수 있는 사람 자체를 좁힌다.
- **프록시 사용자의 신원을 기록하지 않는다.** postq 는 프록시가 넘기는 사용자 헤더(`X-Forwarded-Email` 등)를 읽지 않는다.
- **대상 API 의 비밀값은 팀이 같이 쓴다.** 환경에 넣은 secret 은 서버에 하나뿐이다. 각자 다른 값을 쓰려면
  환경 화면의 개인 값(내 브라우저에만 저장)을 쓴다.
- **데이터 볼륨에 모든 것이 있다.** `SECRET_ENCRYPTION_KEY` 를 정하면 비밀값은 암호화해 저장한다. 키와 DB 백업
  (`scripts/backup.sh`)을 따로 보관한다.

### 헤드리스 MCP 클라이언트 — `MCP_TOKEN`

`claude mcp add --transport http …` 같은 헤드리스 클라이언트는 프록시의 브라우저 로그인을 거칠 수 없다.
이때는 프록시가 **`/api/mcp/` 아래만** 로그인 없이 넘기게 하고, postq 에 `MCP_TOKEN` 을 정한다.

- `MCP_TOKEN` 을 정하면 `/api/mcp/*` 는 `Authorization: Bearer <MCP_TOKEN>` 이 정확히 맞을 때만 받는다(아니면 401).
  정하지 않으면 검사하지 않는다.
- 다른 `/api` 경로는 이 토큰으로 막지 않는다. 그래서 프록시에서 건너뛰게 하는 경로는 `^/api/mcp/` 로 좁힌다.
- [설정 → Claude 에서 쓰기] 의 연결 명령은 토큰을 정한 서버면 `<MCP_TOKEN 값>` 자리표시자를 넣는다. 화면은 토큰 값을
  받지 않는다(`/api/mcp-info` 는 토큰을 정했는지만 알려 준다).

```yaml
services:
  postq:
    environment:
      MCP_TOKEN: ${MCP_TOKEN}   # openssl rand -hex 32
  oauth2-proxy:
    environment:
      OAUTH2_PROXY_SKIP_AUTH_ROUTES: ^/api/health$,^/api/mcp/
```

`MCP_TOKEN` 만 정하고 프록시 없이 바깥에 여는 것은 보호가 아니다 — 나머지 `/api` 가 그대로 열려 있다.

### CI 에서 시나리오 돌리기

`scripts/run-scenario.mjs`·`scripts/run-collection.mjs` 는 `POSTQ_URL` 로 바로 요청하고 인증 헤더를 붙이지 않는다.
프록시 뒤의 서버라면 CI 러너를 프록시 안쪽(같은 네트워크·VPN)에 두고 postq 주소를 직접 가리키게 한다.
그 주소의 호스트 이름(예: `postq`)도 `POSTQ_ALLOWED_HOSTS` 에 넣는다.
