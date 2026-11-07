import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isQualifiedOffFiberPrecut,
  parseGponConsumerSnapshot as parseUnvalidatedGponConsumerSnapshot,
  parseGponOnuState,
  shouldCaptureConsumerSnapshot,
} from '../lib/gpon-consumer-gate.js';

function parseGponConsumerSnapshot(raw, options = {}) {
  return parseUnvalidatedGponConsumerSnapshot(raw, {
    ...options,
    acquisitionValidated: true,
  });
}

test('parses RTL960x diag ONU state output', () => {
  assert.equal(parseGponOnuState('ONU state: Initial State(O1)\nRTK.0>'), 'O1');
  assert.equal(parseGponOnuState('ONU state: Operation State(O5)'), 'O5');
  assert.equal(parseGponOnuState('unrelated output'), null);
});

test('O5 snapshot repeats until both prerequisite gates are ready', () => {
  const base = {
    hasControlSocket: true,
    once: false,
    previousState: 'O5',
    currentState: 'O5',
    snapshotOnO5: true,
  };
  assert.equal(shouldCaptureConsumerSnapshot({
    ...base,
    lastOmciProvisioningGate: 'blocked',
    lastLocalIngressGate: 'ready',
  }), true);
  assert.equal(shouldCaptureConsumerSnapshot({
    ...base,
    lastOmciProvisioningGate: 'ready',
    lastLocalIngressGate: 'blocked',
  }), true);
  assert.equal(shouldCaptureConsumerSnapshot({
    ...base,
    lastOmciProvisioningGate: 'ready',
    lastLocalIngressGate: 'ready',
  }), false);
  assert.equal(shouldCaptureConsumerSnapshot({
    ...base,
    hasControlSocket: false,
    previousState: 'O4',
    lastOmciProvisioningGate: 'blocked',
    lastLocalIngressGate: 'blocked',
  }), false);
  assert.equal(shouldCaptureConsumerSnapshot({
    ...base,
    previousState: 'O4',
    lastOmciProvisioningGate: 'ready',
    lastLocalIngressGate: 'ready',
  }), true);
});

test('direct parser use cannot qualify unvalidated acquisition output', () => {
  const result = parseUnvalidatedGponConsumerSnapshot(`
===OMCI_APP_CMDLINE===
PID=123 TGID=123 PPID=1 CMDLINE=omci_app
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`);

  assert.equal(result.gates.acquisitionValidated, false);
  assert.equal(result.gates.omciAppRunning, false);
  assert.equal(result.omciProvisioningGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'pending_omci');
});

test('off-fiber pre-cut requires a clean same-run O1 with qualified local ingress', () => {
  const snapshot = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app
`, { expectedManualVid: 2769 });
  const base = {
    onuState: 'O1',
    routerPreflightGate: 'ready',
    sequenceTainted: false,
    expectedManualVid: 2769,
    snapshot,
  };

  assert.equal(isQualifiedOffFiberPrecut(base), true);
  assert.equal(isQualifiedOffFiberPrecut({ ...base, onuState: 'O5' }), false);
  assert.equal(isQualifiedOffFiberPrecut({ ...base, sequenceTainted: true }), false);
  assert.equal(isQualifiedOffFiberPrecut({ ...base, routerPreflightGate: 'blocked' }), false);
  assert.equal(isQualifiedOffFiberPrecut({ ...base, expectedManualVid: 2770 }), false);
  assert.equal(isQualifiedOffFiberPrecut({
    ...base,
    snapshot: {
      ...snapshot,
      localIngressConfigGate: 'blocked',
      localIngressConsumerGate: 'blocked',
      localIngressGate: 'blocked',
    },
  }), false);
  assert.equal(isQualifiedOffFiberPrecut({
    ...base,
    snapshot: {
      ...snapshot,
      gates: { ...snapshot.gates, acquisitionValidated: false },
    },
  }), false);
});

test('O5-era empty service objects remain blocked', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
===OMCI_APP_CMDLINE===
PID=123 TGID=123 PPID=1 CMDLINE=omci_app
===ME:84===
VlanTagFilterData
===ME:171===
ExtVlanTagOperCfgData
===ME:262===
Tcont
EntityID: 0x8000
AllocID: 0x00ff
EntityID: 0x8001
AllocID: 0xffff
===ME:268===
GemPortCtp
`);

  assert.equal(result.omciProvisioningGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'pending_omci');
  assert.equal(result.gates.omciAppRunning, true);
  assert.equal(result.gates.vlanProvisioned, false);
  assert.equal(result.gates.tcontProvisioned, false);
  assert.equal(result.gates.gemProvisioned, false);
});

test('provisioned OMCI objects pass only the OMCI prerequisite gate', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
===OMCI_APP_CMDLINE===
PID=123 TGID=123 PPID=1 CMDLINE=omci_app
===ME:84===
VlanTagFilterData
EntityID: 0x01
FilterTbl[0]: PRI 0,CFI 0, VID 1593
===ME:171===
ExtVlanTagOperCfgData
===ME:262===
Tcont
EntityID: 0x8001
AllocId: 0x0108
===ME:268===
GemPortCtp
EntityId: 0x07fe
PortID: 2046
`);

  assert.equal(result.omciProvisioningGate, 'ready');
  assert.equal(result.subscriberServiceGate, 'pending_local_ingress');
  assert.deepEqual(result.usableAllocIds, ['0x0108']);
  assert.equal(result.localIngressGate, 'unknown');
});

test('provisioned OMCI remains blocked when the local ONU ingress is still auto', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
===OMCI_APP_CMDLINE===
PID=123 TGID=123 PPID=1 CMDLINE=omci_app
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=0
VLAN_MANU_MODE=0
VLAN_MANU_TAG_VID=65535
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=0
VLAN_MANU_MODE=0
VLAN_MANU_TAG_VID=65535
VLAN_MANU_TAG_PRI=255
===ME:84===
VlanTagFilterData
EntityID: 0x02
FilterTbl[0]: PRI 0,CFI 0, VID 2770
===ME:171===
ExtVlanTagOperCfgData
EntityID: 0x301
===ME:262===
Tcont
EntityID: 0x8000
AllocID: 0x0103
===ME:268===
GemPortCtp
EntityID: 0x0110
`);

  assert.equal(result.omciProvisioningGate, 'ready');
  assert.equal(result.localIngressGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('manual ONU ingress passes only when its VID is provisioned by ME84', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
123 omci_app
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=123 TGID=123 CMDLINE=/bin/omci_app -s -iot_vt 1 -iot_vm 1 -iot_vid 2770 -iot_pri 255
===ME:84===
VlanTagFilterData
EntityID: 0x02
FilterTbl[0]: PRI 0,CFI 0, VID 2770
EntityID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
ExtVlanTagOperCfgData
EntityID: 0x301
===ME:262===
Tcont
EntityID: 0x8000
AllocID: 0x0103
===ME:268===
GemPortCtp
EntityID: 0x0110
`);

  assert.deepEqual(result.provisionedVlanIds, [2770, 2769]);
  assert.equal(result.localVlanConfig.flash.manualVid, 2770);
  assert.equal(result.localVlanConfig.runtime.manualVid, 2770);
  assert.equal(result.localIngressGate, 'ready');
  assert.equal(result.subscriberServiceGate, 'pending_router_consumer');
});

test('expected Manual PVID blocks a different provisioned ME84 VID', () => {
  const raw = `
===PROC===
123 omci_app
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=123 TGID=123 CMDLINE=/bin/omci_app -s -iot_vt 1 -iot_vm 1 -iot_vid 2770 -iot_pri 255
===ME:84===
VlanTagFilterData
EntityID: 0x02
FilterTbl[0]: PRI 0,CFI 0, VID 2770
EntityID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
ExtVlanTagOperCfgData
EntityID: 0x0301
===ME:262===
Tcont
EntityID: 0x8000
AllocID: 0x0103
===ME:268===
GemPortCtp
EntityID: 0x0110
`;

  const wrong = parseGponConsumerSnapshot(raw, { expectedManualVid: 2769 });
  assert.equal(wrong.expectedManualVid, 2769);
  assert.equal(wrong.localIngressConfigGate, 'blocked');
  assert.equal(wrong.localIngressGate, 'blocked');
  assert.equal(wrong.subscriberServiceGate, 'blocked_local_ingress');

  const matching = parseGponConsumerSnapshot(
    raw
      .replaceAll('VLAN_MANU_TAG_VID=2770', 'VLAN_MANU_TAG_VID=2769')
      .replace('-iot_vid 2770', '-iot_vid 2769'),
    { expectedManualVid: 2769 },
  );
  assert.equal(matching.localIngressConfigGate, 'ready');
  assert.equal(matching.localIngressConsumerGate, 'ready');
  assert.equal(matching.localIngressGate, 'ready');
  assert.equal(matching.localVlanConfig.runtime.effectiveManualPriority, 0);
});

test('expected Manual PVID fails closed when omci_app still consumes another VID', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
123 omci_app
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=123 TGID=123 CMDLINE=/bin/omci_app -s -iot_vt 1 -iot_vm 1 -iot_vid 2770 -iot_pri 255
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
`, { expectedManualVid: 2769 });

  assert.equal(result.localIngressConfigGate, 'ready');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.localIngressGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('conflicting explicit argv in one omci_app lineage fails closed', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_pri 255
PID=590 TGID=590 PPID=321 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2770 -iot_pri 255
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [321]);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.localIngressGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('partial explicit argv in one omci_app lineage fails closed', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_pri 255
PID=590 TGID=590 PPID=321 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [321]);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.localIngressGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('duplicate iot argument in one omci_app command line fails closed', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_vid 2770 -iot_pri 255
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.equal(result.omciAppCommandLines.entries[0].manualVid, null);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('one valid and one malformed duplicate iot argument fails closed', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_vid BAD -iot_pri 255
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.equal(result.omciAppCommandLines.entries[0].manualVid, null);
  assert.equal(result.omciAppCommandLines.entries[0].manualVidPresenceCount, 2);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
});

test('malformed present iot flags cannot qualify as argv-elided', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt BAD -iot_vm BAD -iot_vid BAD -iot_pri BAD
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  const [entry] = result.omciAppCommandLines.entries;
  assert.equal(entry.manualType, null);
  assert.equal(entry.manualTypePresenceCount, 1);
  assert.equal(entry.manualVid, null);
  assert.equal(entry.manualVidPresenceCount, 1);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('an exact argv process cannot hide an argv-elided sibling in the same lineage', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_pri 255
PID=590 TGID=590 PPID=321 CMDLINE=omci_app
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [321]);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('multiple omci_app process groups fail the consumer and provisioning gates', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=123 TGID=123 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_pri 255
PID=456 TGID=456 CMDLINE=omci_app -iot_vt 1 -iot_vm 1 -iot_vid 2769 -iot_pri 255
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
===ME:171===
Entity ID: 0x0301
===ME:262===
Entity ID: 0x8000
AllocID: 0x0103
===ME:268===
Entity ID: 0x0110
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [123, 456]);
  assert.equal(result.gates.omciAppSingleProcessGroup, false);
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.omciProvisioningGate, 'blocked');
});

test('cold-boot omci_app fork tree is one launch lineage when argv is elided', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=590 TGID=590 PPID=477 CMDLINE=omci_app
PID=477 TGID=477 PPID=321 CMDLINE=omci_app
PID=321 TGID=321 PPID=1 CMDLINE=omci_app
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [321]);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'single_boot_lineage_argv_elided');
  assert.equal(result.localIngressConfigGate, 'ready');
  assert.equal(result.localIngressConsumerGate, 'ready');
  assert.equal(result.localIngressGate, 'pending_omci');
});

test('two argv-elided omci_app roots remain blocked as duplicate launchers', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
VLAN_MANU_TAG_PRI=255
===OMCI_APP_CMDLINE===
PID=321 TGID=321 PPID=1 CMDLINE=omci_app
PID=654 TGID=654 PPID=1 CMDLINE=omci_app
`, { expectedManualVid: 2769 });

  assert.deepEqual(result.omciAppCommandLines.processGroups, [321, 654]);
  assert.equal(result.omciAppCommandLines.consumerEvidence, 'unqualified');
  assert.equal(result.localIngressConsumerGate, 'blocked');
});

test('missing Manual priority key cannot pass the local-ingress gate', () => {
  const result = parseGponConsumerSnapshot(`
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2769
===OMCI_APP_CMDLINE===
PID=123 TGID=123 CMDLINE=/bin/omci_app -s -iot_vt 1 -iot_vm 1 -iot_vid 2769
===ME:84===
Entity ID: 0x03
FilterTbl[0]: PRI 0,CFI 0, VID 2769
`, { expectedManualVid: 2769 });

  assert.equal(result.localIngressConfigGate, 'blocked');
  assert.equal(result.localIngressConsumerGate, 'blocked');
  assert.equal(result.localIngressGate, 'blocked');
  assert.equal(result.subscriberServiceGate, 'blocked_local_ingress');
});

test('manual ONU ingress remains prepared while off-fiber OMCI has no VLAN objects', () => {
  const result = parseGponConsumerSnapshot(`
===PROC===
123 omci_app
===LOCAL_VLAN_FLASH===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===LOCAL_VLAN_MIB===
VLAN_CFG_TYPE=1
VLAN_MANU_MODE=1
VLAN_MANU_TAG_VID=2770
VLAN_MANU_TAG_PRI=255
===ME:84===
VlanTagFilterData
===ME:171===
ExtVlanTagOperCfgData
===ME:262===
Tcont
EntityID: 0x8000
AllocID: 0x00ff
===ME:268===
GemPortCtp
`);

  assert.equal(result.localIngressConfigGate, 'ready');
  assert.equal(result.localIngressGate, 'pending_omci');
  assert.equal(result.subscriberServiceGate, 'pending_omci');
});
