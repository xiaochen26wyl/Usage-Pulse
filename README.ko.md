# Usage-Pulse

[English](README.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | **한국어**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse는 Cursor, Claude Code, Codex 사용량을 모니터링하는 크로스플랫폼 데스크톱 메뉴바 도구로, 사용량이 변하거나 부족해지거나 초기화될 때 알림을 보냅니다.

로컬에 이미 로그인된 자격 증명과 공식 사용량 데이터만 읽으며, 어떤 IDE의 자격 증명이나 설정 파일에도 다시 쓰지 않습니다.

## 스크린샷

<table>
  <tr>
    <td><img src=".github/readme-assets/screenshot-language-switcher.png" width="260"/><br/><sub>앱 내 언어는 언제든 전환 가능</sub></td>
    <td><img src=".github/readme-assets/screenshot-realtime-quota-en.png" width="260"/><br/><sub>Cursor·Claude Code·Codex 실시간 사용량</sub></td>
  </tr>
  <tr>
    <td><img src=".github/readme-assets/screenshot-realtime-quota-ko.png" width="260"/><br/><sub>같은 화면을 한국어로 표시한 모습</sub></td>
    <td><img src=".github/readme-assets/screenshot-reminder-settings.png" width="260"/><br/><sub>서비스별로 세밀하게 설정하는 리마인더</sub></td>
  </tr>
  <tr>
    <td><img src=".github/readme-assets/screenshot-line-notify.png" width="260"/><br/><sub>선택적으로 켤 수 있는 LINE 알림</sub></td>
  </tr>
</table>

## 설치

### 다운로드

최신 빌드는 [Releases 페이지](https://github.com/xiaochen26wyl/Usage-Pulse/releases)에서 받으세요.

- Apple Silicon (M1/M2/M3...): `Usage-Pulse-<version>-arm64.dmg`
- Intel Mac: `Usage-Pulse-<version>.dmg` (또는 x64로 표기된 파일)
- Windows x64: `Usage-Pulse.Setup.<version>.exe`

### 소스에서 실행하기

Usage-Pulse는 오픈소스입니다 — 저장소를 clone해서 직접 코드를 읽어보고 바로 실행할 수 있습니다.

이 저장소 상단의 **Watch**(Star만이 아니라)를 눌러두면, 새 릴리스가 나올 때마다 GitHub이 알려줍니다:

![GitHub에서 Watch 버튼 위치](.github/readme-assets/github-watch.png)

[Node.js](https://nodejs.org/) 24와 pnpm 9.15.9가 필요합니다 (`corepack enable`을 한 번 실행하면 pnpm이 자동으로 올바른 버전을 사용합니다).

```bash
git clone https://github.com/xiaochen26wyl/Usage-Pulse.git
cd Usage-Pulse
pnpm install
pnpm dev
```

`pnpm dev`는 개발 모드로 앱을 실행합니다. 메뉴바 아이콘은 설치 버전과 동일하게 작동하며, 아래 **처음 사용하기 전** 항목에 나온 로그인도 동일하게 필요합니다.

clone하면 기본적으로 `main` 브랜치를 추적하는 상태가 됩니다. 모든 릴리스는 `main`에서 태그를 붙여 배포되므로, 다시 빌드하거나 실행하기 전에 `git pull`로 새 릴리스의 변경 사항을 받아오세요.

### 서명되지 않은 빌드 경고

- macOS Gatekeeper: 처음 실행할 때 Finder에서 앱을 우클릭 -> `열기` -> 다시 한 번 `열기`를 클릭하세요.
- Windows SmartScreen: 보호 알림이 뜨면 `추가 정보` -> `실행`을 선택하세요.

### 처음 사용하기 전

- 먼저 **Cursor Desktop**에 로그인하세요 (Cursor 사용량 조회에 필요).
- **독립 실행형 Claude Code CLI**를 설치하고 먼저 로그인하세요.
- 먼저 **Codex CLI** 또는 **Codex Desktop**에 로그인하세요 (Usage-Pulse는 Codex 로그인 화면을 열지 않습니다).
- 알림 권한 요청이 뜨면 허용해 주세요.

> Usage-Pulse는 Claude Desktop 앱 내부의 (암호화된) 세션을 읽지 않습니다. 평소 Claude Desktop 앱만 사용하더라도, 공식 CLI를 통해 저장된 Claude Code 로그인이 별도로 필요합니다.

### Claude Code 자격 증명 설정

Usage-Pulse에서 **값 업데이트**를 클릭하면 자격 증명을 감지하고 사용량을 가져옵니다. Claude 카드에 표시할 수치가 없을 때는, 실행해야 할 로그인 명령어와 토큰을 직접 붙여넣을 수 있는 입력란이 담긴 패널이 그 자리에서 열립니다.

붙여넣은 토큰은 저장되기 전에 실제 사용량으로 먼저 확인됩니다. 사용량을 읽을 수 없으면 저장되지 않으며, 패널에 그 이유가 표시됩니다.

> Claude Desktop 자체의 "Plan usage limits" 패널과 수치가 다르게 보이는 이유: Usage-Pulse는 **남은** 사용량을 보여주는 반면, Claude Desktop 패널은 **사용한** 사용량을 보여줍니다. "남은 44%"와 "사용한 56%"는 같은 상태를 나타내는 것이며, 데이터 오류가 아닙니다.

## 동작 방식

1. 백그라운드에서 주기적으로 Cursor / Claude Code / Codex 사용량을 확인하고 변화가 있으면 알려줍니다.
2. 사용량 부족 알림과 초기화 알림은 설정에서 서비스별, 창별로 각각 켜고 끌 수 있습니다.
3. 알림 채널은 두 가지이며 설정에서 Cursor, Claude Code, Codex별로 각각 체크해서 선택할 수 있습니다: 앱 내 팝업 (OS 권한 불필요, 항상 동작 — 우측 상단에 표시되며 30초 후 자동으로 닫힘)과 LINE 알림 (Channel Access Token 필요).
4. 앱 내 언어 메뉴에서 번체 중국어, 영어, 일본어, 한국어를 선택할 수 있습니다.
5. UI나 트레이 메뉴에서 언제든 종료할 수 있습니다. LINE이 켜져 있으면 종료 시 마지막으로 캐시된 사용량으로 최종 상태를 전송합니다.
6. Windows 버전은 새 릴리스를 자동으로 확인하며(설정에서 켜고 끌 수 있고, 트레이 메뉴의 **업데이트 확인**으로 직접 확인할 수도 있습니다), 사용자가 확인한 뒤에만 다운로드와 설치를 진행합니다. macOS 버전은 자동 업데이트를 지원하지 않으므로 새 버전은 Releases 페이지에서 받으세요.

## 보안 관련 안내

- 읽는 항목은 모두 읽기 전용입니다: Cursor의 로컬 세션 파일, 공식 Claude Code CLI에 저장된 로그인 정보, Codex의 로컬 인증 파일.
- Usage-Pulse는 이 파일이나 자격 증명을 절대 쓰거나 수정하지 않습니다.
- 유일한 예외는 Claude Code와 Codex 카드의 「2주 이전 기록 삭제」 버튼입니다. 직접 클릭하고 확인할 때만 동작하며, 2주 넘게 업데이트되지 않은 대화만 삭제합니다(Codex에서 고정한 대화는 유지). 대화 파일은 휴지통으로 이동하고 Codex 데이터베이스의 해당 기록은 영구 삭제되므로 먼저 Codex를 완전히 종료하세요.
- 일반 설정(알림 켜기/끄기, 언어 등)은 로컬에만 저장되며 클라우드 동기화는 없습니다.

수치가 이상하거나, 발생하지 말아야 할 알림이 왔거나, 그 외 예상치 못한 동작이 보인다면 임의로 짐작하지 말고 [Discussions Q&A](https://github.com/xiaochen26wyl/Usage-Pulse/discussions/categories/q-a-%E8%A7%A3%E6%B1%BA%E5%95%8F%E9%A1%8C)에 질문을 남겨주세요.

## 라이선스 및 중요 안내

Usage-Pulse는 **기본적으로 비상업적 이용을 전제로 한 MIT 스타일 라이선스**를 사용합니다 (전체 조항은 [`LICENSE`](LICENSE) 참고). **개인 사용과 회사 내부 목적의 사용 모두 무료입니다.** 회사에 무료로 제공되는 만큼, 도입 전에 회사가 직접 보안 위험을 평가해 주세요.

**Usage-Pulse는 반드시 이 저장소의 공식 GitHub Releases 페이지에서만 다운로드하세요.** 다른 출처의 빌드는 원 개발자가 배포한 것이 아니며, 자격 증명을 어떻게 처리하는지 신뢰할 수 없습니다.

## 지원하기

Usage-Pulse가 도움이 되었다면 GitHub에서 프로젝트에 별표 ⭐를 눌러주세요 — 무료이고 빠르며, 큰 힘이 됩니다. [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl)를 통해 후원할 수도 있습니다.

## 개발자 팔로우하기

- Instagram (English): [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- Threads (中文): [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)

W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (상업적 라이선스 및 매입 문의)
