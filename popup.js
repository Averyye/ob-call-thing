const form = document.querySelector('#lookup-form');
// ui refs upfront so handlers dont keep querying dom over n over
const shell = document.querySelector('.shell');
const popupBody = document.body;
const layout = document.querySelector('.layout');
const input = document.querySelector('#customer-number');
const button = document.querySelector('#lookup-button');
const dialButton = document.querySelector('#dial-button');
const openSessionSetupButton = document.querySelector('#open-session-setup');
const startSessionButton = document.querySelector('#start-session');
const closeSessionSetupButton = document.querySelector('#close-session-setup');
const sessionSetupPanel = document.querySelector('#session-setup');
const dispositionSelect = document.querySelector('#disposition-select');
const saveDispositionButton = document.querySelector('#save-disposition');
const sessionReadyBadge = document.querySelector('#session-ready-badge');
const sessionPositionBadge = document.querySelector('#session-position-badge');
const status = document.querySelector('#status');
const inlineStatus = document.querySelector('#status-inline');
const results = document.querySelector('#results');
const lookupLoadingScreen = document.querySelector('#lookup-loading-screen');
// by Mo and Avery

const assignmentTargetInput = document.querySelector('#assignment-target');
const pullPreviousBillingNumberButton = document.querySelector('#pull-previous-billing-number');
const pullNextBillingNumberButton = document.querySelector('#pull-next-billing-number');
const pastedRowsInput = document.querySelector('#pasted-rows');
const runRenewalAutocheckButton = document.querySelector('#run-renewal-autocheck');
const stopRenewalAutocheckButton = document.querySelector('#stop-renewal-autocheck');
const renewedResults = document.querySelector('#renewed-results');
const renewalCurrent = document.querySelector('#renewal-current');
const renewedSummary = document.querySelector('#renewed-summary');
const renewedList = document.querySelector('#renewed-list');
const unknownSummary = document.querySelector('#unknown-summary');
const unknownList = document.querySelector('#unknown-list');
const callTemplate = document.querySelector('#call-template');
const copyCallTemplateButton = document.querySelector('#copy-call-template');

let isBatchRunning = false;
let isSingleLookupRunning = false;
let hasDisplayedLookupResult = false;
let pastedRowsPersistTimer = null;
let nextLookupRequestId = 1;
let activeSingleLookupRequestId = '';
let resizeSyncFrame = 0;
const COMPACT_POPUP_WIDTH_PX = 430;
const SETUP_POPUP_WIDTH_PX = 520;
const RESULTS_POPUP_WIDTH_PX = 780;
const NEXT_BILLING_AUTO_LOOKUP_DELAY_MS = 200;
const SESSION_POSITION_KEY = 'sessionRowPosition';
const LAST_BATCH_KEY = 'lastRenewalRadarResult';
const LAST_VIEW_MODE_KEY = 'lastDisplayMode';
const DISPOSITION_LOG_KEY = 'dispositionLogs';
const SHARPEN_CALL_ID_PREFIX_REGEX = /^id\s*:\s*/i;
const DISPOSITION_OPTIONS = [
  'voicemail',
  'no voicemail',
  'requested call back',
  'renewed contract',
  'do not call'
];

function syncPopupHeightNow() {
  // force popup frame to track whichever panel is currently visible
  const nextWidth = popupBody.classList.contains('lookup-loading')
    ? COMPACT_POPUP_WIDTH_PX
    : popupBody.classList.contains('setup-open')
      ? SETUP_POPUP_WIDTH_PX
      : popupBody.classList.contains('results-open')
        ? RESULTS_POPUP_WIDTH_PX
        : COMPACT_POPUP_WIDTH_PX;

  // Reset explicit height before measuring so popup can shrink after larger prior views.
  document.documentElement.style.height = 'auto';
  document.body.style.height = 'auto';

  const nextHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    Math.ceil((shell?.getBoundingClientRect().height || 0) + 20)
  );

  document.documentElement.style.width = `${nextWidth}px`;
  document.body.style.width = `${nextWidth}px`;
  document.documentElement.style.height = `${nextHeight}px`;
  document.body.style.height = `${nextHeight}px`;
}

function schedulePopupResizeSync() {
  // bunch ui updates can fire in one tick; coalesce into one resize pass
  if (resizeSyncFrame) cancelAnimationFrame(resizeSyncFrame);
  resizeSyncFrame = requestAnimationFrame(() => {
    resizeSyncFrame = 0;
    syncPopupHeightNow();
  });
}

function setResultsOpen(isOpen) {
  // switches compact vs split layout mode
  popupBody.classList.toggle('results-open', isOpen);
  layout.classList.toggle('results-open', isOpen);
  schedulePopupResizeSync();
}

function setSessionReady(isReady) {
  // tiny badge state for whether pasted rows exist
  popupBody.classList.toggle('session-ready', isReady);
  if (sessionReadyBadge) {
    sessionReadyBadge.hidden = !isReady;
  }
}

function setSessionPositionBadge(position, total) {
  // shows current position in filtered billing list
  if (!sessionPositionBadge) return;
  if (!position || !total) {
    sessionPositionBadge.hidden = true;
    sessionPositionBadge.textContent = '';
    return;
  }
  sessionPositionBadge.textContent = `${position}/${total}`;
  sessionPositionBadge.hidden = false;
}

function setLookupLoading(isLoading) {
  // fullscreen loading state while lookup runs
  popupBody.classList.toggle('lookup-loading', isLoading);
  lookupLoadingScreen?.setAttribute('aria-hidden', String(!isLoading));
  schedulePopupResizeSync();
}

function persistSessionPosition(position, total) {
  chrome.storage.local.set({ [SESSION_POSITION_KEY]: { position, total } }).catch(() => {});
}

function clearSessionPosition() {
  setSessionPositionBadge(null, null);
  chrome.storage.local.remove(SESSION_POSITION_KEY).catch(() => {});
}

function setSessionSetupOpen(isOpen) {
  // toggles setup panel where pasted rows are managed
  if (sessionSetupPanel) {
    sessionSetupPanel.hidden = !isOpen;
  }
  if (isOpen) {
    setResultsOpen(false);
  }
  popupBody.classList.toggle('setup-open', isOpen);
  schedulePopupResizeSync();
}

function buildCallTemplate(data = {}, callId = '') {
  // prep one ready-to-paste note block from the latest lookup
  const callerName = String(data?.customerName || '').trim();
  const callFrom = String(data?.phone || '').trim();
  const accountNumber = String(data?.billingNumber || data?.customerNumber || '').trim();
  const resolvedCallId = normalizeSharpenCallId(callId || data?.callId || '');

  return [
    `Caller Name: ${callerName}`,
    `Call ID #: ${resolvedCallId}`,
    `Call From: ${callFrom}`,
    `Account #: ${accountNumber}`,
    'Issue: Contract expiration',
    'Resolution: Voicemail'
  ].join('\n');
}

function populateCallTemplate(data = {}, callId = '') {
  if (!callTemplate) return;
  callTemplate.value = buildCallTemplate(data, callId);
  schedulePopupResizeSync();
}

function normalizeSharpenCallId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(SHARPEN_CALL_ID_PREFIX_REGEX, '').trim();
}

async function persistCallIdForLatestLookup(callId) {
  const normalizedCallId = normalizeSharpenCallId(callId);
  if (!normalizedCallId) return false;

  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (!lastResult) return false;

  const updatedLastResult = { ...lastResult, callId: normalizedCallId };
  await chrome.storage.session.set({ lastResult: updatedLastResult });
  populateCallTemplate(updatedLastResult, normalizedCallId);
  return true;
}

async function copyCallTemplateToClipboard() {
  if (!callTemplate) return;
  const textToCopy = String(callTemplate.value || '').trim();
  if (!textToCopy) throw new Error('Call template is empty.');

  try {
    await navigator.clipboard.writeText(callTemplate.value);
    return;
  } catch {
    callTemplate.focus();
    callTemplate.select();
    const copied = document.execCommand('copy');
    callTemplate.setSelectionRange(callTemplate.value.length, callTemplate.value.length);
    if (!copied) throw new Error('Could not copy the template.');
  }
}

const fields = [
  ['Customer', 'customerName'],
  ['Customer summary groups', 'customerSummaryGroups'],
  ['Phone', 'phone'],
  ['Billing number', 'billingNumber'],
  ['Status', 'accountStatus'],
  ['Current contract ends', 'currentContractEnd'],
  ['Renewal starts', 'renewalStart'],
  ['Renewal ends', 'renewalEnd'],
  ['Renewal status', 'renewalStatus']
];

function setStatus(message, type = '') {
  // mirrored status in compact and results views
  status.textContent = message;
  status.className = `status ${type}`;
  if (inlineStatus) {
    inlineStatus.textContent = message;
    inlineStatus.className = `status ${type}`;
  }
}

/* by Mo and Avery */

function persistDisplayMode(mode) {
  // remembers whether user last saw single result or batch result
  chrome.storage.session.set({ [LAST_VIEW_MODE_KEY]: mode }).catch(() => {});
}

function persistBatchSnapshot(renewedEntries, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount) {
  // stores latest radar summary so popup restore feels instant
  chrome.storage.session.set({
    [LAST_BATCH_KEY]: {
      renewedEntries,
      notRenewedCount,
      unknownEntries,
      totalCount,
      retryRecoveredCount,
      savedAt: Date.now()
    },
    [LAST_VIEW_MODE_KEY]: 'batch'
  }).catch(() => {});
}

function statusTone(accountStatus) {
  // maps status text -> visual color tone in results row
  const value = String(accountStatus || '').toLowerCase();
  if (!value) return 'muted';
  if (value.includes('inactive') || value.includes('closed') || value.includes('cancel')) return 'bad';

  const compact = value.replace(/\s+/g, ' ').trim();
  const isPureActive = compact === 'active';
  const isActiveFlowing = compact === 'active/flowing';
  if (isPureActive || isActiveFlowing) return 'good';

  // Any non-empty state that is not purely Active and not closed-like is treated as in-between.
  return 'warn';
}

// Only show the renewal start/end boxes when the customer is currently on a
// contract that's about to expire AND has already renewed with us. If there's
// no renewal on file, those two rows are omitted entirely rather than shown
// as "Not found".
function shouldShowRenewalWindow(data) {
  const status = String(data?.renewalStatus || '').toLowerCase();
  const hasRenewedStatus = status.includes('renewed');
  return hasRenewedStatus && Boolean(data?.renewalStart) && Boolean(data?.renewalEnd);
}

function render(data) {
  // single-lookup render path
  setResultsOpen(true);
  results.replaceChildren();
  const renewalWindowVisible = shouldShowRenewalWindow(data);
  let renderedIndex = 0;
  for (const [label, key] of fields) {
    if ((key === 'renewalStart' || key === 'renewalEnd') && !renewalWindowVisible) continue;
    const index = renderedIndex++;
    const row = document.createElement('div');
    row.className = 'result-row result-row-enter';
    row.style.animationDelay = `${index * 35}ms`;
    if (key === 'accountStatus') {
      row.classList.add('result-row-status', `status-tone-${statusTone(data[key])}`);
    }
    if (key === 'customerSummaryGroups') {
      row.classList.add('result-row-summary');
    }
    const labelElement = document.createElement('span');
    labelElement.className = 'result-label';
    labelElement.textContent = label;

    const value = data[key];
    const valueElement = document.createElement(key === 'customerSummaryGroups' ? 'div' : 'span');
    valueElement.className = `result-value${value ? '' : ' muted'}`;

    if (key === 'customerSummaryGroups' && value) {
      valueElement.classList.add('summary-groups-value');
      const segments = String(value)
        .split('|')
        .map((segment) => segment.trim())
        .filter(Boolean);

      if (segments.length) {
        for (const segment of segments) {
          const pill = document.createElement('span');
          pill.className = 'summary-pill';
          pill.textContent = segment;
          valueElement.append(pill);
        }
      } else {
        valueElement.textContent = String(value);
      }
    } else {
      valueElement.textContent = value || 'Not found';
    }

    row.append(labelElement, valueElement);
    results.append(row);
  }

  if (data.manualReviewAlert) {
    const row = document.createElement('div');
    row.className = 'result-row result-row-alert result-row-enter';
    const labelElement = document.createElement('span');
    labelElement.className = 'result-label';
    labelElement.textContent = 'Manual check';
    const valueElement = document.createElement('span');
    valueElement.className = 'result-value';
    valueElement.textContent = String(data.manualReviewAlert);
    row.append(labelElement, valueElement);
    results.append(row);
  }

  results.hidden = false;
  schedulePopupResizeSync();
}

function renderRenewedBatchResults(renewedEntries, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount = 0) {
  // batch/radar render path
  setResultsOpen(true);
  renewedList.replaceChildren();
  unknownList.replaceChildren();

  for (const entry of renewedEntries) {
    renewedList.append(createRenewedListItem(entry));
  }

  renewedSummary.textContent = `${renewedEntries.length} Renewed/Active, ${notRenewedCount} No renewal, ${unknownEntries.length} Unknown (${totalCount} total). Retry recovered: ${retryRecoveredCount}.`;

  if (unknownEntries.length) {
    for (const entry of unknownEntries) {
      const item = document.createElement('li');
      item.textContent = `${entry.billingNumber} - Unknown (${entry.reason})`;
      unknownList.append(item);
    }
    unknownSummary.textContent = 'Unknown cases';
    unknownSummary.hidden = false;
    unknownList.hidden = false;
  } else {
    unknownSummary.hidden = true;
    unknownList.hidden = true;
  }

  renewedResults.hidden = false;
  schedulePopupResizeSync();
}

function createRenewedListItem(entry) {
  const item = document.createElement('li');
  const namePart = entry.customerName ? ` - ${entry.customerName}` : '';
  const statusPart = entry.accountStatus ? ` [${entry.accountStatus}]` : '';
  item.textContent = `${entry.billingNumber}${namePart}${statusPart}`;
  return item;
}

function createUnknownListItem(entry) {
  const item = document.createElement('li');
  item.textContent = `${entry.billingNumber} - Unknown (${entry.reason})`;
  return item;
}

function renderRenewalRadarProgress(processedCount, totalCount, renewedCount, notRenewedCount, unknownCount, retryRecoveredCount = 0) {
  setResultsOpen(true);
  renewedSummary.textContent = `Processed ${processedCount}/${totalCount}. ${renewedCount} Renewed/Active, ${notRenewedCount} No renewal, ${unknownCount} Unknown. Retry recovered: ${retryRecoveredCount}.`;
  renewedResults.hidden = false;
  schedulePopupResizeSync();
}

function renderRenewalRadarState(state) {
  const renewedEntries = Array.isArray(state?.renewedEntries) ? state.renewedEntries : [];
  const unknownEntries = Array.isArray(state?.unknownEntries) ? state.unknownEntries : [];
  const processedCount = Number(state?.processedCount || 0);
  const lookupTotal = Number(state?.lookupTotal || 0);
  const retryRecoveredCount = Number(state?.retryRecoveredCount || 0);
  const notRenewedCount = Number(state?.notRenewedCount || 0);

  setResultsOpen(true);
  results.hidden = true;
  renewedList.replaceChildren();
  unknownList.replaceChildren();
  renewedEntries.forEach((entry) => renewedList.append(createRenewedListItem(entry)));
  unknownEntries.forEach((entry) => unknownList.append(createUnknownListItem(entry)));
  unknownSummary.hidden = !unknownEntries.length;
  unknownList.hidden = !unknownEntries.length;
  if (unknownEntries.length) unknownSummary.textContent = 'Unknown cases';
  renderRenewalRadarProgress(processedCount, lookupTotal, renewedEntries.length, notRenewedCount, unknownEntries.length, retryRecoveredCount);

  const currentBillingNumber = String(state?.currentBillingNumber || '').trim();
  const isActive = state?.status === 'running' || state?.status === 'stopping';
  if (isActive && currentBillingNumber) {
    setRenewalCurrent(`${state.status === 'stopping' ? 'Stopping after' : 'Currently checking'}: ${currentBillingNumber} (${processedCount + 1}/${lookupTotal})`);
    setStatus(`Renewal Radar ${state.status}${state.status === 'stopping' ? ' after the current lookup' : ''}.`);
  } else if (state?.status === 'stopped') {
    setRenewalCurrent(`Stopped after checking ${processedCount}/${lookupTotal} accounts.`);
    setStatus('Renewal Radar stopped. Checked results are displayed.', 'success');
  } else if (state?.status === 'completed') {
    setRenewalCurrent(`Finished checking ${processedCount}/${lookupTotal} accounts.`);
    setStatus('Renewal Radar complete.', 'success');
  }
}

function setRenewalCurrent(textValue) {
  const value = String(textValue || '').trim();
  if (!value) {
    renewalCurrent.textContent = '';
    renewalCurrent.hidden = true;
    return;
  }
  renewalCurrent.textContent = value;
  renewalCurrent.hidden = false;
}

function hideRenewedBatchResults() {
  renewedResults.hidden = true;
  setRenewalCurrent('');
  renewedSummary.textContent = '';
  renewedList.replaceChildren();
  unknownSummary.hidden = true;
  unknownSummary.textContent = '';
  unknownList.hidden = true;
  unknownList.replaceChildren();
  schedulePopupResizeSync();
}

if (copyCallTemplateButton) {
  copyCallTemplateButton.addEventListener('click', async () => {
    if (isBatchRunning || isSingleLookupRunning) return;
    setActionButtonsDisabled(true);
    try {
      await copyCallTemplateToClipboard();
      setStatus('Call template copied.', 'success');
    } catch (error) {
      setStatus(error.message || 'Could not copy the template.', 'error');
    } finally {
      setActionButtonsDisabled(false);
    }
  });
}

function setActionButtonsDisabled(disabled) {
  // one place to lock/unlock all actionable controls
  button.disabled = disabled;
  // A customer can only be dialed after the currently requested lookup has rendered.
  dialButton.disabled = disabled || isSingleLookupRunning || !hasDisplayedLookupResult;
  dispositionSelect.disabled = disabled;
  saveDispositionButton.disabled = disabled;
  pullPreviousBillingNumberButton.disabled = disabled;
  pullNextBillingNumberButton.disabled = disabled;
  runRenewalAutocheckButton.disabled = disabled || isBatchRunning;
  if (stopRenewalAutocheckButton) stopRenewalAutocheckButton.disabled = !isBatchRunning;
  if (openSessionSetupButton) openSessionSetupButton.disabled = disabled;
  if (startSessionButton) startSessionButton.disabled = disabled;
  if (closeSessionSetupButton) closeSessionSetupButton.disabled = disabled;
  if (copyCallTemplateButton) copyCallTemplateButton.disabled = disabled;
}

function toRenewedEntry(data, billingNumber) {
  return {
    billingNumber,
    customerName: String(data.customerName || '').trim(),
    accountStatus: String(data.accountStatus || '').trim()
  };
}

function hasSessionRows() {
  return Boolean(String(pastedRowsInput.value || '').trim());
}

function ensureSessionRows() {
  // guard for flows that require pasted excel rows
  const rowsText = String(pastedRowsInput.value || '').trim();
  if (!rowsText) {
    throw new Error('Paste copied rows in Start Session first.');
  }
  const rows = parseClipboardRows(rowsText);
  if (!rows.length) {
    throw new Error('No readable rows found in Start Session paste data.');
  }
  return rows;
}

async function beginSessionFromSetup() {
  // validates setup, saves target, returns user to compact controls
  ensureSessionRows();
  await persistTargetValue();
  setSessionReady(true);
  setSessionSetupOpen(false);
  clearSessionPosition();
  setStatus('Session ready. Use Previous/Next to load billing numbers.', 'success');
}

function normalizeDialNumber(value) {
  // same phone normalization logic used by background dial call
  const digitsOnly = String(value || '').replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) return digitsOnly.slice(1);
  return digitsOnly;
}

function normalizeDisposition(value) {
  return String(value || '').trim().toLowerCase();
}

function dispositionFileSlug(value) {
  return normalizeDisposition(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'disposition';
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildDispositionCsv(records) {
  // builds downloadable csv grouped by disposition type
  const header = ['billingNumber', 'customerName', 'contractExpirationDate', 'dialedNumber', 'disposition', 'savedAt'];
  const lines = [header.join(',')];
  for (const record of records) {
    lines.push([
      record.billingNumber,
      record.customerName,
      record.contractExpirationDate,
      record.dialedNumber,
      record.disposition,
      record.savedAt
    ].map(escapeCsvValue).join(','));
  }
  return lines.join('\r\n');
}

async function getDispositionLogs() {
  const { dispositionLogs } = await chrome.storage.local.get(DISPOSITION_LOG_KEY);
  return dispositionLogs || {};
}

async function saveDispositionRecord(record) {
  // append to local storage bucket for selected disposition
  const disposition = normalizeDisposition(record.disposition);
  if (!DISPOSITION_OPTIONS.includes(disposition)) {
    throw new Error('Choose a disposition before saving.');
  }

  const logs = await getDispositionLogs();
  const updatedRecords = [...(logs[disposition] || []), record];
  logs[disposition] = updatedRecords;
  await chrome.storage.local.set({ [DISPOSITION_LOG_KEY]: logs });
  return updatedRecords;
}

async function downloadDispositionCsv(disposition, records) {
  // auto-download overwrite so latest disposition log is always fresh
  const csv = buildDispositionCsv(records);
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  await chrome.downloads.download({
    url,
    filename: `esg-${dispositionFileSlug(disposition)}.csv`,
    saveAs: false,
    conflictAction: 'overwrite'
  });
}

async function getLatestLookupResult() {
  // we only dial/save after there is a completed lookup result
  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (!lastResult) {
    throw new Error('Run Find account first so the customer details are available.');
  }
  return lastResult;
}

async function saveSelectedDisposition() {
  // uses current lookup payload to build one disposition log row
  const disposition = normalizeDisposition(dispositionSelect.value);
  if (!disposition) {
    throw new Error('Choose a disposition before saving.');
  }

  const lastResult = await getLatestLookupResult();
  const record = {
    billingNumber: String(lastResult.billingNumber || '').trim(),
    customerName: String(lastResult.customerName || '').trim(),
    contractExpirationDate: String(lastResult.currentContractEnd || lastResult.renewalEnd || '').trim(),
    dialedNumber: String(lastResult.phone || '').trim(),
    disposition,
    savedAt: new Date().toISOString()
  };

  const records = await saveDispositionRecord(record);
  await downloadDispositionCsv(disposition, records);
  setStatus(`Saved ${disposition} and updated its CSV download file.`, 'success');
}

async function dialLatestCustomer() {
  // asks background to focus sharpen and populate dial field
  const lastResult = await getLatestLookupResult();

  const dialValue = normalizeDialNumber(lastResult.phone);
  if (!dialValue) {
    throw new Error('No phone number found in the latest lookup result.');
  }

  const response = await chrome.runtime.sendMessage({
    type: 'DIAL_CUSTOMER',
    dialValue,
    customer: {
      name: String(lastResult.customerName || '').trim(),
      billingNumber: String(lastResult.billingNumber || '').trim(),
      customerNumber: String(lastResult.customerNumber || '').trim()
    }
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Dial failed.');
  }

  return {
    ...response,
    callId: normalizeSharpenCallId(response.callId)
  };
}

let flashTimer = null;
function clearRenewalStateClasses() {
  // reset color flash classes before applying new state
  popupBody.classList.remove('renewal-state-green', 'renewal-state-red');
  shell.classList.remove('flash-renewal-green', 'flash-renewal-red');
}

function flashRenewalState(renewalStatus) {
  // green flash for renewed, red flash for no-renewal
  clearRenewalStateClasses();
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }

  const normalized = String(renewalStatus || '').toLowerCase();
  const hasRenewal = normalized.includes('renewed/active') || normalized.includes('renewed');
  const noRenewal = normalized.includes('no renewal');
  if (!hasRenewal && !noRenewal) return;

  popupBody.classList.add(hasRenewal ? 'renewal-state-green' : 'renewal-state-red');
  shell.classList.add(hasRenewal ? 'flash-renewal-green' : 'flash-renewal-red');
  flashTimer = setTimeout(() => {
    shell.classList.remove('flash-renewal-green', 'flash-renewal-red');
    flashTimer = null;
  }, 1300);
}

function getTargetValue() {
  return assignmentTargetInput.value.trim();
}

async function persistTargetValue() {
  await chrome.storage.local.set({
    excelTargetValue: getTargetValue(),
    excelPastedRows: pastedRowsInput.value
  });
}

async function restoreTargetValue() {
  const { excelTargetValue, excelPastedRows } = await chrome.storage.local.get(['excelTargetValue', 'excelPastedRows']);
  if (excelTargetValue) assignmentTargetInput.value = excelTargetValue;
  if (excelPastedRows) pastedRowsInput.value = excelPastedRows;
}

async function getCycleState() {
  const { excelCycleState } = await chrome.storage.local.get('excelCycleState');
  return excelCycleState || {};
}

async function setCycleIndex(targetValue, nextIndex) {
  const cycleState = await getCycleState();
  cycleState[targetValue] = nextIndex;
  await chrome.storage.local.set({ excelCycleState: cycleState });
}

async function getPortalTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && activeTab.url?.startsWith('https://affordable-ep.esgglobal.net/')) {
    return activeTab;
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find((tab) => tab.url?.startsWith('https://affordable-ep.esgglobal.net/')) || null;
}

function parseClipboardRows(clipboardText) {
  // excel copy usually tab-delimited, one row per newline
  const lines = String(clipboardText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => line.split('\t').map((cell) => String(cell || '').trim()));
}

function parseTargetValues(targetValue) {
  return String(targetValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildTargetCycleKey(targetValue) {
  const parsedTargets = parseTargetValues(targetValue);
  if (!parsedTargets.length) return '__top_down__';
  const normalizedTargets = [...new Set(parsedTargets.map((value) => value.toLowerCase()))].sort();
  return normalizedTargets.join(',');
}

function collectBillingNumbersFromRows(rows) {
  // gathers unique billing numbers + tracks malformed/duplicate rows
  const seen = new Set();
  const billingNumbers = [];
  const unknownEntries = [];

  for (const [rowIndex, cells] of rows.entries()) {
    const rowName = `Row ${rowIndex + 1}`;
    const billingCandidate = cells.length === 1
      ? String(cells[0] || '').trim()
      : String(cells[3] || '').trim();
    if (!billingCandidate) {
      unknownEntries.push({ billingNumber: rowName, reason: 'missing billing number' });
      continue;
    }
    if (!/\d/.test(billingCandidate)) {
      unknownEntries.push({ billingNumber: billingCandidate, reason: 'invalid billing format' });
      continue;
    }
    if (seen.has(billingCandidate)) {
      unknownEntries.push({ billingNumber: billingCandidate, reason: 'duplicate in pasted set' });
      continue;
    }
    seen.add(billingCandidate);
    billingNumbers.push(billingCandidate);
  }

  return { billingNumbers, unknownEntries };
}

async function readCopiedRowsText() {
  const pastedText = String(pastedRowsInput.value || '').trim();
  if (pastedText) return pastedText;

  throw new Error('Paste copied rows into the text box, then try again.');
}

function createLookupRequestId(prefix = 'lookup') {
  const id = nextLookupRequestId;
  nextLookupRequestId += 1;
  return `${prefix}-${Date.now()}-${id}`;
}

function waitForLookupFinished(timeoutMs = 90000, expectedRequestId = '') {
  // wait for LOOKUP_FINISHED message matching this request id
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Lookup timed out before the portal responded.'));
    }, timeoutMs);

    const listener = (message) => {
      if (message.type !== 'LOOKUP_FINISHED') return;
      if (expectedRequestId && message.requestId !== expectedRequestId) return;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      if (message.ok) {
        resolve(message.data || {});
      } else {
        reject(new Error(message.error || 'Lookup failed.'));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
  });
}

function isRetryableLookupError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timed out')
    || message.includes('did not finish')
    || message.includes('could not communicate')
    || message.includes('portal script');
}

async function runLookupForBillingNumber(tabId, billingNumber) {
  // batch helper w retry for recoverable portal glitches
  const attempts = [40000, 65000];
  let lastError = null;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const requestId = createLookupRequestId('batch');
    try {
      const pendingResult = waitForLookupFinished(attempts[attempt], requestId);
      const response = await chrome.runtime.sendMessage({
        type: 'START_LOOKUP',
        tabId,
        billingNumber,
        requestId
      });
      if (!response?.ok) {
        throw new Error(response?.error || `Could not start lookup for ${billingNumber}.`);
      }
      if (response.requestId && response.requestId !== requestId) {
        throw new Error(`Lookup request mismatch for ${billingNumber}.`);
      }
      const data = await pendingResult;
      return {
        data,
        recoveredByRetry: attempt > 0
      };
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < attempts.length - 1 && isRetryableLookupError(error);
      if (!shouldRetry) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  throw lastError || new Error(`Lookup failed for ${billingNumber}.`);
}

function findBillingMatchesFromRows(rows, targetValue) {
  // if target blank => all rows, else only matching col A targets
  const parsedTargets = parseTargetValues(targetValue);
  if (!parsedTargets.length) {
    return rows
      .map((cells, rowIndex) => ({ cells, rowIndex }))
      .filter((row) => row.cells.length >= 4)
      .map((row) => ({
        rowIndex: row.rowIndex,
        billingNumber: String(row.cells[3] || '').trim()
      }))
      .filter((row) => row.billingNumber);
  }

  const textTargets = new Set(parsedTargets.map((value) => value.toLowerCase()));
  const numericTargets = new Set(
    parsedTargets
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  );

  const matchesTarget = (value) => {
    const normalized = String(value || '').trim();
    if (textTargets.has(normalized.toLowerCase())) return true;
    const numericValue = Number(normalized);
    return Number.isFinite(numericValue) && numericTargets.has(numericValue);
  };

  return rows
    .map((cells, rowIndex) => ({ cells, rowIndex }))
    .filter((row) => row.cells.length >= 4)
    .filter((row) => matchesTarget(row.cells[0]))
    .map((row) => ({
      rowIndex: row.rowIndex,
      billingNumber: String(row.cells[3] || '').trim()
    }))
    .filter((row) => row.billingNumber);
}

async function pullBillingNumberForTarget(direction = 1) {
  // cycles next/previous through matched billing numbers
  ensureSessionRows();
  const targetValue = getTargetValue();
  const parsedTargets = parseTargetValues(targetValue);
  const pastedRowsText = String(pastedRowsInput.value || '').trim();
  if (!pastedRowsText) {
    throw new Error('Paste copied rows into the text box first.');
  }

  const rows = parseClipboardRows(pastedRowsText);
  if (!rows.length) throw new Error('No readable rows found. Paste rows from Excel into the text box.');

  const matches = findBillingMatchesFromRows(rows, targetValue);
  if (!matches.length) {
    throw new Error(parsedTargets.length
      ? `No copied rows found where column A equals any of: ${parsedTargets.join(', ')}.`
      : 'No billing numbers found in the copied rows.');
  }

  const cycleState = await getCycleState();
  const datasetKey = `${buildTargetCycleKey(targetValue)}|${rows.length}|${rows[0]?.join('|') || ''}`;

  let nextPointer = Number.isInteger(cycleState[datasetKey]) ? cycleState[datasetKey] : 0;
  if (nextPointer < 0 || nextPointer >= matches.length) nextPointer = 0;

  const isPreviousDirection = direction < 0;
  const selectedIndex = isPreviousDirection
    ? (nextPointer - 2 + matches.length) % matches.length
    : nextPointer;
  const selected = matches[selectedIndex];
  const newPointer = isPreviousDirection
    ? (selectedIndex + 1) % matches.length
    : (nextPointer + 1) % matches.length;

  await persistTargetValue();
  await setCycleIndex(datasetKey, newPointer);

  return {
    billingNumber: selected.billingNumber,
    position: selectedIndex + 1,
    total: matches.length
  };
}

form.addEventListener('submit', async (event) => {
  // single lookup submit path
  event.preventDefault();
  if (isBatchRunning || isSingleLookupRunning) return;
  const billingNumber = input.value.trim();
  if (!billingNumber) return;

  isSingleLookupRunning = true;
  hasDisplayedLookupResult = false;
  setLookupLoading(true);
  setActionButtonsDisabled(true);
  setResultsOpen(false);
  results.hidden = true;
  hideRenewedBatchResults();
  clearRenewalStateClasses();
  let backgroundRadarStarted = false;
  setStatus('Working in the ESG portal tab...');

  try {
    const portalTab = await getPortalTab();
    if (!portalTab?.id) {
      throw new Error('Open a signed-in ESG portal tab in this window before starting a lookup.');
    }

    const requestId = createLookupRequestId('single');
    activeSingleLookupRequestId = requestId;

    const response = await chrome.runtime.sendMessage({
      type: 'START_LOOKUP',
      tabId: portalTab.id,
      billingNumber,
      requestId
    });
    if (!response?.ok) throw new Error(response?.error || 'The lookup did not complete.');
    if (response.requestId && response.requestId !== requestId) {
      throw new Error('Lookup request mismatch. Please try again.');
    }
    setStatus('Lookup started. Keep the portal tab open while it runs.');
  } catch (error) {
    activeSingleLookupRequestId = '';
    isSingleLookupRunning = false;
    setLookupLoading(false);
    setStatus(error.message || 'Lookup failed.', 'error');
  } finally {
    setActionButtonsDisabled(false);
  }
});

pullPreviousBillingNumberButton.addEventListener('click', async () => {
  // loads previous billing number from current session cycle
  if (isBatchRunning || isSingleLookupRunning) return;
  setActionButtonsDisabled(true);
  setStatus('Reading pasted rows...');
  try {
    const picked = await pullBillingNumberForTarget(-1);
    input.value = picked.billingNumber;
    hasDisplayedLookupResult = false;
    setSessionPositionBadge(picked.position, picked.total);
    persistSessionPosition(picked.position, picked.total);
    setStatus(`Loaded previous ${picked.billingNumber} (${picked.position}/${picked.total})`, 'success');
  } catch (error) {
    setStatus(error.message || 'Could not read billing numbers from pasted rows.', 'error');
  } finally {
    setActionButtonsDisabled(false);
  }
});

pullNextBillingNumberButton.addEventListener('click', async () => {
  // loads next billing number then auto-starts lookup after tiny delay
  if (isBatchRunning || isSingleLookupRunning) return;
  setActionButtonsDisabled(true);
  setStatus('Reading pasted rows...');
  let lookupQueued = false;
  try {
    const picked = await pullBillingNumberForTarget(1);
    input.value = picked.billingNumber;
    hasDisplayedLookupResult = false;
    setSessionPositionBadge(picked.position, picked.total);
    persistSessionPosition(picked.position, picked.total);
    setStatus(`Loaded next ${picked.billingNumber} (${picked.position}/${picked.total}). Starting search...`, 'success');

    // Briefly yield so the updated billing number is visible before its lookup begins.
    await new Promise((resolve) => setTimeout(resolve, NEXT_BILLING_AUTO_LOOKUP_DELAY_MS));
    setStatus(`Searching ${picked.billingNumber}...`);
    lookupQueued = true;
    form.requestSubmit();
  } catch (error) {
    setStatus(error.message || 'Could not read billing numbers from pasted rows.', 'error');
  } finally {
    if (!lookupQueued) setActionButtonsDisabled(false);
  }
});

dialButton.addEventListener('click', async () => {
  // dial action only allowed once a lookup has rendered
  if (isBatchRunning || isSingleLookupRunning || !hasDisplayedLookupResult) return;
  setActionButtonsDisabled(true);
  setStatus('Opening Sharpen, dialing, and capturing Call ID...');
  let dialSucceeded = false;
  try {
    const dialResponse = await dialLatestCustomer();
    const capturedCallId = normalizeSharpenCallId(dialResponse?.callId);
    if (capturedCallId) {
      await persistCallIdForLatestLookup(capturedCallId);
      setStatus(`Sharpen dialed and Call ID captured: ${capturedCallId}. Review or copy the call template below.`, 'success');
    } else {
      setStatus('Sharpen dialed, but Call ID could not be read after 5 seconds. You can still use/copy the call template below.', 'warn');
    }
    dialSucceeded = true;
  } catch (error) {
    setStatus(error.message || 'Dial failed.', 'error');
  } finally {
    setActionButtonsDisabled(false);
    if (dialSucceeded && copyCallTemplateButton) copyCallTemplateButton.focus();
  }
});

saveDispositionButton.addEventListener('click', async () => {
  // writes disposition log + refreshes its csv download
  if (isBatchRunning) return;
  setActionButtonsDisabled(true);
  setStatus('Saving disposition...');
  try {
    await saveSelectedDisposition();
  } catch (error) {
    setStatus(error.message || 'Could not save the disposition.', 'error');
  } finally {
    setActionButtonsDisabled(false);
  }
});

runRenewalAutocheckButton.addEventListener('click', async () => {
  // starts background renewal radar over pasted billing numbers
  if (isBatchRunning) return;
  isBatchRunning = true;
  setActionButtonsDisabled(true);
  setSessionSetupOpen(false);
  setResultsOpen(false);
  results.hidden = true;
  hideRenewedBatchResults();
  clearRenewalStateClasses();

  try {
    const portalTab = await getPortalTab();
    if (!portalTab?.id) {
      throw new Error('Open a signed-in ESG portal tab in this window before running Renewal Radar.');
    }

    const clipboardText = await readCopiedRowsText();
    const rows = parseClipboardRows(clipboardText);
    if (!rows.length) {
      throw new Error('No readable rows found. Paste rows from Excel into the text box.');
    }

    const { billingNumbers, unknownEntries: inputUnknownEntries } = collectBillingNumbersFromRows(rows);
    if (!billingNumbers.length) {
      throw new Error('No billing numbers found in copied rows. Use column D exports or paste a single billing-number column.');
    }

    const response = await chrome.runtime.sendMessage({
      type: 'START_RENEWAL_RADAR',
      tabId: portalTab.id,
      billingNumbers,
      inputUnknownEntries,
      totalCount: billingNumbers.length + inputUnknownEntries.length
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start Renewal Radar.');
    backgroundRadarStarted = true;
    setStatus('Renewal Radar is running in the background. You can close or unfocus this popup.');
    return;

    const renewed = [];
    let notRenewedCount = 0;
    let retryRecoveredCount = 0;
    const unknownEntries = [...inputUnknownEntries];

    renewedList.replaceChildren();
    unknownList.replaceChildren();
    if (unknownEntries.length) {
      unknownEntries.forEach((entry) => unknownList.append(createUnknownListItem(entry)));
      unknownSummary.textContent = 'Unknown cases';
      unknownSummary.hidden = false;
      unknownList.hidden = false;
    } else {
      unknownSummary.hidden = true;
      unknownList.hidden = true;
    }
    renderRenewalRadarProgress(0, billingNumbers.length, 0, 0, unknownEntries.length, retryRecoveredCount);

    for (let index = 0; index < billingNumbers.length; index += 1) {
      const billingNumber = billingNumbers[index];
      const currentText = `Currently checking: ${billingNumber} (${index + 1}/${billingNumbers.length})`;
      setRenewalCurrent(currentText);
      setStatus(`Renewal Radar running ${index + 1}/${billingNumbers.length}: ${billingNumber}`);
      try {
        const lookupResult = await runLookupForBillingNumber(portalTab.id, billingNumber);
        if (lookupResult.recoveredByRetry) retryRecoveredCount += 1;
        const data = lookupResult.data;
        const renewalStatus = String(data.renewalStatus || '').toLowerCase();
        if (renewalStatus.includes('renewed/active') || renewalStatus.includes('renewed')) {
          const renewedEntry = toRenewedEntry(data, billingNumber);
          renewed.push(renewedEntry);
          renewedList.append(createRenewedListItem(renewedEntry));
        } else if (renewalStatus.includes('no renewal')) {
          notRenewedCount += 1;
        } else {
          const unknownEntry = {
            billingNumber,
            reason: `unrecognized status: ${String(data.renewalStatus || 'blank')}`
          };
          unknownEntries.push(unknownEntry);
          unknownList.append(createUnknownListItem(unknownEntry));
          unknownSummary.textContent = 'Unknown cases';
          unknownSummary.hidden = false;
          unknownList.hidden = false;
        }
      } catch (error) {
        const unknownEntry = {
          billingNumber,
          reason: String(error?.message || 'lookup failed')
        };
        unknownEntries.push(unknownEntry);
        unknownList.append(createUnknownListItem(unknownEntry));
        unknownSummary.textContent = 'Unknown cases';
        unknownSummary.hidden = false;
        unknownList.hidden = false;
      }

      renderRenewalRadarProgress(
        index + 1,
        billingNumbers.length,
        renewed.length,
        notRenewedCount,
        unknownEntries.length,
        retryRecoveredCount
      );
    }

    const finishedText = `Finished checking ${billingNumbers.length} account${billingNumbers.length === 1 ? '' : 's'}.`;
    setRenewalCurrent(finishedText);

    const totalCount = billingNumbers.length + inputUnknownEntries.length;
    renderRenewedBatchResults(renewed, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount);
    persistBatchSnapshot(renewed, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount);
    setStatus(`Renewal Radar complete. ${renewed.length} Renewed/Active, ${notRenewedCount} No renewal, ${unknownEntries.length} Unknown. Retry recovered: ${retryRecoveredCount}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Renewal Radar failed.', 'error');
  } finally {
    if (!backgroundRadarStarted) {
      isBatchRunning = false;
      setActionButtonsDisabled(false);
    }
  }
});

stopRenewalAutocheckButton.addEventListener('click', async () => {
  // requests graceful stop after current lookup completes
  if (!isBatchRunning) return;
  stopRenewalAutocheckButton.disabled = true;
  setStatus('Stopping Renewal Radar after the current lookup finishes...');
  const response = await chrome.runtime.sendMessage({ type: 'STOP_RENEWAL_RADAR' });
  if (!response?.ok) {
    stopRenewalAutocheckButton.disabled = false;
    setStatus(response?.error || 'Could not stop Renewal Radar.', 'error');
  }
});

pastedRowsInput.addEventListener('input', () => {
  // debounce local persistence while user is still pasting/editing
  if (pastedRowsPersistTimer) {
    clearTimeout(pastedRowsPersistTimer);
  }
  pastedRowsPersistTimer = setTimeout(() => {
    pastedRowsPersistTimer = null;
    chrome.storage.local.set({ excelPastedRows: pastedRowsInput.value });
  }, 300);
  setSessionReady(hasSessionRows());
  clearSessionPosition();
});

if (openSessionSetupButton) {
  openSessionSetupButton.addEventListener('click', () => {
    // reopen setup panel to edit target/pasted rows
    setSessionSetupOpen(true);
  });
}

if (startSessionButton) {
  startSessionButton.addEventListener('click', async () => {
    if (isBatchRunning) return;
    setActionButtonsDisabled(true);
    try {
      await beginSessionFromSetup();
    } catch (error) {
      setStatus(error.message || 'Could not start session.', 'error');
    } finally {
      setActionButtonsDisabled(false);
    }
  });
}

if (closeSessionSetupButton) {
  closeSessionSetupButton.addEventListener('click', () => {
    // close setup and return to compact controls view
    setSessionSetupOpen(false);
  });
}

restoreTargetValue().catch(() => {
  // Best effort restore for target input.
});

// default boot state before any restore kicks in
setSessionReady(false);
setResultsOpen(false);
setSessionSetupOpen(true);
populateCallTemplate();
schedulePopupResizeSync();

const popupResizeObserver = new MutationObserver(() => {
  schedulePopupResizeSync();
});

popupResizeObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true
});

chrome.storage.local.get(['excelPastedRows', SESSION_POSITION_KEY]).then((stored) => {
  // restore pasted rows + session index from prior popup sessions
  const restoredRows = String(stored.excelPastedRows || '').trim();
  if (!restoredRows) {
    setSessionSetupOpen(true);
    setStatus('Paste rows to start this session.', '');
    return;
  }

  pastedRowsInput.value = restoredRows;
  setSessionReady(true);
  setSessionSetupOpen(false);

  const savedPosition = stored[SESSION_POSITION_KEY];
  if (savedPosition && savedPosition.position && savedPosition.total) {
    setSessionPositionBadge(savedPosition.position, savedPosition.total);
  }
});

chrome.storage.session.get(['lastResult', LAST_BATCH_KEY, LAST_VIEW_MODE_KEY, 'renewalRadarState']).then((stored) => {
  // restore most relevant last view (live radar, batch, or single)
  const mode = stored[LAST_VIEW_MODE_KEY];
  const lastBatch = stored[LAST_BATCH_KEY];
  const lastResult = stored.lastResult;
  const radarState = stored.renewalRadarState;

  if (radarState) {
    isBatchRunning = radarState.status === 'running' || radarState.status === 'stopping';
    renderRenewalRadarState(radarState);
    setActionButtonsDisabled(false);
    return;
  }

  if (mode === 'batch' && lastBatch) {
    results.hidden = true;
    renderRenewedBatchResults(
      lastBatch.renewedEntries || [],
      Number(lastBatch.notRenewedCount || 0),
      lastBatch.unknownEntries || [],
      Number(lastBatch.totalCount || 0),
      Number(lastBatch.retryRecoveredCount || 0)
    );
    setStatus('Last Renewal Radar results restored.', 'success');
    return;
  }

  if (lastResult) {
    hideRenewedBatchResults();
    render(lastResult);
    populateCallTemplate(lastResult);
    hasDisplayedLookupResult = true;
    flashRenewalState(lastResult.renewalStatus);
    setStatus('Last lookup complete.', 'success');
    setActionButtonsDisabled(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  // reacts to background push updates for radar/single lookup finishes
  if (message.type === 'RADAR_UPDATED') {
    const radarState = message.state || {};
    isBatchRunning = radarState.status === 'running' || radarState.status === 'stopping';
    renderRenewalRadarState(radarState);
    setActionButtonsDisabled(false);
    return;
  }

  if (message.type !== 'LOOKUP_FINISHED') return;
  if (isBatchRunning) return;
  if (activeSingleLookupRequestId && message.requestId !== activeSingleLookupRequestId) return;

  activeSingleLookupRequestId = '';
  isSingleLookupRunning = false;
  setLookupLoading(false);
  if (message.ok) {
    persistDisplayMode('single');
    hideRenewedBatchResults();
    render(message.data);
    populateCallTemplate(message.data);
    hasDisplayedLookupResult = true;
    flashRenewalState(message.data?.renewalStatus);
    setStatus('Lookup complete.', 'success');
  } else {
    hasDisplayedLookupResult = false;
    setStatus(message.error || 'Lookup failed.', 'error');
  }
  setActionButtonsDisabled(false);
});
