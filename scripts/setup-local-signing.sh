#!/bin/sh
# 데스크톱 앱용 로컬 서명 인증서를 로그인 키체인에 한 번 만든다(이 맥에서만 쓰는 자체 서명).
#
# 왜: 서명 없이(ad-hoc) 빌드하면 빌드마다 서명 신원이 바뀐다. macOS 는 '데스크탑 폴더 접근' 허락을 그 신원에
# 묶어 두므로, 앱을 새로 빌드·설치할 때마다 허락을 다시 묻고 그동안 서버가 멈춘다.
# 같은 인증서로 서명하면 신원이 고정돼 한 번 허락하면 끝이다. npm run app:build 가 이 인증서가 있으면 알아서 쓴다.
set -eu
NAME="postq local signing"
if security find-identity -p codesigning | grep -q "$NAME"; then
  echo "이미 있습니다: $NAME"; exit 0
fi
DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -days 3650 \
  -subj "/CN=$NAME" -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" -addext "basicConstraints=critical,CA:false" 2>/dev/null
PW=$(openssl rand -hex 12)
openssl pkcs12 -export -legacy -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name "$NAME" -out "$DIR/id.p12" -passout "pass:$PW"
security import "$DIR/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PW" -T /usr/bin/codesign
security find-identity -p codesigning | grep "$NAME"
echo "완료 — 이제 npm run app:build 가 이 인증서로 서명합니다."
