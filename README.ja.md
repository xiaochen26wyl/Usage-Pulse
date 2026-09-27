# Usage-Pulse

[English](README.md) | [繁體中文](README.zh-TW.md) | **日本語** | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse は、Cursor・Claude Code・Codex の利用枠を監視するクロスプラットフォーム対応のデスクトップメニューバーツールです。利用枠の変化・残量低下・リセットのタイミングで通知を送ります。

読み取るのはローカルにすでにログイン済みの認証情報と公式の利用状況データのみで、いずれの IDE の認証情報や設定ファイルにも書き戻すことはありません。

## インストール

### ダウンロード

最新版は [Releases ページ](https://github.com/xiaochen26wyl/Usage-Pulse/releases) から入手してください。

- Apple Silicon（M1/M2/M3...）: `Usage-Pulse-<version>-arm64.dmg`
- Intel Mac: `Usage-Pulse-<version>.dmg`（または x64 表記のファイル）
- Windows x64: `Usage-Pulse.Setup.<version>.exe`

### ソースから実行

Usage-Pulse はオープンソースです。リポジトリを clone してコードを読み、そのまま実行できます。

[Node.js](https://nodejs.org/) 24 と pnpm 9.15.9 が必要です（`corepack enable` を一度実行すれば、pnpm が自動的に正しいバージョンを使用します）。

```bash
git clone https://github.com/xiaochen26wyl/Usage-Pulse.git
cd Usage-Pulse
pnpm install
pnpm dev
```

`pnpm dev` は開発モードでアプリを起動します。メニューバーアイコンはインストール版と同じ動作をし、**初回利用前の準備**に記載したログインも同様に必要です。

clone した時点で `main` ブランチを追跡する状態になっています。各リリースは `main` からタグを切って公開されるため、再ビルド・再実行する前に `git pull` して新しいリリースの変更を取り込んでください。

### 未署名ビルドに関する警告

- macOS Gatekeeper: 初回起動時、Finder でアプリを右クリック -> `開く` -> もう一度 `開く` をクリックしてください。
- Windows SmartScreen: 保護のプロンプトが表示されたら `詳細情報` -> `実行` を選んでください。

### 初回利用前の準備

- 先に **Cursor Desktop** にログインしてください（Cursor の利用枠取得に必要）。
- **スタンドアロン版 Claude Code CLI** をインストールし、先にログインしてください。
- 先に **Codex CLI** または **Codex Desktop** にログインしてください（Usage-Pulse は Codex のログイン画面を開きません）。
- プロンプトが表示されたらシステム通知の権限を許可してください。

> Usage-Pulse は Claude Desktop アプリ内部の（暗号化された）セッションを読み取りません。普段 Claude Desktop アプリしか使っていない場合でも、公式 CLI 経由で保存された Claude Code のログインが別途必要です。

### Claude Code の認証情報設定

Usage-Pulse で **「更新する」** をクリックすると、認証情報を検出して利用状況を取得します。Claude のカードに表示する数値がない場合は、実行すべきログインコマンドと、代わりにトークンを貼り付けられる入力欄を含むパネルがその場で開きます。

貼り付けたトークンは、保存する前に実際の利用状況に対して検証されます。取得できない場合は保存されず、理由がパネルに表示されます。

> Claude Desktop 自体の「Plan usage limits」パネルと数値が異なって見える理由：Usage-Pulse は**残り**の利用枠を表示するのに対し、Claude Desktop のパネルは**使用済み**の利用枠を表示します。「残り 44%」と「使用済み 56%」は同じ状態を指しており、データの誤りではありません。

## 機能

1. バックグラウンドで定期的に Cursor / Claude Code / Codex の利用枠を確認し、変化があれば通知します。
2. 低残量通知とリセット通知は、サービスごと・ウィンドウごとに設定画面で個別に切り替えられます。
3. 通知チャンネルは 2 種類あり、それぞれ設定画面で個別に切り替えられます：アプリ内ポップアップ（OS の権限不要で常に動作 — 右上に表示され 30 秒後に自動で閉じます）と LINE 通知（Channel Access Token が必要）。
4. アプリ内の言語メニューから、繁體中文・英語・日本語・韓国語を選択できます。
5. UI またはトレイメニューからいつでも終了できます。LINE 通知が有効な場合、終了時に最後にキャッシュされた利用状況を送信します。

## セキュリティに関する注意事項

- 読み取るのはすべて読み取り専用です：Cursor のローカルセッションファイル、公式 Claude Code CLI に保存されたログイン情報、Codex のローカル認証ファイル。
- Usage-Pulse はこれらのファイルや認証情報に書き込み・変更を一切行いません。
- 一般設定（通知の切り替え、言語など）はローカルにのみ保存され、クラウド同期は行われません。

数値がおかしい、発生するはずのない通知が来た、その他予期しない挙動があった場合は、自己判断せずに [Discussions Q&A](https://github.com/xiaochen26wyl/Usage-Pulse/discussions/categories/q-a-%E8%A7%A3%E6%B1%BA%E5%95%8F%E9%A1%8C) で質問してください。

## ライセンスと重要なお知らせ

Usage-Pulse は **非商用利用をデフォルトとした MIT 風ライセンス** を採用しています（正式な条項は [`LICENSE`](LICENSE) を参照）。**個人利用と、企業内部での自社利用はいずれも無償です。** 企業向けに無償提供しているため、導入前に自社でセキュリティリスクを評価してください。

**Usage-Pulse は必ず本リポジトリの公式 GitHub Releases ページからダウンロードしてください。** それ以外の配布元のビルドは開発者本人が公開したものではなく、認証情報の扱いを保証できません。

## サポート

Usage-Pulse が役に立ったと感じたら、GitHub でこのプロジェクトにスターを付けていただけると嬉しいです ⭐ — 無料ですぐにでき、大変励みになります。[GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl) からの支援も歓迎します。

## 開発者をフォロー

- Instagram（English）: [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- Threads（中文）: [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)

W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/)（商用ライセンス・買い取りについて）
