export const GPON_CONSUMER_MES = [2, 7, 84, 131, 171, 256, 257, 262, 268];

export function parseGponOnuState(raw) {
  return raw.match(/ONU\s+state:\s*[^\r\n(]*\(?(O[1-7])\)?/i)?.[1]?.toUpperCase() ?? null;
}

export function shouldCaptureConsumerSnapshot({
  hasControlSocket,
  once,
  previousState,
  currentState,
  snapshotOnO5,
  lastOmciProvisioningGate,
  lastLocalIngressGate,
}) {
  if (!hasControlSocket) return false;
  return once
    || previousState !== currentState
    || (
      snapshotOnO5
      && currentState === 'O5'
      && (lastOmciProvisioningGate !== 'ready' || lastLocalIngressGate !== 'ready')
  );
}

export function isQualifiedOffFiberPrecut({
  onuState,
  routerPreflightGate,
  sequenceTainted,
  expectedManualVid,
  snapshot,
}) {
  return onuState === 'O1'
    && routerPreflightGate === 'ready'
    && sequenceTainted === false
    && snapshot?.expectedManualVid === expectedManualVid
    && snapshot?.gates?.acquisitionValidated === true
    && snapshot?.gates?.omciAppRunning === true
    && snapshot?.gates?.omciAppSingleProcessGroup === true
    && snapshot?.gates?.vlanProvisioned === false
    && snapshot?.gates?.tcontProvisioned === false
    && snapshot?.gates?.gemProvisioned === false
    && snapshot?.localIngressConfigGate === 'ready'
    && snapshot?.localIngressConsumerGate === 'ready'
    && snapshot?.localIngressGate === 'pending_omci'
    && snapshot?.omciProvisioningGate === 'blocked'
    && snapshot?.subscriberServiceGate === 'pending_omci';
}

function countEntities(text) {
  return text.match(/\bEntity\s*ID\b/gi)?.length ?? 0;
}

function extractMarkedSection(raw, startMarker, endMarker) {
  const start = raw.indexOf(startMarker);
  if (start === -1) return '';
  const contentStart = start + startMarker.length;
  const end = raw.indexOf(endMarker, contentStart);
  return raw.slice(contentStart, end === -1 ? raw.length : end);
}

function parseVlanConfigSection(text) {
  const readInteger = name => {
    const value = text.match(new RegExp(`^${name}=(\\d+)\\s*$`, 'm'))?.[1];
    return value === undefined ? null : Number.parseInt(value, 10);
  };
  return {
    configType: readInteger('VLAN_CFG_TYPE'),
    manualMode: readInteger('VLAN_MANU_MODE'),
    manualVid: readInteger('VLAN_MANU_TAG_VID'),
    manualPriority: readInteger('VLAN_MANU_TAG_PRI'),
  };
}

function effectiveVlanPriority(priority) {
  if (priority === null) return null;
  return priority >= 0 && priority <= 7 ? priority : 0;
}

function parseOmciAppCommandLines(raw) {
  const markerPresent = raw.includes('===OMCI_APP_CMDLINE===');
  const section = extractMarkedSection(raw, '===OMCI_APP_CMDLINE===', '===ME:');
  const readArgument = (command, argument) => {
    const presenceCount = [...command.matchAll(
      new RegExp(`(?:^|\\s)${argument}(?=\\s|$)`, 'g'),
    )].length;
    const valueMatches = [...command.matchAll(
      new RegExp(`(?:^|\\s)${argument}\\s+(\\d+)(?=\\s|$)`, 'g'),
    )];
    return {
      presenceCount,
      value: presenceCount === 1 && valueMatches.length === 1
        ? Number.parseInt(valueMatches[0][1], 10)
        : null,
    };
  };
  const entries = [...section.matchAll(/^PID=(\d+)\s+TGID=(\d*)(?:\s+PPID=(\d*))?\s+CMDLINE=(.*)$/gm)]
    .map(match => {
      const command = match[4].trim();
      const manualType = readArgument(command, '-iot_vt');
      const manualMode = readArgument(command, '-iot_vm');
      const manualVid = readArgument(command, '-iot_vid');
      const manualPriority = readArgument(command, '-iot_pri');
      return {
        pid: Number.parseInt(match[1], 10),
        tgid: match[2] === '' ? null : Number.parseInt(match[2], 10),
        ppid: match[3] === undefined || match[3] === '' ? null : Number.parseInt(match[3], 10),
        command,
        isOmciApp: /(?:^|\/)omci_app(?:\s|$)/.test(command),
        manualType: manualType.value,
        manualTypePresenceCount: manualType.presenceCount,
        manualMode: manualMode.value,
        manualModePresenceCount: manualMode.presenceCount,
        manualVid: manualVid.value,
        manualVidPresenceCount: manualVid.presenceCount,
        manualPriority: manualPriority.value,
        manualPriorityPresenceCount: manualPriority.presenceCount,
      };
    });
  return { markerPresent, entries };
}

export function parseGponConsumerSnapshot(
  raw,
  { expectedManualVid = null, acquisitionValidated = false } = {},
) {
  const sections = {};
  const marker = /^===ME:(\d+)===$/gm;
  const matches = [...raw.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const classId = matches[index][1];
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? raw.length;
    sections[classId] = raw.slice(start, end);
  }

  const entityCounts = Object.fromEntries(
    GPON_CONSUMER_MES.map(classId => [classId, countEntities(sections[classId] ?? '')]),
  );
  const allocIds = [...(sections['262'] ?? '').matchAll(/Alloc(?:\s*|-)?I[Dd]\s*[:=]\s*(0x[0-9a-f]+|\d+)/gi)]
    .map(match => match[1]);
  const usableAllocIds = allocIds.filter(value => {
    const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
    return Number.isFinite(parsed) && parsed !== 0xff && parsed !== 0xffff;
  });
  const provisionedVlanIds = [...(sections['84'] ?? '').matchAll(/\bVID\s+(\d+)\b/gi)]
    .map(match => Number.parseInt(match[1], 10))
    .filter((value, index, values) => value >= 1 && value <= 4094 && values.indexOf(value) === index);
  const flashVlanConfig = parseVlanConfigSection(extractMarkedSection(
    raw,
    '===LOCAL_VLAN_FLASH===',
    '===LOCAL_VLAN_MIB===',
  ));
  const runtimeVlanConfig = parseVlanConfigSection(extractMarkedSection(
    raw,
    '===LOCAL_VLAN_MIB===',
    '===ME:',
  ));
  const omciAppCommandLines = parseOmciAppCommandLines(raw);
  const omciAppEntries = omciAppCommandLines.entries.filter(entry => entry.isOmciApp);
  const omciAppPids = new Set(omciAppEntries.map(entry => entry.pid));
  const hasParentEvidence = omciAppEntries.length > 0
    && omciAppEntries.every(entry => entry.ppid !== null);
  const omciAppProcessGroups = hasParentEvidence
    ? omciAppEntries.filter(entry => !omciAppPids.has(entry.ppid)).map(entry => entry.pid)
    : [...new Set(omciAppEntries.map(entry => entry.tgid ?? entry.pid))];
  const localVlanEvidencePresent = [flashVlanConfig, runtimeVlanConfig].every(config => (
    config.configType !== null
    && config.manualMode !== null
    && config.manualVid !== null
    && config.manualPriority !== null
  ));
  const localIngressConfigReady = localVlanEvidencePresent
    && flashVlanConfig.configType === 1
    && runtimeVlanConfig.configType === 1
    && flashVlanConfig.manualMode === 1
    && runtimeVlanConfig.manualMode === 1
    && flashVlanConfig.manualVid === runtimeVlanConfig.manualVid
    && flashVlanConfig.manualPriority === runtimeVlanConfig.manualPriority
    && runtimeVlanConfig.manualVid >= 1
    && runtimeVlanConfig.manualVid <= 4094
    && (expectedManualVid === null || runtimeVlanConfig.manualVid === expectedManualVid);
  const explicitOmciAppConsumers = omciAppEntries.filter(entry => (
    entry.manualTypePresenceCount > 0
    || entry.manualModePresenceCount > 0
    || entry.manualVidPresenceCount > 0
    || entry.manualPriorityPresenceCount > 0
  ));
  const exactOmciAppConsumer = explicitOmciAppConsumers.length === omciAppEntries.length
    && explicitOmciAppConsumers.length > 0
    && explicitOmciAppConsumers.every(entry => (
      entry.manualType === 1
      && entry.manualTypePresenceCount === 1
      && entry.manualMode === 1
      && entry.manualModePresenceCount === 1
      && entry.manualVid === runtimeVlanConfig.manualVid
      && entry.manualVidPresenceCount === 1
      && entry.manualPriority === runtimeVlanConfig.manualPriority
      && entry.manualPriorityPresenceCount === 1
    ));
  const argvElidedForSingleBootLineage = hasParentEvidence
    && omciAppProcessGroups.length === 1
    && omciAppEntries.find(entry => entry.pid === omciAppProcessGroups[0])?.ppid === 1
    && omciAppEntries.every(entry => (
      entry.manualTypePresenceCount === 0
      && entry.manualModePresenceCount === 0
      && entry.manualVidPresenceCount === 0
      && entry.manualPriorityPresenceCount === 0
    ));
  const omciAppConsumersLocalVlan = localIngressConfigReady
    && omciAppProcessGroups.length === 1
    && (exactOmciAppConsumer || argvElidedForSingleBootLineage);
  const localIngressConsumerGate = !omciAppCommandLines.markerPresent
    ? 'unknown'
    : !localIngressConfigReady || !omciAppConsumersLocalVlan
      ? 'blocked'
      : 'ready';
  const localIngressReady = localIngressConfigReady
    && localIngressConsumerGate !== 'blocked'
    && (expectedManualVid === null || localIngressConsumerGate === 'ready');
  const localIngressGate = !localVlanEvidencePresent
    ? expectedManualVid === null ? 'unknown' : 'blocked'
    : !localIngressReady
      ? 'blocked'
      : provisionedVlanIds.length === 0
        ? 'pending_omci'
        : provisionedVlanIds.includes(runtimeVlanConfig.manualVid)
          ? 'ready'
          : 'blocked';
  const gates = {
    acquisitionValidated,
    omciAppRunning: acquisitionValidated
      && omciAppCommandLines.markerPresent
      && omciAppEntries.length > 0,
    omciAppSingleProcessGroup: acquisitionValidated
      && omciAppCommandLines.markerPresent
      && omciAppProcessGroups.length === 1,
    vlanProvisioned: acquisitionValidated && entityCounts['84'] + entityCounts['171'] > 0,
    tcontProvisioned: acquisitionValidated && usableAllocIds.length > 0,
    gemProvisioned: acquisitionValidated && entityCounts['268'] > 0,
  };
  const omciProvisioningGate = Object.values(gates).every(Boolean) ? 'ready' : 'blocked';
  const subscriberServiceGate = localIngressGate === 'blocked'
    ? 'blocked_local_ingress'
    : omciProvisioningGate !== 'ready'
      ? 'pending_omci'
      : localIngressGate !== 'ready'
        ? 'pending_local_ingress'
        : 'pending_router_consumer';

  return {
    entityCounts,
    allocIds,
    usableAllocIds,
    provisionedVlanIds,
    localVlanConfig: {
      flash: {
        ...flashVlanConfig,
        effectiveManualPriority: effectiveVlanPriority(flashVlanConfig.manualPriority),
      },
      runtime: {
        ...runtimeVlanConfig,
        effectiveManualPriority: effectiveVlanPriority(runtimeVlanConfig.manualPriority),
      },
    },
    omciAppCommandLines: {
      markerPresent: omciAppCommandLines.markerPresent,
      entries: omciAppCommandLines.entries.map(entry => ({
        pid: entry.pid,
        tgid: entry.tgid,
        ppid: entry.ppid,
        isOmciApp: entry.isOmciApp,
        manualType: entry.manualType,
        manualTypePresenceCount: entry.manualTypePresenceCount,
        manualMode: entry.manualMode,
        manualModePresenceCount: entry.manualModePresenceCount,
        manualVid: entry.manualVid,
        manualVidPresenceCount: entry.manualVidPresenceCount,
        manualPriority: entry.manualPriority,
        manualPriorityPresenceCount: entry.manualPriorityPresenceCount,
      })),
      processGroups: omciAppProcessGroups,
      consumerEvidence: exactOmciAppConsumer
        ? 'exact_argv'
        : argvElidedForSingleBootLineage
          ? 'single_boot_lineage_argv_elided'
          : 'unqualified',
    },
    expectedManualVid,
    localIngressConfigGate: localIngressConfigReady
      ? 'ready'
      : (localVlanEvidencePresent || expectedManualVid !== null ? 'blocked' : 'unknown'),
    localIngressConsumerGate,
    localIngressGate,
    gates,
    omciProvisioningGate,
    subscriberServiceGate,
  };
}
