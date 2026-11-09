# 台灣 GPON 貓棒 × OpenWrt 安全切換工具 / Taiwan GPON Stick × OpenWrt Safe Cutover Kit

[繁體中文](#繁體中文) | [English](#english)

## 繁體中文

這是一個**硬體限定、fail-closed** 的切換工具：重用已通過回歸測試的 ODI
GPON snapshot 與 OpenWrt WAN consumer，協助把中華電信線路從原 ONT 切到
GPON SFP stick，再交給 Xiaomi BE10000/QWRT 撥接。

目前唯一支援的 profile 是：

- Router：Xiaomi BE10000，QWRT/OpenWrt，WAN device `eth5`
- Stick：ODI DFP-34X-2C3 相容 CLI
- ISP/profile：CHT，OMCI Manual VID `2769`

它不會寫入或猜測 GPON SN、PLOAM、OMCI identity，也不會替你繞過 ISP
授權。請只操作自己合法申裝的線路。其他 Router、VLAN 或 ISP 必須先新增並
測試明確 profile；不要只改一個數字硬跑。

### 為什麼它比舊腳本安全

- 預設只有 read-only preflight。
- 不接受密碼參數，也不接觸 macOS Keychain；只使用你已建立的 SSH
  ControlMaster socket。
- 切換前先留下 mode `0600` 的 Router `/etc/config/network` 備份。
- 必須先看到 off-fibre O1，之後穩定 O5、OMCI ME 與本地 VLAN gate 全過，才
  允許一次 15 秒 WAN probe。
- 只有 PADO、IPv4、DNS、HTTP 與 route 全部成功才 commit；其他結果會把 WAN
  帶回 down，並保留可稽核 evidence。
- durable attempt marker 阻止同一次 run 重複撥接。

### 安裝

需要 Node.js 25+、OpenSSH，以及你已經合法設定好的 stick identity、PPPoE 與
Router WAN。目前只在 Node.js 25 與 macOS/Linux 的 Unix ControlMaster socket
上做過回歸；較舊 Node 版本會 fail closed。此公開 repository 可直接取得並執行：

```sh
git clone https://github.com/arvin-chou/tw-gpon-openwrt-cutover-kit.git \
  && cd tw-gpon-openwrt-cutover-kit \
  && node bin/install.mjs
```

安裝器會跑完整 regression 與 secret release gate，並建立 mode `0600` 的
`.env`；它不會連設備、不會改 Router。

### 避免 Keychain 一直跳

本工具不會呼叫 `ssh-add`、Keychain 或讀取 private key。請在兩個自己的前景
terminal 建立 socket，再讓工具重用它們：

```sh
ssh -o UseKeychain=no -o AddKeysToAgent=no \
  -o ControlMaster=yes -o ControlPersist=no \
  -S /absolute/path/to/odi-stick-master.sock -N admin@stick.local

ssh -o UseKeychain=no -o AddKeysToAgent=no \
  -o ControlMaster=yes -o ControlPersist=no \
  -S /absolute/path/to/openwrt-router-master.sock -N root@router.lan
```

不要把密碼、private key、GPON identity 放進 `.env`。修改 `.env` 中的 socket
路徑與 host 即可。

### Profile contract 與外連

目前 profile 不是通用 OpenWrt autodetection；它明確要求 Xiaomi BE10000/QWRT
使用 `eth5` 作為 WAN，stick 管理路徑位於 `sfp_ns`，管理位址為
`192.168.1.1`。它會拒絕既有的 `eth5.2769`，也會拒絕已知舊設定
`eth5.2770`，避免在殘留 VLAN 上再次撥接。若你的拓撲不同，請勿執行
`cutover --apply`。

完整 consumer gate 會透過 WAN DNS 查詢 `example.com`，並對
`captive.apple.com` 或 `example.com` 發出不含 subscriber identity 的 HTTP
連通測試；這些都是一次性 WAN closure evidence，不是背景 telemetry。

### 使用

先在不動光纖、不中斷既有 ONT 的情況下執行 read-only preflight：

```sh
npm run preflight
```

要正式切換時，**先啟動工具，再依 terminal 的 armed evidence 移纖**：

```sh
npm run cutover
```

不要在工具尚未證明 `armed_for_fiber_move` 前移纖。輸出與完成 marker 都在
`.env` 指定的 `GPON_STATE_DIR`；該目錄以及 Router 備份已被 `.gitignore` 排除。

可先看實際 delegated argv，而不連線、不備份、不改 WAN：

```sh
node bin/gpon-cutover.mjs cutover --apply --dry-run
```

### 回復與失敗語意

本工具不修改 UCI network 設定；它只對既有 `auto=0` WAN 做一次受控 `ifup`。
probe 未完整閉環時會自動 `ifdown` 並驗證 rollback。若設備在 probe 期間斷電，
請先保留 `state/*.jsonl` 與 `.done*`，再確認：

```sh
ubus call network.interface.wan status
pgrep pppd
cat /tmp/gpon-router-consumer.lock
```

切換前的 `state/*.network-backup.tgz` 含 Router network secrets，權限固定為
`0600`，不可上傳或 commit。需要完整還原時，先在離線維護窗檢查 archive，
不要直接覆寫 `/etc/config/network`。

若完成 marker 顯示 `rollback=blocked`、`lock=retained`，或 Router 在 probe
期間斷電，請勿重跑 `cutover`、勿手動刪除 lock，也不要把 WAN 強制帶起。保留
該次 `.jsonl`、`.done*` 與備份，先把光纖切回原 ONT 維持服務，再在離線維護窗
確認 claimed process 已結束、WAN 確實為 down，才處理殘留 ownership。這個
fail-closed 狀態刻意不提供「一鍵忽略」選項。

### 發布前檢查

```sh
npm test
```

除了 4 組既有核心 regression，release audit 也會拒絕：`.env`、private key、
MAC、GPON-serial-shaped 值、subscriber credentials、public IPv4、個人 home 或
memory path。

`package.json` 保留 `private: true`，只用來阻止誤發到 npm registry；GitHub
repository 本身已公開。本 repository 不包含設備 identity、subscriber
credentials 或可直接登入任何設備的資料。

### 授權

本專案以 [MIT License](LICENSE) 發布。

## English

This is a **hardware-specific, fail-closed** cutover tool. It reuses a
regression-tested ODI GPON snapshot and OpenWrt WAN consumer to move a Chunghwa
Telecom line from the original ONT to a GPON SFP stick, then hand the connection
to a Xiaomi BE10000/QWRT router for dialing.

The only currently supported profile is:

- Router: Xiaomi BE10000 running QWRT/OpenWrt, with WAN device `eth5`
- Stick: CLI compatible with the ODI DFP-34X-2C3
- ISP/profile: CHT with OMCI Manual VID `2769`

The tool neither writes nor guesses the GPON SN, PLOAM, or OMCI identity, and it
does not bypass ISP authorization. Use it only on a line that you are legally
authorized to operate. Any other router, VLAN, or ISP requires an explicit,
tested profile first; do not force a run by changing a single number.

### Why it is safer than the old scripts

- The default action is a read-only preflight.
- It accepts no password arguments and does not access macOS Keychain; it uses
  only SSH ControlMaster sockets that you have already created.
- Before cutover, it creates a mode `0600` backup of the router's
  `/etc/config/network`.
- It must first observe off-fibre O1, then stable O5, OMCI ME, and all local VLAN
  gates before allowing a single 15-second WAN probe.
- It commits only when PADO, IPv4, DNS, HTTP, and the route all succeed. Any
  other outcome brings the WAN back down and preserves auditable evidence.
- A durable attempt marker prevents repeated dialing during the same run.

### Installation

You need Node.js 25+, OpenSSH, and a legally configured stick identity, PPPoE,
and router WAN. Regression coverage currently applies only to Node.js 25 and
Unix ControlMaster sockets on macOS/Linux; older Node.js versions fail closed.
Clone and run this public repository directly:

```sh
git clone https://github.com/arvin-chou/tw-gpon-openwrt-cutover-kit.git \
  && cd tw-gpon-openwrt-cutover-kit \
  && node bin/install.mjs
```

The installer runs the complete regression suite and secret release gate, then
creates `.env` with mode `0600`. It does not connect to either device or modify
the router.

### Prevent repeated Keychain prompts

This tool does not invoke `ssh-add`, access Keychain, or read a private key.
Create the sockets in two foreground terminals that you control, then let the
tool reuse them:

```sh
ssh -o UseKeychain=no -o AddKeysToAgent=no \
  -o ControlMaster=yes -o ControlPersist=no \
  -S /absolute/path/to/odi-stick-master.sock -N admin@stick.local

ssh -o UseKeychain=no -o AddKeysToAgent=no \
  -o ControlMaster=yes -o ControlPersist=no \
  -S /absolute/path/to/openwrt-router-master.sock -N root@router.lan
```

Do not put passwords, private keys, or a GPON identity in `.env`. Edit only the
socket paths and hosts in `.env`.

### Profile contract and outbound connections

The current profile is not generic OpenWrt autodetection. It explicitly requires
a Xiaomi BE10000/QWRT router using `eth5` as WAN, with the stick management path
in `sfp_ns` at management address `192.168.1.1`. It rejects an existing
`eth5.2769` and the known legacy configuration `eth5.2770`, preventing another
dial attempt over a leftover VLAN. If your topology differs, do not run
`cutover --apply`.

The complete consumer gate uses WAN DNS to resolve `example.com`, then sends an
HTTP connectivity probe containing no subscriber identity to either
`captive.apple.com` or `example.com`. These requests provide one-time WAN closure
evidence; they are not background telemetry.

### Usage

First run the read-only preflight without moving the fibre or interrupting the
existing ONT:

```sh
npm run preflight
```

For the actual cutover, **start the tool first, then move the fibre only when the
terminal shows armed evidence**:

```sh
npm run cutover
```

Do not move the fibre before the tool proves `armed_for_fiber_move`. Output and
completion markers are stored in the `GPON_STATE_DIR` specified by `.env`; both
that directory and the router backups are excluded by `.gitignore`.

To inspect the actual delegated argv without connecting, backing up, or changing
the WAN, run:

```sh
node bin/gpon-cutover.mjs cutover --apply --dry-run
```

### Recovery and failure semantics

The tool does not modify the UCI network configuration. It performs one
controlled `ifup` on the existing `auto=0` WAN. If the probe does not complete
the full closure sequence, the tool automatically runs `ifdown` and verifies
rollback. If a device loses power during the probe, first preserve
`state/*.jsonl` and `.done*`, then check:

```sh
ubus call network.interface.wan status
pgrep pppd
cat /tmp/gpon-router-consumer.lock
```

The pre-cutover `state/*.network-backup.tgz` contains router network secrets and
always has mode `0600`; never upload or commit it. For a full restore, inspect
the archive during an offline maintenance window rather than overwriting
`/etc/config/network` directly.

If the completion marker shows `rollback=blocked` or `lock=retained`, or if the
router lost power during the probe, do not rerun `cutover`, manually delete the
lock, or force the WAN up. Preserve that run's `.jsonl`, `.done*`, and backup;
move the fibre back to the original ONT to maintain service. During an offline
maintenance window, confirm that the claimed process has ended and that the WAN
is truly down before resolving any remaining ownership. This fail-closed state
intentionally provides no “ignore with one click” option.

### Pre-release checks

```sh
npm test
```

In addition to the four existing core regression suites, the release audit
rejects `.env`, private keys, MAC addresses, GPON-serial-shaped values,
subscriber credentials, public IPv4 addresses, and personal home or memory
paths.

`package.json` retains `private: true` solely to prevent accidental publication
to the npm registry; the GitHub repository itself is public. This repository
contains no device identity, subscriber credentials, or data that can directly
authenticate to any device.

### License

This project is released under the [MIT License](LICENSE).
