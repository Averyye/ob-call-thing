const form = document.querySelector('#lookup-form');
const shell = document.querySelector('.shell');
const popupBody = document.body;
const input = document.querySelector('#customer-number');
const button = document.querySelector('#lookup-button');
const dialButton = document.querySelector('#dial-button');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
// by Mo and Avery

const assignmentTargetInput = document.querySelector('#assignment-target');
const pullBillingNumberButton = document.querySelector('#pull-billing-number');
const pastedRowsInput = document.querySelector('#pasted-rows');
const runRenewalAutocheckButton = document.querySelector('#run-renewal-autocheck');
const renewedResults = document.querySelector('#renewed-results');
const renewalCurrent = document.querySelector('#renewal-current');
const renewedSummary = document.querySelector('#renewed-summary');
const renewedList = document.querySelector('#renewed-list');
const unknownSummary = document.querySelector('#unknown-summary');
const unknownList = document.querySelector('#unknown-list');

let isBatchRunning = false;
const LAST_BATCH_KEY = 'lastRenewalRadarResult';
const LAST_VIEW_MODE_KEY = 'lastDisplayMode';

const fields = [
  ['Customer', 'customerName'],
  ['Search number', 'customerNumber'],
  ['Phone', 'phone'],
  ['Billing number', 'billingNumber'],
  ['Status', 'accountStatus'],
  ['Current contract ends', 'currentContractEnd'],
  ['Renewal starts', 'renewalStart'],
  ['Renewal ends', 'renewalEnd'],
  ['Renewal status', 'renewalStatus']
];

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `status ${type}`;
}

/* by Mo and Avery */

function persistDisplayMode(mode) {
  chrome.storage.session.set({ [LAST_VIEW_MODE_KEY]: mode }).catch(() => {});
}

function persistBatchSnapshot(renewedEntries, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount) {
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

function render(data) {
  results.replaceChildren();
  for (const [label, key] of fields) {
    const row = document.createElement('div');
    row.className = 'result-row';
    const labelElement = document.createElement('span');
    labelElement.className = 'result-label';
    labelElement.textContent = label;
    const valueElement = document.createElement('span');
    valueElement.className = `result-value${data[key] ? '' : ' muted'}`;
    valueElement.textContent = data[key] || 'Not found';
    row.append(labelElement, valueElement);
    results.append(row);
  }
  results.hidden = false;
}

function renderRenewedBatchResults(renewedEntries, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount = 0) {
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
  renewedSummary.textContent = `Processed ${processedCount}/${totalCount}. ${renewedCount} Renewed/Active, ${notRenewedCount} No renewal, ${unknownCount} Unknown. Retry recovered: ${retryRecoveredCount}.`;
  renewedResults.hidden = false;
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
}

function setActionButtonsDisabled(disabled) {
  button.disabled = disabled;
  dialButton.disabled = disabled;
  pullBillingNumberButton.disabled = disabled;
  runRenewalAutocheckButton.disabled = disabled;
}

function normalizeDialNumber(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) return digitsOnly.slice(1);
  return digitsOnly;
}

async function dialLatestCustomer() {
  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (!lastResult) {
    throw new Error('Run Find account first so the customer details are available.');
  }

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

  return response;
}

let flashTimer = null;
function clearRenewalStateClasses() {
  popupBody.classList.remove('renewal-state-green', 'renewal-state-red');
  shell.classList.remove('flash-renewal-green', 'flash-renewal-red');
}

function flashRenewalState(renewalStatus) {
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
  const lines = String(clipboardText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => line.split('\t').map((cell) => String(cell || '').trim()));
}

function collectBillingNumbersFromRows(rows) {
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
  let clipboardText = '';
  try {
    clipboardText = await navigator.clipboard.readText();
  } catch {
    clipboardText = '';
  }

  if (clipboardText.trim()) return clipboardText;

  const pastedText = String(pastedRowsInput.value || '').trim();
  if (pastedText) return pastedText;

  throw new Error('Could not read clipboard. Copy rows with Ctrl+C, or paste rows into the fallback text box, then try again.');
}

function waitForLookupFinished(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Lookup timed out before the portal responded.'));
    }, timeoutMs);

    const listener = (message) => {
      if (message.type !== 'LOOKUP_FINISHED') return;
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
  const attempts = [40000, 65000];
  let lastError = null;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    try {
      const pendingResult = waitForLookupFinished(attempts[attempt]);
      const response = await chrome.runtime.sendMessage({
        type: 'START_LOOKUP',
        tabId,
        billingNumber
      });
      if (!response?.ok) {
        throw new Error(response?.error || `Could not start lookup for ${billingNumber}.`);
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
  const normalizedTarget = String(targetValue || '').trim();
  const numericTarget = Number(normalizedTarget);
  const matchesTarget = (value) => {
    const normalized = String(value || '').trim();
    if (normalized === normalizedTarget) return true;
    const numericValue = Number(normalized);
    return Number.isFinite(numericTarget) && Number.isFinite(numericValue) && numericTarget === numericValue;
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

async function pullNextBillingNumberForTarget() {
  const targetValue = getTargetValue();
  if (!targetValue) throw new Error('Enter a target number (1-10) first.');

  let clipboardText = '';
  try {
    clipboardText = await navigator.clipboard.readText();
  } catch {
    clipboardText = '';
  }

  if (!clipboardText.trim()) {
    clipboardText = String(pastedRowsInput.value || '').trim();
  }

  if (!clipboardText) {
    throw new Error('Could not read clipboard. Copy rows with Ctrl+C, or paste rows into the fallback text box, then try again.');
  }

  const rows = parseClipboardRows(clipboardText);
  if (!rows.length) throw new Error('No readable rows found. Copy rows from Excel or paste them into the fallback text box.');

  const matches = findBillingMatchesFromRows(rows, targetValue);
  if (!matches.length) throw new Error(`No copied rows found where column A equals ${targetValue}.`);

  const cycleState = await getCycleState();
  const datasetKey = `${targetValue}|${rows.length}|${rows[0]?.join('|') || ''}`;

  let nextPointer = Number.isInteger(cycleState[datasetKey]) ? cycleState[datasetKey] : 0;
  if (nextPointer < 0 || nextPointer >= matches.length) nextPointer = 0;

  const selected = matches[nextPointer];
  const newPointer = (nextPointer + 1) % matches.length;

  await persistTargetValue();
  await setCycleIndex(datasetKey, newPointer);

  return {
    billingNumber: selected.billingNumber,
    position: nextPointer + 1,
    total: matches.length
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isBatchRunning) return;
  const billingNumber = input.value.trim();
  if (!billingNumber) return;

  setActionButtonsDisabled(true);
  results.hidden = true;
  hideRenewedBatchResults();
  clearRenewalStateClasses();
  setStatus('Working in the ESG portal tab...');

  try {
    const portalTab = await getPortalTab();
    if (!portalTab?.id) {
      throw new Error('Open a signed-in ESG portal tab in this window before starting a lookup.');
    }
    const response = await chrome.runtime.sendMessage({
      type: 'START_LOOKUP',
      tabId: portalTab.id,
      billingNumber
    });
    if (!response?.ok) throw new Error(response?.error || 'The lookup did not complete.');
    setStatus('Lookup started. Keep the portal tab open while it runs.');
  } catch (error) {
    setStatus(error.message || 'Lookup failed.', 'error');
  } finally {
    setActionButtonsDisabled(false);
  }
});

pullBillingNumberButton.addEventListener('click', async () => {
  if (isBatchRunning) return;
  pullBillingNumberButton.disabled = true;
  setStatus('Reading active Excel tab...');
  try {
    const picked = await pullNextBillingNumberForTarget();
    input.value = picked.billingNumber;
    setStatus(`Loaded ${picked.billingNumber} (${picked.position}/${picked.total})`, 'success');
  } catch (error) {
    setStatus(error.message || 'Could not pull billing number from active Excel tab.', 'error');
  } finally {
    pullBillingNumberButton.disabled = false;
  }
});

dialButton.addEventListener('click', async () => {
  if (isBatchRunning) return;
  setActionButtonsDisabled(true);
  setStatus('Opening Sharpen and filling the dial field...');
  try {
    await dialLatestCustomer();
    setStatus('Sharpen tab focused and dial field populated.', 'success');
  } catch (error) {
    setStatus(error.message || 'Dial failed.', 'error');
  } finally {
    setActionButtonsDisabled(false);
  }
});

runRenewalAutocheckButton.addEventListener('click', async () => {
  if (isBatchRunning) return;
  isBatchRunning = true;
  setActionButtonsDisabled(true);
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
      throw new Error('No readable rows found. Copy rows from Excel or paste them into the fallback text box.');
    }

    const { billingNumbers, unknownEntries: inputUnknownEntries } = collectBillingNumbersFromRows(rows);
    if (!billingNumbers.length) {
      throw new Error('No billing numbers found in copied rows. Use column D exports or paste a single billing-number column.');
    }

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
      setRenewalCurrent(`Currently checking: ${billingNumber} (${index + 1}/${billingNumbers.length})`);
      setStatus(`Renewal Radar running ${index + 1}/${billingNumbers.length}: ${billingNumber}`);
      try {
        const lookupResult = await runLookupForBillingNumber(portalTab.id, billingNumber);
        if (lookupResult.recoveredByRetry) retryRecoveredCount += 1;
        const data = lookupResult.data;
        const renewalStatus = String(data.renewalStatus || '').toLowerCase();
        if (renewalStatus.includes('renewed/active') || renewalStatus.includes('renewed')) {
          const renewedEntry = {
            billingNumber,
            customerName: String(data.customerName || '').trim(),
            accountStatus: String(data.accountStatus || '').trim()
          };
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

    setRenewalCurrent(`Finished checking ${billingNumbers.length} account${billingNumbers.length === 1 ? '' : 's'}.`);

    const totalCount = billingNumbers.length + inputUnknownEntries.length;
    renderRenewedBatchResults(renewed, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount);
    persistBatchSnapshot(renewed, notRenewedCount, unknownEntries, totalCount, retryRecoveredCount);
    setStatus(`Renewal Radar complete. ${renewed.length} Renewed/Active, ${notRenewedCount} No renewal, ${unknownEntries.length} Unknown. Retry recovered: ${retryRecoveredCount}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Renewal Radar failed.', 'error');
  } finally {
    isBatchRunning = false;
    setActionButtonsDisabled(false);
  }
});

pastedRowsInput.addEventListener('input', () => {
  chrome.storage.local.set({ excelPastedRows: pastedRowsInput.value });
});

restoreTargetValue().catch(() => {
  // Best effort restore for target input.
});

chrome.storage.session.get(['lastResult', LAST_BATCH_KEY, LAST_VIEW_MODE_KEY]).then((stored) => {
  const mode = stored[LAST_VIEW_MODE_KEY];
  const lastBatch = stored[LAST_BATCH_KEY];
  const lastResult = stored.lastResult;

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
    flashRenewalState(lastResult.renewalStatus);
    setStatus('Last lookup complete.', 'success');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'LOOKUP_FINISHED') return;
  if (isBatchRunning) return;
  if (message.ok) {
    persistDisplayMode('single');
    hideRenewedBatchResults();
    render(message.data);
    flashRenewalState(message.data?.renewalStatus);
    setStatus('Lookup complete.', 'success');
  } else {
    setStatus(message.error || 'Lookup failed.', 'error');
  }
});
