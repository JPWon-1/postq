# postq branding

사용자가 선택한 후보 A(종이비행기를 던지며 도약하는 쿼카)를 정식 앱 아이콘으로 사용합니다.

## 파일과 사용처

- `postq-icon-1024.png`: 1024×1024 RGBA. A 기반이며 둥근 사각 바깥은 완전 투명합니다.
- `postq-mark.png`: 1024×1024 RGBA. A의 황갈색 얼굴·통통한 볼·미소를 굵은 윤곽과 단순한 색면으로 재해석한 투명 마크입니다.
- `postq-mark-{16,32,48}.png`: 작은 크기용 마크 축소본.
- `social-preview.png`: 1280×640 GitHub 소셜 미리보기.
- `candidates/`: 선택 전 원본 보존. A 생성 프롬프트는 [PROMPTS.md](candidates/PROMPTS.md)의 A 항목입니다.

이전 수작업 SVG는 제거했습니다. 새 원본은 래스터 PNG입니다.

## 제작 방법

A와 작은 마크 모두 내장 `image_gen.imagegen`으로 생성했습니다. 마크는 A PNG를 참조했습니다. Sharp로 크기를 변환하고, 정식 A에 1024px 기준 (16,16)–(1008,1008), 반경 220px의 둥근 사각 알파 마스크를 적용해 가장자리 잔여 픽셀을 정리했습니다. 후보 원본은 변경하지 않았습니다.

데스크톱 파일은 `npx tauri icon branding/postq-icon-1024.png --output branding/.tauri-generated`로 생성한 뒤 Tauri 설정이 참조하는 5개만 복사했습니다. 32x32.png는 마크로 교체했습니다. ICO·ICNS는 A 기반 멀티 해상도입니다. 임시 생성 폴더는 제거했습니다.

웹 favicon.ico에는 16·32·48px 마크 PNG 프레임이 들어 있습니다. icon.png는 마크, apple-icon.png는 180px A입니다. 확장 아이콘은 16·32·48px 마크와 128px A입니다.

`node scripts/render-social-preview.mjs`로 소셜 미리보기를 다시 만듭니다. 글자는 SVG 텍스트(Helvetica/Arial)를 Sharp로 직접 렌더링했습니다. 문구는 `postq`, `A lightweight, local-first API client`입니다.

### 마크 생성 프롬프트

> Create one 1024x1024 transparent-background app favicon mascot mark derived from the supplied quokka reference A. Preserve its warm caramel golden-brown color, rounded small ears, plump cheeks, tiny dark nose, sparkling dark eyes and big happy smile, slightly three-quarter tilted head. HEAD ONLY, large face fills canvas with comfortable 6% transparent margin. Simplify the reference into bold smooth solid shapes, dark brown thick clean contours, pale honey rounded muzzle, two bright eye highlights, simple open smiling mouth. Premium friendly modern flat illustration with only two-tone gentle cel shading. No individual hairs, no furry texture, no body, no airplane, no tile, no background, no lettering. Must read clearly at 16px and 32px, recognizable same happy quokka personality as reference. Actual alpha transparent background, no checkerboard. Original mascot.

## 후속 작업

src/components의 BrandMark, 루트 README 로고 및 스크린샷 교체는 병행 UI 작업이 끝난 뒤 별도로 반영합니다. GitHub 소셜 미리보기는 저장소 설정에 social-preview.png를 업로드해야 합니다.

## 라이선스

저장소와 동일한 [MIT License](../LICENSE).
Copyright (c) 2026 postq contributors.
