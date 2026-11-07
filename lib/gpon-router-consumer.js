import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileWithoutInput = promisify(execFile);

function execFileAsync(file, args, options = {}) {
  const { input, ...executionOptions } = options;
  if (input === undefined) return execFileWithoutInput(file, args, executionOptions);

  return new Promise((resolve, reject) => {
    let inputError;
    const child = execFile(file, args, executionOptions, (error, stdout, stderr) => {
      if (error || inputError) {
        reject(error ?? inputError);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.once('error', (error) => {
      inputError = error;
    });
    child.stdin.end(input);
  });
}

export const ROUTER_CONSUMER_TIMEOUT_SEC = 15;
export const ROUTER_ROLLBACK_SETTLE_SEC = 5;
export const ROUTER_PROBE_WATCHDOG_SEC = 30;
export const ROUTER_PROBE_KILL_GRACE_SEC = 20;
export const ROUTER_PROBE_TIMEOUT_MS = 65_000;
export const ROUTER_CLEANUP_OWNER_WAIT_SEC = (
  ROUTER_PROBE_WATCHDOG_SEC + ROUTER_PROBE_KILL_GRACE_SEC + ROUTER_ROLLBACK_SETTLE_SEC * 2 + 3
);
export const ROUTER_ROLLBACK_TIMEOUT_MS = (
  ROUTER_CLEANUP_OWNER_WAIT_SEC + (2 * ROUTER_ROLLBACK_SETTLE_SEC) + 10
) * 1_000;
export const REQUIRED_MANUAL_VID = 2769;

const PREFLIGHT_MARKER = '===ROUTER_PREFLIGHT_COMPLETE===';
const PROBE_MARKER = '===ROUTER_CONSUMER_COMPLETE===';
const ROLLBACK_MARKER = '===ROUTER_ROLLBACK_COMPLETE===';
const COMMIT_MARKER = '===ROUTER_COMMIT_COMPLETE===';
const OWNERSHIP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PREFLIGHT_REASONS = new Set([
  'ready',
  'missing_tool',
  'wan_proto',
  'wan_device',
  'wan_auto',
  'wan_status_unavailable',
  'wan_already_up',
  'wan_pending',
  'pppd_running',
  'eth5_not_up',
  'eth5_carrier',
  'router_vlan_interface',
  'lock_lost',
  'lock_busy',
]);

const ROUTER_PREFLIGHT_SCRIPT = String.raw`
reason=ready
for tool in ip ubus jsonfilter logread nslookup nc uci pidof ping wc awk grep cat sleep mkdir rm kill; do
  if ! command -v "$tool" >/dev/null 2>&1; then reason=missing_tool; break; fi
done
if [ "$reason" = ready ] && [ "$(uci -q get network.wan.proto 2>/dev/null)" != pppoe ]; then
  reason=wan_proto
fi
wan_device=''
if [ "$reason" = ready ]; then
  wan_device=$(uci -q get network.wan.device 2>/dev/null)
  if [ -z "$wan_device" ]; then wan_device=$(uci -q get network.wan.ifname 2>/dev/null); fi
  if [ "$wan_device" != eth5 ]; then reason=wan_device; fi
fi
if [ "$reason" = ready ] && [ "$(uci -q get network.wan.auto 2>/dev/null)" != 0 ]; then
  reason=wan_auto
fi
if [ "$reason" = ready ]; then
  wan_status=$(ubus call network.interface.wan status 2>/dev/null)
  wan_status_rc=$?
  wan_up=$(printf '%s' "$wan_status" | jsonfilter -e '@.up' 2>/dev/null)
  wan_pending=$(printf '%s' "$wan_status" | jsonfilter -e '@.pending' 2>/dev/null)
  if [ "$wan_status_rc" -ne 0 ] \
    || { [ "$wan_up" != true ] && [ "$wan_up" != false ]; } \
    || { [ "$wan_pending" != true ] && [ "$wan_pending" != false ]; }; then
    reason=wan_status_unavailable
  elif [ "$wan_up" = true ]; then
    reason=wan_already_up
  elif [ "$wan_pending" = true ]; then
    reason=wan_pending
  fi
fi
if [ "$reason" = ready ] && pidof pppd >/dev/null 2>&1; then reason=pppd_running; fi
if [ "$reason" = ready ] && ! ip link show dev eth5 2>/dev/null | grep -Eq '<([^>]*,)?UP(,|>)'; then
  reason=eth5_not_up
fi
if [ "$reason" = ready ] && [ "$(cat /sys/class/net/eth5/carrier 2>/dev/null)" != 1 ]; then
  reason=eth5_carrier
fi
if [ "$reason" = ready ] && { ip link show dev eth5.2769 >/dev/null 2>&1 || ip link show dev eth5.2770 >/dev/null 2>&1; }; then
  reason=router_vlan_interface
fi
if [ "$reason" = ready ] && { [ -e /tmp/gpon-router-consumer.lock ] || [ -L /tmp/gpon-router-consumer.lock ]; }; then
  reason=lock_busy
fi
if [ "$reason" = ready ]; then gate=ready; else gate=blocked; fi
printf 'ROUTER_PREFLIGHT=%s\n' "$gate"
printf 'ROUTER_PREFLIGHT_REASON=%s\n' "$reason"
printf '%s\n' '${PREFLIGHT_MARKER}'
`;

function buildRouterProbeScript(lockToken) {
  return String.raw`
cleanup_needed=0
rollback_state=blocked
precheck=lock_busy
ifup_ok=false
lock_path=/tmp/gpon-router-consumer.lock
lock_token='${lockToken}'
lock_owner_pid=$$
lock_owner_starttime=''
claim_path="/tmp/gpon-router-consumer.claim.$lock_token"
claim_owned=0
lock_owned=0
lock_state=not_acquired
wan_status_rc=1
wan_up=unknown
wan_pending=unknown
wan_device=''
wan_ipv4=''
wan_l3=''
wan_dns=''
watchdog_pid=''
mutator_pid=''
mutator_starttime=''
mutator_go="$claim_path/mutator.go"

process_starttime() {
  identity_pid=$1
  case "$identity_pid" in ''|*[!0-9]*) return 1 ;; esac
  identity_starttime=$(awk '{ print $22 }' "/proc/$identity_pid/stat" 2>/dev/null)
  case "$identity_starttime" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$identity_starttime"
}

process_identity_alive() {
  identity_pid=$1
  expected_starttime=$2
  case "$identity_pid:$expected_starttime" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  current_starttime=$(process_starttime "$identity_pid") || return 1
  [ "$current_starttime" = "$expected_starttime" ]
}

lock_owner_starttime=$(process_starttime "$lock_owner_pid") || lock_owner_starttime=''
if [ -n "$lock_owner_starttime" ] && mkdir "$claim_path" 2>/dev/null; then
  if mkdir "$claim_path/probe.$lock_owner_pid.$lock_owner_starttime" 2>/dev/null; then
    claim_owned=1
  fi
fi
if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then claim_owned=0; fi

read_wan_status() {
  current_status=$(ubus call network.interface.wan status 2>/dev/null)
  wan_status_rc=$?
  wan_up=unknown
  wan_pending=unknown
  wan_device=''
  wan_ipv4=''
  wan_l3=''
  wan_dns=''
  if [ "$wan_status_rc" -eq 0 ]; then
    parsed_wan_up=$(printf '%s' "$current_status" | jsonfilter -e '@.up' 2>/dev/null)
    parsed_wan_pending=$(printf '%s' "$current_status" | jsonfilter -e '@.pending' 2>/dev/null)
    case "$parsed_wan_up" in true|false) wan_up=$parsed_wan_up ;; esac
    case "$parsed_wan_pending" in true|false) wan_pending=$parsed_wan_pending ;; esac
    wan_device=$(printf '%s' "$current_status" | jsonfilter -e '@.device' 2>/dev/null)
    wan_ipv4=$(printf '%s' "$current_status" | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null)
    wan_l3=$(printf '%s' "$current_status" | jsonfilter -e '@.l3_device' 2>/dev/null)
    wan_dns=$(printf '%s' "$current_status" | jsonfilter -e '@["dns-server"][0]' 2>/dev/null)
  fi
}

rollback_wan() {
  ubus -t 3 call network.interface down '{ "interface" : "wan" }' >/dev/null 2>&1 || true
  sleep ${ROUTER_ROLLBACK_SETTLE_SEC}
  ip link set eth5 up >/dev/null 2>&1 || true
  sleep ${ROUTER_ROLLBACK_SETTLE_SEC}
  read_wan_status
  if [ "$wan_status_rc" -eq 0 ] \
    && [ "$wan_up" = false ] \
    && [ "$wan_pending" = false ] \
    && [ "$wan_device" = eth5 ] \
    && command -v pidof >/dev/null 2>&1 \
    && ! pidof pppd >/dev/null 2>&1 \
    && ip link show dev eth5 2>/dev/null | grep -Eq '<([^>]*,)?UP(,|>)' \
    && [ "$(cat /sys/class/net/eth5/carrier 2>/dev/null)" = 1 ] \
    && ip netns exec sfp_ns ping -c 1 -W 1 192.168.1.1 >/dev/null 2>&1 \
    && [ "$(uci -q get network.wan.auto 2>/dev/null)" = 0 ]; then
    rollback_state=ready
  else
    rollback_state=blocked
  fi
}

read_lock_value() {
  current_lock_value=''
  if [ -f "$lock_path" ] && [ ! -L "$lock_path" ]; then
    IFS= read -r current_lock_value < "$lock_path" || current_lock_value=''
  fi
}

owns_lock_phase() {
  read_lock_value
  [ "$current_lock_value" = "$lock_token:$1:$lock_owner_pid" ]
}

mark_lock_mutating() {
  if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then return 1; fi
  if ! owns_lock_phase precheck; then return 1; fi
  printf '%s\n' "$lock_token:mutating:$lock_owner_pid" > "$lock_path" || return 1
  owns_lock_phase mutating
}

release_lock() {
  if [ "$lock_owned" != 1 ]; then return 0; fi
  read_lock_value
  case "$current_lock_value" in
    "$lock_token:precheck:$lock_owner_pid"|"$lock_token:mutating:$lock_owner_pid"|"$lock_token:cleanup:$lock_owner_pid") ;;
    *) lock_owned=0; lock_state=release_failed; return 1 ;;
  esac
  if [ -f "$lock_path" ] \
    && [ ! -L "$lock_path" ] \
    && rm -f "$lock_path" \
    && [ ! -e "$lock_path" ] \
    && [ ! -L "$lock_path" ]; then
    lock_owned=0
    lock_state=released
    return 0
  fi
  lock_owned=0
  lock_state=release_failed
  return 1
}

retain_lock() {
  if [ "$lock_owned" != 1 ]; then return 1; fi
  if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then return 1; fi
  if owns_lock_phase mutating || owns_lock_phase cleanup; then
    lock_owned=0
    lock_state=retained
    return 0
  fi
  lock_owned=0
  lock_state=release_failed
  return 1
}

stop_mutator() {
  if [ -z "$mutator_pid" ] || [ -z "$mutator_starttime" ]; then return 0; fi
  if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
    kill -TERM "$mutator_pid" >/dev/null 2>&1 || true
    stop_elapsed=0
    while process_identity_alive "$mutator_pid" "$mutator_starttime" \
      && [ "$stop_elapsed" -lt 2 ]; do
      sleep 1
      stop_elapsed=$((stop_elapsed + 1))
    done
    if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
      kill -KILL "$mutator_pid" >/dev/null 2>&1 || true
    fi
  fi
  wait "$mutator_pid" 2>/dev/null || true
}

cleanup_on_exit() {
  if [ "$cleanup_needed" = 1 ]; then
    mkdir "$claim_path/cancel" 2>/dev/null || true
    stop_mutator
    rollback_wan
    cleanup_needed=0
    if [ "$rollback_state" = ready ]; then release_lock || true; else retain_lock || true; fi
  else
    release_lock || true
  fi
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" >/dev/null 2>&1 || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=''
  fi
}
cleanup_on_signal() {
  mkdir "$claim_path/cancel" 2>/dev/null || true
  cleanup_on_exit
  trap - EXIT
  exit 1
}
trap cleanup_on_exit EXIT
trap cleanup_on_signal HUP INT TERM

if [ "$claim_owned" = 1 ] && command -v rm >/dev/null 2>&1; then
  lock_owned=1
  if (umask 077; set -C; printf '%s\n' "$lock_token:precheck:$lock_owner_pid" > "$lock_path") 2>/dev/null; then
    lock_state=owned
    precheck=ready
  else
    lock_owned=0
  fi
fi

if [ "$precheck" = ready ]; then
  for tool in ip ubus jsonfilter logread nslookup nc uci pidof ping wc awk grep cat sleep mkdir rm kill; do
    if ! command -v "$tool" >/dev/null 2>&1; then precheck=missing_tool; break; fi
  done
fi
if [ "$precheck" = ready ] && [ "$(uci -q get network.wan.proto 2>/dev/null)" != pppoe ]; then
  precheck=wan_proto
fi
wan_device=''
if [ "$precheck" = ready ]; then
  wan_device=$(uci -q get network.wan.device 2>/dev/null)
  if [ -z "$wan_device" ]; then wan_device=$(uci -q get network.wan.ifname 2>/dev/null); fi
  if [ "$wan_device" != eth5 ]; then precheck=wan_device; fi
fi
if [ "$precheck" = ready ] && [ "$(uci -q get network.wan.auto 2>/dev/null)" != 0 ]; then
  precheck=wan_auto
fi
if [ "$precheck" = ready ]; then
  read_wan_status
  if [ "$wan_status_rc" -ne 0 ] || [ "$wan_up" = unknown ]; then
    precheck=wan_status_unavailable
  elif [ "$wan_up" != false ]; then
    precheck=wan_already_up
  elif [ "$wan_pending" != false ]; then
    precheck=wan_pending
  fi
fi
if [ "$precheck" = ready ] && pidof pppd >/dev/null 2>&1; then precheck=pppd_running; fi
if [ "$precheck" = ready ] && ! ip link show dev eth5 2>/dev/null | grep -Eq '<([^>]*,)?UP(,|>)'; then
  precheck=eth5_not_up
fi
if [ "$precheck" = ready ] && [ "$(cat /sys/class/net/eth5/carrier 2>/dev/null)" != 1 ]; then
  precheck=eth5_carrier
fi
if [ "$precheck" = ready ] && { ip link show dev eth5.2769 >/dev/null 2>&1 || ip link show dev eth5.2770 >/dev/null 2>&1; }; then
  precheck=router_vlan_interface
fi

no_pado_before=''
no_pado_after=''
if [ "$precheck" = ready ]; then
  no_pado_before=$(logread -e 'Timeout waiting for PADO packets' 2>/dev/null | wc -l | awk '{print $1}')
  if mark_lock_mutating; then
    cleanup_needed=1
    (
      trap - HUP INT TERM
      while [ ! -d "$mutator_go" ]; do
        if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then exit 125; fi
        sleep 1
      done
      if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then exit 125; fi
      exec ubus call network.interface up '{ "interface" : "wan" }' >/dev/null 2>&1
    ) &
    mutator_pid=$!
    mutator_starttime=$(process_starttime "$mutator_pid") || mutator_starttime=''
    if [ -n "$mutator_starttime" ] \
      && mkdir "$claim_path/mutator.$mutator_pid.$mutator_starttime" 2>/dev/null; then
      (
        sleep ${ROUTER_PROBE_WATCHDOG_SEC}
        mkdir "$claim_path/cancel" 2>/dev/null || true
        if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
          kill -TERM "$mutator_pid" >/dev/null 2>&1 || true
        fi
        if process_identity_alive "$lock_owner_pid" "$lock_owner_starttime"; then
          kill -TERM "$lock_owner_pid" >/dev/null 2>&1 || true
        fi
        sleep ${ROUTER_PROBE_KILL_GRACE_SEC}
        if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
          kill -KILL "$mutator_pid" >/dev/null 2>&1 || true
        fi
        if process_identity_alive "$lock_owner_pid" "$lock_owner_starttime"; then
          kill -KILL "$lock_owner_pid" >/dev/null 2>&1 || true
        fi
      ) &
      watchdog_pid=$!
      if [ ! -e "$claim_path/cancel" ] \
        && [ ! -L "$claim_path/cancel" ] \
        && mkdir "$mutator_go" 2>/dev/null; then
        wait "$mutator_pid"
        mutator_rc=$?
        if [ "$mutator_rc" -eq 0 ] \
          && [ ! -e "$claim_path/cancel" ] \
          && [ ! -L "$claim_path/cancel" ]; then
          ifup_ok=true
        fi
      else
        stop_mutator
      fi
    else
      stop_mutator
      precheck=lock_lost
    fi
  else
    precheck=lock_lost
  fi
fi

elapsed=0
if [ "$ifup_ok" = true ]; then
  while [ "$elapsed" -lt ${ROUTER_CONSUMER_TIMEOUT_SEC} ]; do
    if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then
      ifup_ok=false
      break
    fi
    read_wan_status
    if [ "$wan_up" = true ] && [ -n "$wan_ipv4" ]; then break; fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
fi
if [ -e "$claim_path/cancel" ] || [ -L "$claim_path/cancel" ]; then ifup_ok=false; fi
if [ "$precheck" = ready ]; then
  read_wan_status
  no_pado_after=$(logread -e 'Timeout waiting for PADO packets' 2>/dev/null | wc -l | awk '{print $1}')
fi

pado=unknown
wan_ipv4_gate=false
dns_gate=false
http_gate=false
route_gate=false

if [ "$precheck" = ready ] && [ "$ifup_ok" = true ]; then
  if [ "$wan_status_rc" -eq 0 ] && [ "$wan_up" = true ] && [ -n "$wan_ipv4" ]; then
    pado=confirmed_by_session
    wan_ipv4_gate=true
  else
    counters_valid=true
    case "$no_pado_before" in ''|*[!0-9]*) counters_valid=false ;; esac
    case "$no_pado_after" in ''|*[!0-9]*) counters_valid=false ;; esac
    if [ "$counters_valid" = true ] && [ "$no_pado_after" -gt "$no_pado_before" ]; then
      pado=no_pado
    fi
  fi
fi

http_ip=''
if [ "$wan_ipv4_gate" = true ]; then
  case "$wan_l3" in ''|*[!A-Za-z0-9_.-]*) wan_l3='' ;; esac
  case "$wan_dns" in ''|*[!0-9.]*) wan_dns='' ;; esac
  if [ -n "$wan_l3" ] && [ -n "$wan_dns" ]; then
    if ip route get "$wan_dns" 2>/dev/null | grep -Eq "(^|[[:space:]])dev[[:space:]]+$wan_l3([[:space:]]|$)"; then
      dns_output=$(nslookup example.com "$wan_dns" 2>/dev/null)
      dns_rc=$?
      http_ip=$(printf '%s\n' "$dns_output" | awk '
        /^Name:/ { answer=1; next }
        answer && match($0, /[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/) {
          print substr($0, RSTART, RLENGTH); exit
        }
      ')
      if [ "$dns_rc" -eq 0 ] && [ -n "$http_ip" ]; then dns_gate=true; fi
    fi
    if [ "$dns_gate" = true ] \
      && ip route get "$http_ip" 2>/dev/null | grep -Eq "(^|[[:space:]])dev[[:space:]]+$wan_l3([[:space:]]|$)"; then
        route_gate=true
    fi
    if [ "$route_gate" = true ]; then
      # This profile's BusyBox nc completes without returning the HTTP status line
      # even though wget over the same WAN succeeds. Use two plain-HTTP captive
      # checks as the primary transport oracle and keep the raw HTTP probe as a
      # compatibility fallback.
      if wget -T 7 -q -O /dev/null \
          http://connectivitycheck.gstatic.com/generate_204 >/dev/null 2>&1 \
        || wget -T 7 -q -O /dev/null \
          http://captive.apple.com/hotspot-detect.html >/dev/null 2>&1; then
        http_gate=true
      else
        http_status=$(
          printf 'GET / HTTP/1.0\r\nHost: example.com\r\nConnection: close\r\n\r\n' \
            | nc -w 5 "$http_ip" 80 2>/dev/null \
            | awk 'NR == 1 { sub(/\r$/, ""); print; exit }'
        )
        # Any syntactically valid HTTP response proves end-to-end reachability;
        # an application-level 4xx/5xx is not a transport failure.
        if printf '%s\n' "$http_status" | grep -Eq '^HTTP/1\.[01][[:space:]]+[1-5][0-9][0-9]([[:space:]]|$)'; then
          http_gate=true
        fi
      fi
    fi
  fi
fi

consumer_gate=blocked
if [ "$precheck" = ready ] \
  && [ "$ifup_ok" = true ] \
  && [ "$wan_ipv4_gate" = true ] \
  && [ "$dns_gate" = true ] \
  && [ "$http_gate" = true ] \
  && [ "$route_gate" = true ]; then
  if owns_lock_phase mutating && retain_lock; then
    consumer_gate=ready
    rollback_state=not_required
    cleanup_needed=0
  else
    rollback_wan
    cleanup_needed=0
    if [ "$rollback_state" = ready ]; then release_lock || true; else retain_lock || true; fi
  fi
elif [ "$precheck" = ready ]; then
  rollback_wan
  cleanup_needed=0
  if [ "$rollback_state" = ready ]; then release_lock || true; else retain_lock || true; fi
else
  release_lock || true
  rollback_state=not_required
fi

printf 'ROUTER_CONSUMER=%s\n' "$consumer_gate"
printf 'PRECHECK=%s\n' "$precheck"
printf 'IFUP_OK=%s\n' "$ifup_ok"
printf 'PADO=%s\n' "$pado"
printf 'WAN_IPV4=%s\n' "$wan_ipv4_gate"
printf 'DNS=%s\n' "$dns_gate"
printf 'HTTP=%s\n' "$http_gate"
printf 'ROUTE=%s\n' "$route_gate"
printf 'ROLLBACK=%s\n' "$rollback_state"
printf 'LOCK=%s\n' "$lock_state"
printf '%s\n' '${PROBE_MARKER}'
`;
}

function buildRouterRollbackScript(ownershipToken) {
  return String.raw`
lock_path=/tmp/gpon-router-consumer.lock
lock_token='${ownershipToken}'
claim_path="/tmp/gpon-router-consumer.claim.$lock_token"
cleanup_authorized=true
ownership_settled=true
if [ -n "$lock_token" ]; then
  cleanup_authorized=false
  ownership_settled=false
  process_starttime() {
    identity_pid=$1
    case "$identity_pid" in ''|*[!0-9]*) return 1 ;; esac
    identity_starttime=$(awk '{ print $22 }' "/proc/$identity_pid/stat" 2>/dev/null)
    case "$identity_starttime" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s\n' "$identity_starttime"
  }
  process_identity_alive() {
    identity_pid=$1
    expected_starttime=$2
    case "$identity_pid:$expected_starttime" in
      *[!0-9:]*|:*|*:) return 1 ;;
    esac
    current_starttime=$(process_starttime "$identity_pid") || return 1
    [ "$current_starttime" = "$expected_starttime" ]
  }
  read_probe_claim() {
    claim_pid=''
    claim_starttime=''
    claim_probe_count=0
    if [ -d "$claim_path" ] && [ ! -L "$claim_path" ]; then
      for claim_owner_path in "$claim_path"/probe.*.*; do
        [ -d "$claim_owner_path" ] && [ ! -L "$claim_owner_path" ] || continue
        candidate_pid=$(printf '%s\n' "$claim_owner_path" | awk -F. '{ print $(NF - 1) }')
        candidate_starttime=$(printf '%s\n' "$claim_owner_path" | awk -F. '{ print $NF }')
        case "$candidate_pid:$candidate_starttime" in *[!0-9:]*|:*|*:) continue ;; esac
        claim_probe_count=$((claim_probe_count + 1))
        claim_pid=$candidate_pid
        claim_starttime=$candidate_starttime
      done
    fi
    if [ "$claim_probe_count" -ne 1 ]; then claim_pid=''; claim_starttime=''; fi
  }
  read_mutator_claim() {
    mutator_pid=''
    mutator_starttime=''
    mutator_claim_count=0
    if [ -d "$claim_path" ] && [ ! -L "$claim_path" ]; then
      for mutator_path in "$claim_path"/mutator.*.*; do
        [ -d "$mutator_path" ] && [ ! -L "$mutator_path" ] || continue
        candidate_pid=$(printf '%s\n' "$mutator_path" | awk -F. '{ print $(NF - 1) }')
        candidate_starttime=$(printf '%s\n' "$mutator_path" | awk -F. '{ print $NF }')
        case "$candidate_pid:$candidate_starttime" in *[!0-9:]*|:*|*:) continue ;; esac
        mutator_claim_count=$((mutator_claim_count + 1))
        mutator_pid=$candidate_pid
        mutator_starttime=$candidate_starttime
      done
    fi
    if [ "$mutator_claim_count" -ne 1 ]; then mutator_pid=''; mutator_starttime=''; fi
  }
  stop_claimed_mutator() {
    if [ "$mutator_claim_count" -ne 1 ]; then return 0; fi
    if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
      kill -TERM "$mutator_pid" >/dev/null 2>&1 || true
      mutator_wait_elapsed=0
      while process_identity_alive "$mutator_pid" "$mutator_starttime" \
        && [ "$mutator_wait_elapsed" -lt 2 ]; do
        sleep 1
        mutator_wait_elapsed=$((mutator_wait_elapsed + 1))
      done
      if process_identity_alive "$mutator_pid" "$mutator_starttime"; then
        kill -KILL "$mutator_pid" >/dev/null 2>&1 || true
      fi
    fi
  }
  read_owned_lock() {
    current_lock_value=''
    current_lock_phase=''
    current_lock_pid=''
    current_lock_present=false
    if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
      current_lock_present=true
    fi
    if [ -f "$lock_path" ] && [ ! -L "$lock_path" ]; then
      IFS= read -r current_lock_value < "$lock_path" || current_lock_value=''
    fi
    case "$current_lock_value" in
      "$lock_token:"*)
        current_lock_phase=$(printf '%s\n' "$current_lock_value" | awk -F: 'NF == 3 { print $2 }')
        current_lock_pid=$(printf '%s\n' "$current_lock_value" | awk -F: 'NF == 3 { print $3 }')
        case "$current_lock_phase" in precheck|mutating|cleanup|committed) ;; *) current_lock_phase='' ;; esac
        case "$current_lock_pid" in ''|*[!0-9]*) current_lock_phase=''; current_lock_pid='' ;; esac
        ;;
    esac
  }
  cleanup_claim_won=false
  if mkdir "$claim_path" 2>/dev/null; then
    cleanup_claim_won=true
    mkdir "$claim_path/cleanup.$$" 2>/dev/null || true
  else
    if [ -d "$claim_path" ] && [ ! -L "$claim_path" ]; then
      mkdir "$claim_path/cancel" 2>/dev/null || true
      read_probe_claim
      read_mutator_claim
      stop_claimed_mutator
    fi
  fi
  if [ "$cleanup_claim_won" = true ]; then
    read_owned_lock
    if [ "$current_lock_present" = false ]; then ownership_settled=true; fi
  else
    wait_elapsed=0
    while [ -z "$claim_pid" ] \
      && [ "$wait_elapsed" -lt ${ROUTER_CLEANUP_OWNER_WAIT_SEC} ]; do
      sleep 1
      wait_elapsed=$((wait_elapsed + 1))
      read_probe_claim
      read_mutator_claim
      stop_claimed_mutator
    done
    while [ -n "$claim_pid" ] \
      && process_identity_alive "$claim_pid" "$claim_starttime" \
      && [ "$wait_elapsed" -lt ${ROUTER_CLEANUP_OWNER_WAIT_SEC} ]; do
      read_mutator_claim
      stop_claimed_mutator
      sleep 1
      wait_elapsed=$((wait_elapsed + 1))
    done
    read_mutator_claim
    stop_claimed_mutator
    mutator_settled=false
    if [ "$mutator_claim_count" -eq 0 ]; then
      mutator_settled=true
    elif [ "$mutator_claim_count" -eq 1 ] \
      && ! process_identity_alive "$mutator_pid" "$mutator_starttime"; then
      mutator_settled=true
    fi
    if [ -n "$claim_pid" ] \
      && ! process_identity_alive "$claim_pid" "$claim_starttime" \
      && [ "$mutator_settled" = true ]; then
      read_owned_lock
      if [ "$current_lock_present" = false ]; then
        ownership_settled=true
      elif [ "$current_lock_pid" = "$claim_pid" ]; then
        case "$current_lock_phase" in
          precheck)
            expected_lock_value="$lock_token:precheck:$current_lock_pid"
            read_owned_lock
            if [ "$current_lock_value" = "$expected_lock_value" ]; then
              rm -f "$lock_path" >/dev/null 2>&1 || true
            fi
            read_owned_lock
            if [ "$current_lock_present" = false ]; then ownership_settled=true; fi
            ;;
          mutating|cleanup|committed)
            expected_lock_value="$lock_token:$current_lock_phase:$current_lock_pid"
            read_owned_lock
            if [ "$current_lock_value" = "$expected_lock_value" ]; then
              printf '%s\n' "$lock_token:cleanup:$current_lock_pid" > "$lock_path" || true
            fi
            read_owned_lock
            if [ "$current_lock_value" = "$lock_token:cleanup:$current_lock_pid" ]; then
              cleanup_authorized=true
            fi
            ;;
        esac
      fi
    fi
  fi
fi
if [ "$cleanup_authorized" = true ]; then
  ubus -t 3 call network.interface down '{ "interface" : "wan" }' >/dev/null 2>&1 || true
  sleep ${ROUTER_ROLLBACK_SETTLE_SEC}
  ip link set eth5 up >/dev/null 2>&1 || true
  sleep ${ROUTER_ROLLBACK_SETTLE_SEC}
fi
status=$(ubus call network.interface.wan status 2>/dev/null)
ubus_rc=$?
ubus_state=failed
wan_up=unknown
wan_pending=unknown
wan_device=unknown
if [ "$ubus_rc" -eq 0 ]; then
  ubus_state=ok
  parsed_wan_up=$(printf '%s' "$status" | jsonfilter -e '@.up' 2>/dev/null)
  parsed_wan_pending=$(printf '%s' "$status" | jsonfilter -e '@.pending' 2>/dev/null)
  case "$parsed_wan_up" in true|false) wan_up=$parsed_wan_up ;; esac
  case "$parsed_wan_pending" in true|false) wan_pending=$parsed_wan_pending ;; esac
  parsed_wan_device=$(printf '%s' "$status" | jsonfilter -e '@.device' 2>/dev/null)
  case "$parsed_wan_device" in eth5) wan_device=eth5 ;; esac
fi
pppd=unknown
if command -v pidof >/dev/null 2>&1; then
  if pidof pppd >/dev/null 2>&1; then pppd=present; else pppd=absent; fi
fi
if ip link show dev eth5 2>/dev/null | grep -Eq '<([^>]*,)?UP(,|>)'; then eth5_up=true; else eth5_up=false; fi
if [ "$(cat /sys/class/net/eth5/carrier 2>/dev/null)" = 1 ]; then eth5_carrier=true; else eth5_carrier=false; fi
if ip netns exec sfp_ns ping -c 1 -W 1 192.168.1.1 >/dev/null 2>&1; then stick_reachable=true; else stick_reachable=false; fi
if [ "$(uci -q get network.wan.auto 2>/dev/null)" = 0 ]; then auto0=true; else auto0=false; fi
if { [ -z "$lock_token" ] || [ "$ownership_settled" = true ] || [ "$cleanup_authorized" = true ]; } \
  && [ "$ubus_state" = ok ] \
  && [ "$wan_up" = false ] \
  && [ "$wan_pending" = false ] \
  && [ "$wan_device" = eth5 ] \
  && [ "$pppd" = absent ] \
  && [ "$eth5_up" = true ] \
  && [ "$eth5_carrier" = true ] \
  && [ "$stick_reachable" = true ] \
  && [ "$auto0" = true ]; then
  rollback=ready
else
  rollback=blocked
fi
if [ "$rollback" = ready ] && [ -n "$lock_token" ] && [ "$cleanup_authorized" = true ]; then
  current_lock_value=''
  if [ -f "$lock_path" ] && [ ! -L "$lock_path" ]; then
    IFS= read -r current_lock_value < "$lock_path" || current_lock_value=''
  fi
  if [ "$current_lock_value" != "$lock_token:cleanup:$current_lock_pid" ] \
    || ! rm -f "$lock_path" \
    || [ -e "$lock_path" ] \
    || [ -L "$lock_path" ]; then
    rollback=blocked
  fi
fi
printf 'ROLLBACK=%s\n' "$rollback"
printf 'UBUS=%s\n' "$ubus_state"
printf 'WAN_UP=%s\n' "$wan_up"
printf 'WAN_PENDING=%s\n' "$wan_pending"
printf 'WAN_DEVICE=%s\n' "$wan_device"
printf 'PPPD=%s\n' "$pppd"
printf 'ETH5_UP=%s\n' "$eth5_up"
printf 'ETH5_CARRIER=%s\n' "$eth5_carrier"
printf 'STICK_REACHABLE=%s\n' "$stick_reachable"
printf 'AUTO0=%s\n' "$auto0"
printf '%s\n' '${ROLLBACK_MARKER}'
`;
}

function buildRouterCommitScript(ownershipToken) {
  return String.raw`
lock_path=/tmp/gpon-router-consumer.lock
lock_token='${ownershipToken}'
claim_path="/tmp/gpon-router-consumer.claim.$lock_token"
commit=blocked
claim_pid=''
claim_starttime=''
claim_probe_count=0
mutator_pid=''
mutator_starttime=''
mutator_claim_count=0
process_starttime() {
  identity_pid=$1
  case "$identity_pid" in ''|*[!0-9]*) return 1 ;; esac
  identity_starttime=$(awk '{ print $22 }' "/proc/$identity_pid/stat" 2>/dev/null)
  case "$identity_starttime" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$identity_starttime"
}
process_identity_alive() {
  identity_pid=$1
  expected_starttime=$2
  case "$identity_pid:$expected_starttime" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  current_starttime=$(process_starttime "$identity_pid") || return 1
  [ "$current_starttime" = "$expected_starttime" ]
}
if [ -d "$claim_path" ] && [ ! -L "$claim_path" ]; then
  for claim_owner_path in "$claim_path"/probe.*.*; do
    [ -d "$claim_owner_path" ] && [ ! -L "$claim_owner_path" ] || continue
    candidate_pid=$(printf '%s\n' "$claim_owner_path" | awk -F. '{ print $(NF - 1) }')
    candidate_starttime=$(printf '%s\n' "$claim_owner_path" | awk -F. '{ print $NF }')
    case "$candidate_pid:$candidate_starttime" in *[!0-9:]*|:*|*:) continue ;; esac
    claim_probe_count=$((claim_probe_count + 1))
    claim_pid=$candidate_pid
    claim_starttime=$candidate_starttime
  done
  for mutator_path in "$claim_path"/mutator.*.*; do
    [ -d "$mutator_path" ] && [ ! -L "$mutator_path" ] || continue
    candidate_pid=$(printf '%s\n' "$mutator_path" | awk -F. '{ print $(NF - 1) }')
    candidate_starttime=$(printf '%s\n' "$mutator_path" | awk -F. '{ print $NF }')
    case "$candidate_pid:$candidate_starttime" in *[!0-9:]*|:*|*:) continue ;; esac
    mutator_claim_count=$((mutator_claim_count + 1))
    mutator_pid=$candidate_pid
    mutator_starttime=$candidate_starttime
  done
fi
if [ "$claim_probe_count" -ne 1 ]; then claim_pid=''; claim_starttime=''; fi
if [ "$mutator_claim_count" -ne 1 ]; then mutator_pid=''; mutator_starttime=''; fi
current_lock_value=''
if [ -f "$lock_path" ] && [ ! -L "$lock_path" ]; then
  IFS= read -r current_lock_value < "$lock_path" || current_lock_value=''
fi
case "$current_lock_value" in
  "$lock_token:"*)
    lock_owner_phase=$(printf '%s\n' "$current_lock_value" | awk -F: 'NF == 3 { print $2 }')
    lock_owner_pid=$(printf '%s\n' "$current_lock_value" | awk -F: 'NF == 3 { print $3 }')
    ;;
  *) lock_owner_phase=''; lock_owner_pid='' ;;
esac
case "$lock_owner_pid" in ''|*[!0-9]*) lock_owner_pid='' ;; esac
if [ "$lock_owner_phase" = mutating ] \
  && [ -n "$lock_owner_pid" ] \
  && [ "$claim_pid" = "$lock_owner_pid" ] \
  && [ "$mutator_claim_count" -eq 1 ] \
  && [ ! -e "$claim_path/cancel" ] \
  && [ ! -L "$claim_path/cancel" ] \
  && ! process_identity_alive "$claim_pid" "$claim_starttime" \
  && ! process_identity_alive "$mutator_pid" "$mutator_starttime"; then
  printf '%s\n' "$lock_token:committed:$lock_owner_pid" > "$lock_path" || true
  current_lock_value=''
  if [ -f "$lock_path" ] && [ ! -L "$lock_path" ]; then
    IFS= read -r current_lock_value < "$lock_path" || current_lock_value=''
  fi
  if [ "$current_lock_value" = "$lock_token:committed:$lock_owner_pid" ]; then commit=ready; fi
fi
printf 'COMMIT=%s\n' "$commit"
printf '%s\n' '${COMMIT_MARKER}'
`;
}

export class RouterConsumerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RouterConsumerError';
    this.code = code;
  }
}

export function isStableO5Sequence({ consecutiveSamples, elapsedMs }) {
  return Number.isInteger(consecutiveSamples)
    && consecutiveSamples >= 2
    && Number.isFinite(elapsedMs)
    && elapsedMs >= 30_000;
}

const ATTEMPT_FILE_SYSTEM = Object.freeze({
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
});

function writeAll(descriptor, data, fileSystem) {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fileSystem.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('attempt marker write made no progress');
    offset += written;
  }
}

export function consumeRouterAttempt(path, evidence, {
  fileSystem = ATTEMPT_FILE_SYSTEM,
} = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new RouterConsumerError('router_attempt_path_not_absolute');
  }
  let fileDescriptor;
  let directoryDescriptor;
  try {
    fileDescriptor = fileSystem.openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fileSystem.fchmodSync(fileDescriptor, 0o600);
    writeAll(fileDescriptor, `${JSON.stringify(evidence)}\n`, fileSystem);
    fileSystem.fsyncSync(fileDescriptor);
    fileSystem.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    directoryDescriptor = fileSystem.openSync(
      dirname(path),
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    if (!fileSystem.fstatSync(directoryDescriptor).isDirectory()) {
      throw new Error('attempt marker parent is not a directory');
    }
    fileSystem.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new RouterConsumerError('router_attempt_already_consumed');
    throw new RouterConsumerError('router_attempt_claim_failed');
  } finally {
    if (fileDescriptor !== undefined) fileSystem.closeSync(fileDescriptor);
    if (directoryDescriptor !== undefined) fileSystem.closeSync(directoryDescriptor);
  }
}

function sshArgs(controlSocket, host) {
  return [
    '-S', controlSocket,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    host,
    'sh', '-s',
  ];
}

async function requireControlMaster({ controlSocket, host, executeFile }) {
  try {
    await executeFile('ssh', [
      '-S', controlSocket,
      '-o', 'BatchMode=yes',
      '-O', 'check',
      host,
    ], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new RouterConsumerError('router_control_master_unavailable');
  }
}

function structuredLines(stdout, marker, errorCode) {
  if (typeof stdout !== 'string') throw new RouterConsumerError(errorCode);
  const lines = stdout.split(/\r?\n/);
  while (lines.at(-1)?.trim() === '') lines.pop();
  const markerCount = lines.filter(line => line.trim() === marker).length;
  if (markerCount !== 1 || lines.at(-1)?.trim() !== marker) {
    throw new RouterConsumerError(errorCode);
  }
  return lines.slice(0, -1).filter(line => line !== '');
}

function parsePairs(lines, expectedKeys, errorCode) {
  const result = {};
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=([A-Za-z0-9_]+)$/);
    if (!match || !expectedKeys.has(match[1]) || result[match[1]] !== undefined) {
      throw new RouterConsumerError(errorCode);
    }
    result[match[1]] = match[2];
  }
  if ([...expectedKeys].some(key => result[key] === undefined)) {
    throw new RouterConsumerError(errorCode);
  }
  return result;
}

async function runRemote({
  controlSocket,
  host,
  command,
  timeout,
  executeFile,
  errorCode,
  signal,
}) {
  try {
    const executionOptions = {
      timeout,
      maxBuffer: 64 * 1024,
      // Dropbear may reject oversized remote command strings before producing output.
      input: command,
    };
    if (signal !== undefined) executionOptions.signal = signal;
    return await executeFile('ssh', sshArgs(controlSocket, host), executionOptions);
  } catch {
    throw new RouterConsumerError(errorCode);
  }
}

export async function runRouterPreflight({
  controlSocket,
  host,
  executeFile = execFileAsync,
}) {
  await requireControlMaster({ controlSocket, host, executeFile });
  const { stdout } = await runRemote({
    controlSocket,
    host,
    command: ROUTER_PREFLIGHT_SCRIPT,
    timeout: 10_000,
    executeFile,
    errorCode: 'router_preflight_incomplete',
  });
  const values = parsePairs(
    structuredLines(stdout, PREFLIGHT_MARKER, 'router_preflight_incomplete'),
    new Set(['ROUTER_PREFLIGHT', 'ROUTER_PREFLIGHT_REASON']),
    'router_preflight_incomplete',
  );
  if (!['ready', 'blocked'].includes(values.ROUTER_PREFLIGHT)
    || !PREFLIGHT_REASONS.has(values.ROUTER_PREFLIGHT_REASON)
    || (values.ROUTER_PREFLIGHT === 'ready') !== (values.ROUTER_PREFLIGHT_REASON === 'ready')) {
    throw new RouterConsumerError('router_preflight_incomplete');
  }
  return {
    gate: values.ROUTER_PREFLIGHT,
    reason: values.ROUTER_PREFLIGHT_REASON,
  };
}

function blockedRollbackResult(reason) {
  return {
    gate: 'blocked',
    ubus: 'unknown',
    wanUp: 'unknown',
    wanPending: 'unknown',
    wanDevice: 'unknown',
    pppd: 'unknown',
    eth5Up: 'unknown',
    eth5Carrier: 'unknown',
    stickReachable: 'unknown',
    auto0: 'unknown',
    reason,
  };
}

function parseRollback(stdout) {
  const values = parsePairs(
    structuredLines(stdout, ROLLBACK_MARKER, 'router_rollback_incomplete'),
    new Set([
      'ROLLBACK',
      'UBUS',
      'WAN_UP',
      'WAN_PENDING',
      'WAN_DEVICE',
      'PPPD',
      'ETH5_UP',
      'ETH5_CARRIER',
      'STICK_REACHABLE',
      'AUTO0',
    ]),
    'router_rollback_incomplete',
  );
  if (!['ready', 'blocked'].includes(values.ROLLBACK)
    || !['ok', 'failed'].includes(values.UBUS)
    || !['true', 'false', 'unknown'].includes(values.WAN_UP)
    || !['true', 'false', 'unknown'].includes(values.WAN_PENDING)
    || !['eth5', 'unknown'].includes(values.WAN_DEVICE)
    || !['present', 'absent', 'unknown'].includes(values.PPPD)
    || ['ETH5_UP', 'ETH5_CARRIER', 'STICK_REACHABLE', 'AUTO0'].some(key => (
      !['true', 'false'].includes(values[key])
    ))) {
    throw new RouterConsumerError('router_rollback_incomplete');
  }
  const verified = values.UBUS === 'ok'
    && values.WAN_UP === 'false'
    && values.WAN_PENDING === 'false'
    && values.WAN_DEVICE === 'eth5'
    && values.PPPD === 'absent'
    && values.ETH5_UP === 'true'
    && values.ETH5_CARRIER === 'true'
    && values.STICK_REACHABLE === 'true'
    && values.AUTO0 === 'true';
  if ((values.ROLLBACK === 'ready') !== verified) {
    throw new RouterConsumerError('router_rollback_incomplete');
  }
  return {
    gate: values.ROLLBACK,
    ubus: values.UBUS,
    wanUp: values.WAN_UP,
    wanPending: values.WAN_PENDING,
    wanDevice: values.WAN_DEVICE,
    pppd: values.PPPD,
    eth5Up: values.ETH5_UP,
    eth5Carrier: values.ETH5_CARRIER,
    stickReachable: values.STICK_REACHABLE,
    auto0: values.AUTO0,
    reason: verified ? 'router_rollback_verified' : 'router_rollback_failed',
  };
}

function parseCommit(stdout) {
  const values = parsePairs(
    structuredLines(stdout, COMMIT_MARKER, 'router_commit_incomplete'),
    new Set(['COMMIT']),
    'router_commit_incomplete',
  );
  if (!['ready', 'blocked'].includes(values.COMMIT)) {
    throw new RouterConsumerError('router_commit_incomplete');
  }
  return {
    gate: values.COMMIT,
    reason: values.COMMIT === 'ready' ? 'router_commit_verified' : 'router_commit_failed',
  };
}

async function runRouterCommit({
  controlSocket,
  host,
  ownershipToken,
  executeFile,
}) {
  try {
    await requireControlMaster({ controlSocket, host, executeFile });
    const { stdout } = await runRemote({
      controlSocket,
      host,
      command: buildRouterCommitScript(ownershipToken),
      timeout: 10_000,
      executeFile,
      errorCode: 'router_commit_incomplete',
    });
    return parseCommit(stdout);
  } catch {
    return { gate: 'blocked', reason: 'router_commit_incomplete' };
  }
}

export async function runRouterRollback({
  controlSocket,
  host,
  ownershipToken,
  executeFile = execFileAsync,
}) {
  if (!OWNERSHIP_TOKEN_PATTERN.test(ownershipToken ?? '')) {
    return blockedRollbackResult('router_rollback_ownership_required');
  }
  try {
    await requireControlMaster({ controlSocket, host, executeFile });
    const { stdout } = await runRemote({
      controlSocket,
      host,
      command: buildRouterRollbackScript(ownershipToken),
      timeout: ROUTER_ROLLBACK_TIMEOUT_MS,
      executeFile,
      errorCode: 'router_rollback_incomplete',
    });
    return parseRollback(stdout);
  } catch {
    return blockedRollbackResult('router_rollback_incomplete');
  }
}

function parseProbe(stdout) {
  const values = parsePairs(
    structuredLines(stdout, PROBE_MARKER, 'router_probe_incomplete'),
    new Set([
      'ROUTER_CONSUMER',
      'PRECHECK',
      'IFUP_OK',
      'PADO',
      'WAN_IPV4',
      'DNS',
      'HTTP',
      'ROUTE',
      'ROLLBACK',
      'LOCK',
    ]),
    'router_probe_incomplete',
  );
  const booleanKeys = ['WAN_IPV4', 'DNS', 'HTTP', 'ROUTE'];
  if (!['ready', 'blocked'].includes(values.ROUTER_CONSUMER)
    || !PREFLIGHT_REASONS.has(values.PRECHECK)
    || !['true', 'false'].includes(values.IFUP_OK)
    || !['confirmed_by_session', 'no_pado', 'unknown'].includes(values.PADO)
    || booleanKeys.some(key => !['true', 'false'].includes(values[key]))
    || !['not_required', 'ready', 'blocked'].includes(values.ROLLBACK)
    || !['not_acquired', 'released', 'retained', 'release_failed'].includes(values.LOCK)) {
    throw new RouterConsumerError('router_probe_incomplete');
  }
  const ready = values.ROUTER_CONSUMER === 'ready';
  const allConsumerChecksReady = booleanKeys.every(key => values[key] === 'true');
  const precheckReady = values.PRECHECK === 'ready';
  if ((ready && (
    !precheckReady
    || values.IFUP_OK !== 'true'
    || !allConsumerChecksReady
    || values.ROLLBACK !== 'not_required'
    || values.LOCK !== 'retained'
  ))
    || (!ready && precheckReady && values.ROLLBACK === 'not_required')
    || (!ready && precheckReady && values.ROLLBACK === 'blocked' && values.LOCK !== 'retained')
    || (!ready && precheckReady && values.ROLLBACK === 'ready' && values.LOCK !== 'released')
    || (!ready && !precheckReady && (
      values.IFUP_OK !== 'false'
      || booleanKeys.some(key => values[key] !== 'false')
      || values.PADO !== 'unknown'
      || values.ROLLBACK !== 'not_required'
    ))
    || (values.PRECHECK === 'lock_busy' && values.LOCK !== 'not_acquired')
    || (values.PRECHECK !== 'lock_busy' && values.LOCK === 'not_acquired')
    || (!precheckReady && values.PRECHECK !== 'lock_busy' && values.LOCK !== 'released')
    || (values.WAN_IPV4 === 'true') !== (values.PADO === 'confirmed_by_session')
    || (values.PADO === 'no_pado' && values.WAN_IPV4 !== 'false')
  ) {
    throw new RouterConsumerError('router_probe_incomplete');
  }
  return {
    gate: values.ROUTER_CONSUMER,
    precheck: values.PRECHECK,
    ifupOk: values.IFUP_OK === 'true',
    pado: values.PADO,
    wanIpv4: values.WAN_IPV4 === 'true',
    dns: values.DNS === 'true',
    http: values.HTTP === 'true',
    route: values.ROUTE === 'true',
    rollback: values.ROLLBACK,
    lock: values.LOCK,
    reason: ready ? 'subscriber_service_ready' : 'router_consumer_failed',
  };
}

export async function runRouterWanProbe({
  controlSocket,
  host,
  executeFile = execFileAsync,
  signal,
}) {
  const ownershipToken = randomUUID();
  const cleanupOwnedAttempt = async (result, reason) => {
    const cleanupRetry = await runRouterRollback({
      controlSocket,
      host,
      ownershipToken,
      executeFile,
    });
    return {
      ...result,
      gate: 'blocked',
      rollback: cleanupRetry.gate,
      lock: cleanupRetry.gate === 'ready' ? 'released' : result.lock,
      reason,
      cleanupRetry,
    };
  };
  await requireControlMaster({ controlSocket, host, executeFile });
  try {
    const { stdout } = await runRemote({
      controlSocket,
      host,
      command: buildRouterProbeScript(ownershipToken),
      timeout: ROUTER_PROBE_TIMEOUT_MS,
      executeFile,
      errorCode: 'router_probe_incomplete',
      signal,
    });
    const result = parseProbe(stdout);
    if (result.gate === 'ready') {
      if (signal?.aborted) {
        return cleanupOwnedAttempt(result, 'router_probe_aborted');
      }
      const commit = await runRouterCommit({
        controlSocket,
        host,
        ownershipToken,
        executeFile,
      });
      if (signal?.aborted || commit.gate !== 'ready') {
        return cleanupOwnedAttempt(
          result,
          signal?.aborted ? 'router_probe_aborted' : commit.reason,
        );
      }
      return {
        ...result,
        lock: 'committed',
        commit,
      };
    }
    if (result.gate === 'blocked'
      && result.precheck === 'ready'
      && result.rollback === 'blocked') {
      return cleanupOwnedAttempt(
        result,
        signal?.aborted ? 'router_probe_aborted' : result.reason,
      );
    }
    return result;
  } catch {
    return cleanupOwnedAttempt({
      gate: 'blocked',
      precheck: 'unknown',
      ifupOk: false,
      pado: 'unknown',
      wanIpv4: false,
      dns: false,
      http: false,
      route: false,
      rollback: 'blocked',
      lock: 'unknown',
      reason: 'router_probe_incomplete',
    }, signal?.aborted ? 'router_probe_aborted' : 'router_probe_incomplete');
  }
}
