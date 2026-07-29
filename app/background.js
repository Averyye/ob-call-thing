const lookups = new Map();
const PORTAL_SEARCH_URL = 'https://affordable-ep.esgglobal.net/enterpriseportal/home/customers/customerSearch';
const SHARPEN_DASHBOARD_URL = 'https://app.iz1.sharpen.cx/fathomQ/dashboard/';
const SHARPEN_ORIGIN = 'https://app.iz1.sharpen.cx/';
const SEARCH_BOOTSTRAP_DELAY_MS = 300;
const DEFAULT_BOOTSTRAP_DELAY_MS = 40; // by Mo and Avery
const MAX_BOOTSTRAP_RETRIES = 8;
const RADAR_STATE_KEY = 'renewalRadarState';
let nextLookupId = 1;
const lookupCompletionWaiters = new Map();
let radarRun = null;

function normalizeDialNumber(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) return digitsOnly.slice(1);
  return digitsOnly;
}

function createLookupId() {
  const id = nextLookupId;
  nextLookupId += 1;
  return `lookup-${Date.now()}-${id}`;
}

function isRetryableLookupError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timed out')
    || message.includes('did not finish')
    || message.includes('could not communicate')
    || message.includes('portal script');
}

function toRadarEntry(data, billingNumber) {
  return {
    billingNumber,
    customerName: String(data?.customerName || '').trim(),
    accountStatus: String(data?.accountStatus || '').trim()
  };
}

async function publishRadarState(radar) {
  const state = {
    status: radar.status,
    stopRequested: radar.stopRequested,
    processedCount: radar.processedCount,
    lookupTotal: radar.billingNumbers.length,
    totalCount: radar.totalCount,
    currentBillingNumber: radar.currentBillingNumber,
    renewedEntries: radar.renewedEntries,
    notRenewedCount: radar.notRenewedCount,
    unknownEntries: radar.unknownEntries,
    retryRecoveredCount: radar.retryRecoveredCount,
    updatedAt: Date.now()
  };
  await chrome.storage.session.set({ [RADAR_STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: 'RADAR_UPDATED', state }).catch(() => {});
  return state;
}

function waitForLookupCompletion(lookupId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      lookupCompletionWaiters.delete(lookupId);
      reject(new Error('Lookup timed out before the portal responded.'));
    }, timeoutMs);
    lookupCompletionWaiters.set(lookupId, {
      resolve: (result) => {
        clearTimeout(timeout);
        lookupCompletionWaiters.delete(lookupId);
        result.ok ? resolve(result.data || {}) : reject(new Error(result.error || 'Lookup failed.'));
      }
    });
  });
}

function startPortalLookup(tabId, billingNumber, lookupId = createLookupId()) {
  const normalizedBillingNumber = String(billingNumber || '').trim();
  if (!Number.isInteger(tabId)) throw new Error('Could not identify the portal tab for this lookup.');
  if (!normalizedBillingNumber) throw new Error('Billing number is required.');

  lookups.set(tabId, {
    lookupId,
    step: 'search',
    customerNumber: searchNumberFromBillingNumber(normalizedBillingNumber),
    billingNumber: normalizedBillingNumber,
    data: {},
    inFlightStep: null,
    bootstrapRetryCount: 0,
    bootstrapTimer: null
  });

  chrome.tabs.update(tabId, { url: PORTAL_SEARCH_URL })
    .then(() => scheduleBootstrap(tabId, SEARCH_BOOTSTRAP_DELAY_MS, lookupId))
    .catch((error) => finish(tabId, { ok: false, error: `Could not start the portal script: ${error.message}` }, lookupId));
  return lookupId;
}

async function runRadarLookup(tabId, billingNumber) {
  const attempts = [40000, 65000];
  let lastError = null;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const lookupId = createLookupId();
    try {
      const pendingResult = waitForLookupCompletion(lookupId, attempts[attempt]);
      startPortalLookup(tabId, billingNumber, lookupId);
      return { data: await pendingResult, recoveredByRetry: attempt > 0 };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts.length - 1 || !isRetryableLookupError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError || new Error(`Lookup failed for ${billingNumber}.`);
}

async function runRenewalRadar(radar) {
  try {
    await publishRadarState(radar);
    for (const billingNumber of radar.billingNumbers) {
      if (radar.stopRequested) break;
      radar.currentBillingNumber = billingNumber;
      await publishRadarState(radar);
      try {
        const lookupResult = await runRadarLookup(radar.tabId, billingNumber);
        if (lookupResult.recoveredByRetry) radar.retryRecoveredCount += 1;
        const renewalStatus = String(lookupResult.data?.renewalStatus || '').toLowerCase();
        if (renewalStatus.includes('renewed/active') || renewalStatus.includes('renewed')) {
          radar.renewedEntries.push(toRadarEntry(lookupResult.data, billingNumber));
        } else if (renewalStatus.includes('no renewal')) {
          radar.notRenewedCount += 1;
        } else {
          radar.unknownEntries.push({ billingNumber, reason: `unrecognized status: ${String(lookupResult.data?.renewalStatus || 'blank')}` });
        }
      } catch (error) {
        radar.unknownEntries.push({ billingNumber, reason: String(error?.message || 'lookup failed') });
      }
      radar.processedCount += 1;
      await publishRadarState(radar);
    }
    radar.currentBillingNumber = '';
    radar.status = radar.stopRequested ? 'stopped' : 'completed';
    await publishRadarState(radar);
  } catch (error) {
    radar.currentBillingNumber = '';
    radar.status = 'failed';
    radar.error = error.message || 'Renewal Radar failed.';
    await publishRadarState(radar);
  } finally {
    radarRun = null;
  }
}

async function createRadarPortalTab(sourceTabId) {
  const sourceTab = await chrome.tabs.get(sourceTabId);
  return chrome.tabs.create({
    url: PORTAL_SEARCH_URL,
    active: false,
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1
  });
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Sharpen tab took too long to load.'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function getOrCreateSharpenTab() {
  const tabs = await chrome.tabs.query({});
  const sharpenTab = tabs.find((tab) => tab.url?.startsWith(SHARPEN_ORIGIN));
  if (sharpenTab?.id) return sharpenTab;
  return chrome.tabs.create({ url: SHARPEN_DASHBOARD_URL });
}

async function focusTab(tab) {
  if (!tab?.id) throw new Error('Could not locate a Sharpen tab.');
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id, { active: true });
}

async function injectDialValueIntoSharpen(tabId, dialValue, customer = {}) {
  const normalizedDialValue = normalizeDialNumber(dialValue);
  if (!normalizedDialValue) throw new Error('No dial number was provided.');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async ({ value, customerName, billingNumber, customerNumber }) => {
      const normalize = (textValue) => String(textValue || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (element) => Boolean(element && element.getClientRects().length);
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const dispatchInputEvents = (input) => {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setNativeValue = (input, nextValue) => {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(input, nextValue);
      };
      const findClickableAncestor = (element) => {
        if (!element) return null;
        return element.closest('button,a,[role="button"],.btn,.button,.connectq');
      };

      const findDialInput = () => {
        const sharpenCallSpan = document.querySelector('span.text--call.audio-call-content.connectq');
        const callButton = findClickableAncestor(sharpenCallSpan)
          || [...document.querySelectorAll('button,a,[role="button"]')]
            .find((element) => visible(element) && normalize(element.textContent).includes('call'));
        if (callButton) {
          const container = callButton.closest('div,form,section') || callButton.parentElement;
          if (container) {
            const nearbyInput = [...container.querySelectorAll('input')]
              .find((input) => visible(input) && !input.disabled && !input.readOnly && input.type !== 'hidden');
            if (nearbyInput) return nearbyInput;
          }
        }
        return [...document.querySelectorAll('input')].find((input) => {
          if (!visible(input) || input.disabled || input.readOnly || input.type === 'hidden') return false;
          const placeholder = normalize(input.placeholder);
          const ariaLabel = normalize(input.getAttribute('aria-label'));
          return placeholder.includes('number') || placeholder.includes('phone') || ariaLabel.includes('number') || ariaLabel.includes('phone');
        }) || null;
      };

      const dialInput = findDialInput();
      if (!dialInput) return { ok: false, reason: 'dial input not found' };

      dialInput.focus();
      setNativeValue(dialInput, value);
      dispatchInputEvents(dialInput);

      const metadata = [customerName, billingNumber, customerNumber].filter(Boolean).join(' | ');
      if (metadata) {
        dialInput.setAttribute('data-esg-customer', metadata);
      }

      // Short delay allows Sharpen listeners to react to the populated value before submit.
      await wait(220);

      dialInput.focus();
      dialInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      dialInput.dispatchEvent(new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      dialInput.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));

      return { ok: true };
    },
    args: [{
      value: normalizedDialValue,
      customerName: String(customer.name || '').trim(),
      billingNumber: String(customer.billingNumber || '').trim(),
      customerNumber: String(customer.customerNumber || '').trim()
    }]
  });

  if (result?.result?.ok) return;

  throw new Error('Could not find the Sharpen dial field. Keep Sharpen logged in and on the dashboard, then try Dial again.');
}

function scheduleBootstrap(tabId, delayMs, expectedLookupId = '') {
  const state = lookups.get(tabId);
  if (!state) return;
  if (expectedLookupId && state.lookupId !== expectedLookupId) return;
  if (state.bootstrapTimer) clearTimeout(state.bootstrapTimer);

  state.bootstrapTimer = setTimeout(() => {
    const latest = lookups.get(tabId);
    if (!latest) return;
    if (expectedLookupId && latest.lookupId !== expectedLookupId) return;

    const lookupId = latest.lookupId;
    if (!lookupId) return;

    latest.bootstrapTimer = null;
    if (latest.inFlightStep === latest.step) return;

    bootstrapLookupStep(tabId, lookupId)
      .catch((error) => {
        if (isTransientFrameError(error) && latest.bootstrapRetryCount < MAX_BOOTSTRAP_RETRIES) {
          latest.bootstrapRetryCount += 1;
          scheduleBootstrap(tabId, SEARCH_BOOTSTRAP_DELAY_MS, lookupId);
          return;
        }
        finish(tabId, { ok: false, error: `Could not continue lookup after navigation: ${error.message}` }, lookupId);
      });
  }, Math.max(0, delayMs));
}

function isTransientFrameError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('frame with id')
    || message.includes('frame was removed')
    || message.includes('cannot access contents of the page')
    || message.includes('a listener indicated an asynchronous response by returning true');
}

function transitionLookupStep(tabId, lookupId, nextStep, { delayMs = DEFAULT_BOOTSTRAP_DELAY_MS, navigateUrl = '' } = {}) {
  const state = lookups.get(tabId);
  if (!state || state.lookupId !== lookupId) return;

  state.step = nextStep;
  state.bootstrapRetryCount = 0;

  if (navigateUrl) {
    chrome.tabs.update(tabId, { url: navigateUrl })
      .catch((error) => finish(tabId, { ok: false, error: `Could not continue lookup after navigation: ${error.message}` }, lookupId));
    return;
  }

  scheduleBootstrap(tabId, delayMs, lookupId);
}

function bootstrapLookupStep(tabId, lookupId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => sendStep(tabId, 0, lookupId));
}

function searchNumberFromBillingNumber(billingNumber) {
  const baseNumber = billingNumber.split('-')[0].replace(/\D/g, '');
  return baseNumber.padStart(8, '0'); // by Mo.A and Avery. H
}

function parsePortalDate(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '—' || normalized === '-') return null;

  const monthNames = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };

  const monthNameMatch = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthNameMatch) {
    const monthIndex = monthNames[monthNameMatch[1].toLowerCase()];
    if (Number.isInteger(monthIndex)) {
      const day = Number(monthNameMatch[2]);
      const year = Number(monthNameMatch[3]);
      const parsed = new Date(year, monthIndex, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  const numericMatch = normalized.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (numericMatch) {
    const month = Number(numericMatch[1]);
    const day = Number(numericMatch[2]);
    const yearPart = Number(numericMatch[3]);
    const year = yearPart < 100 ? 2000 + yearPart : yearPart;
    const parsed = new Date(year, month - 1, day);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp); // by Mo.A and Avery. H
}

function threeMonthsFromToday() {
  const threshold = new Date();
  threshold.setMonth(threshold.getMonth() + 3);
  return threshold;
}

function parseSummaryGroupCounts(summaryText) {
  const text = String(summaryText || '');
  const countFrom = (label) => {
    const match = text.match(new RegExp(`${label}\\s+(\\d+)`, 'i'));
    return match ? Number(match[1]) : 0;
  };

  return {
    billGroups: countFrom('bill groups'),
    active: countFrom('active'),
    inactive: countFrom('inactive'),
    closed: countFrom('closed')
  };
}

function buildManualReviewAlert(data) {
  const accountStatus = String(data?.accountStatus || '').toLowerCase();
  const renewalStatus = String(data?.renewalStatus || '').toLowerCase();
  const counts = parseSummaryGroupCounts(data?.customerSummaryGroups);

  // A second billing account needs manual review only when this lookup itself found a renewal.
  // An Active account with "No renewal found" should remain a no-renewal result.
  const hasRenewal = renewalStatus.includes('renewed/active')
    || renewalStatus.includes('active/renewed')
    || renewalStatus.includes('renewed');
  const hasTwoBillingAccounts = counts.billGroups === 2;

  if (hasTwoBillingAccounts && hasRenewal) {
    return 'Customer has 2 billing accounts and this one shows Active/Renewed. Manually check the second account in the portal.';
  }

  const isCurrentClosed = accountStatus.includes('closed');
  if (!isCurrentClosed) return '';
  if (counts.active <= 0) return '';
  return 'Current account shows Closed while another Active account exists. Manually check the portal page.';
}

async function getCustomerNameFromPage(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => normalize(value).toLowerCase();
        const visible = (element) => Boolean(element && element.getClientRects().length);
        const text = (element) => normalize(element?.textContent);
        const normalizedLabel = (value) => lower(value).replace(/\s*:\s*$/, '');

        function readLabelValue(labelText) {
          const expected = normalizedLabel(labelText);
          const labels = [...document.querySelectorAll('body *')]
            .filter((element) => visible(element) && normalizedLabel(text(element)) === expected);

          for (const label of labels) {
            const parent = label.parentElement;
            if (!parent) continue;
            const nextElement = label.nextElementSibling;
            if (nextElement && text(nextElement)) return text(nextElement);
            const sibling = [...parent.children].find((element) => element !== label && text(element));
            if (sibling) return text(sibling);
          }

          const lines = (document.body.innerText || '').split(/\r?\n/).map(normalize).filter(Boolean);
          const labelIndex = lines.findIndex((line) => normalizedLabel(line) === expected);
          return labelIndex >= 0 ? (lines[labelIndex + 1] || '') : '';
        }

        return readLabelValue('Customer Name');
      }
    });

    return String(result?.result || '').trim();
  } catch {
    return '';
  }
}

async function sendStep(tabId, attempt = 0, expectedLookupId = '') {
  const state = lookups.get(tabId);
  if (!state) return;
  if (expectedLookupId && state.lookupId !== expectedLookupId) return;
  if (state.inFlightStep === state.step) return;

  state.inFlightStep = state.step;
  const lookupId = state.lookupId;

  try {
    state.bootstrapRetryCount = 0;
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'RUN_STEP',
      step: state.step,
      customerNumber: state.customerNumber,
      lookupId
    });
    if (response?.ok === false) {
      finish(tabId, { ok: false, error: response.error }, lookupId);
    }
  } catch (error) {
    state.inFlightStep = null;
    if (attempt < 3) {
      setTimeout(() => sendStep(tabId, attempt + 1, expectedLookupId || lookupId), 250);
    } else {
      finish(tabId, { ok: false, error: `Could not communicate with the portal tab: ${error.message}` }, lookupId);
    }
  }
}

async function finish(tabId, result, expectedLookupId = '') {
  const state = lookups.get(tabId);
  if (!state) return;
  if (expectedLookupId && state.lookupId !== expectedLookupId) return;

  if (state.bootstrapTimer) clearTimeout(state.bootstrapTimer);
  lookups.delete(tabId);

  if (result.ok) {
    await chrome.storage.session.set({ lastResult: result.data });
  }

  const waiter = lookupCompletionWaiters.get(state.lookupId);
  if (waiter) waiter.resolve(result);

  chrome.runtime.sendMessage({ type: 'LOOKUP_FINISHED', requestId: state.lookupId, ...result }).catch(() => {});
}

// by Mo and Avery
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.type === 'START_LOOKUP') {
    try {
      const lookupId = startPortalLookup(tabId, message.billingNumber, String(message.requestId || createLookupId()));
      sendResponse({ ok: true, requestId: lookupId });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || 'Could not start lookup.' });
    }
    return true;
  }

  if (message.type === 'START_RENEWAL_RADAR') {
    if (radarRun) {
      sendResponse({ ok: false, error: 'Renewal Radar is already running.' });
      return true;
    }
    Promise.resolve().then(async () => {
      const billingNumbers = Array.isArray(message.billingNumbers)
        ? message.billingNumbers.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (!Number.isInteger(tabId)) throw new Error('Could not identify the portal tab for Renewal Radar.');
      if (!billingNumbers.length) throw new Error('No billing numbers were provided for Renewal Radar.');

      // Radar uses its own inactive portal tab so it never navigates the tab the user is viewing.
      const radarTab = await createRadarPortalTab(tabId);
      if (!Number.isInteger(radarTab?.id)) throw new Error('Could not create a separate portal tab for Renewal Radar.');

      radarRun = {
        tabId: radarTab.id,
        billingNumbers,
        totalCount: Number(message.totalCount || billingNumbers.length),
        processedCount: 0,
        currentBillingNumber: '',
        renewedEntries: [],
        notRenewedCount: 0,
        unknownEntries: Array.isArray(message.inputUnknownEntries) ? message.inputUnknownEntries : [],
        retryRecoveredCount: 0,
        stopRequested: false,
        status: 'running'
      };
      runRenewalRadar(radarRun);
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || 'Could not start Renewal Radar.' });
    });
    return true;
  }

  if (message.type === 'STOP_RENEWAL_RADAR') {
    if (!radarRun || radarRun.status !== 'running') {
      sendResponse({ ok: false, error: 'Renewal Radar is not currently running.' });
      return true;
    }
    radarRun.stopRequested = true;
    radarRun.status = 'stopping';
    publishRadarState(radarRun).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'DIAL_CUSTOMER') {
    Promise.resolve().then(async () => {
      const dialValue = normalizeDialNumber(message.dialValue);
      if (!dialValue) throw new Error('No phone number available to dial.');

      const sharpenTab = await getOrCreateSharpenTab();
      if (!sharpenTab?.id) throw new Error('Could not open Sharpen tab.');

      await focusTab(sharpenTab);
      await waitForTabComplete(sharpenTab.id, 25000);
      await injectDialValueIntoSharpen(sharpenTab.id, dialValue, message.customer || {});

      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || 'Dial failed.' });
    });
    return true;
  }

  if (message.type !== 'LOOKUP_STEP') return;
  const state = lookups.get(tabId);
  if (!state) return;
  if (message.lookupId && state.lookupId !== message.lookupId) return;

  const lookupId = state.lookupId;
  state.inFlightStep = null;

  if (message.action === 'SEARCH_SUBMITTED') {
    if (message.data?.customerNumber) state.customerNumber = message.data.customerNumber;
    transitionLookupStep(tabId, lookupId, 'summary');
  }

  if (message.action === 'SUMMARY_READY') {
    state.data = { ...state.data, ...message.data };
    transitionLookupStep(tabId, lookupId, 'account', { navigateUrl: message.data.accountHref });
  }

  if (message.action === 'CONTRACTS_TAB_SELECTED') {
    const nextStatus = String(message.data?.accountStatus || '').trim();
    state.data = {
      ...state.data,
      ...message.data,
      accountStatus: nextStatus || state.data.accountStatus || ''
    };
    transitionLookupStep(tabId, lookupId, 'contracts');
  }

  if (message.action === 'CONTRACTS_READY') {
    const rows = Array.isArray(message.data?.rows) ? message.data.rows : [];
    const rowsWithDates = rows.map((row) => ({
      row,
      endDate: parsePortalDate(row?.end),
      startDate: parsePortalDate(row?.start)
    }));

    const sortedRows = [...rowsWithDates].sort((first, second) => {
      const secondEnd = second.endDate ? second.endDate.getTime() : -Infinity;
      const firstEnd = first.endDate ? first.endDate.getTime() : -Infinity;
      if (secondEnd !== firstEnd) return secondEnd - firstEnd;

      const secondStart = second.startDate ? second.startDate.getTime() : -Infinity;
      const firstStart = first.startDate ? first.startDate.getTime() : -Infinity;
      return secondStart - firstStart;
    }).map((entry) => entry.row);

    const [current, renewal] = sortedRows;
    const latestEndDate = parsePortalDate(current?.end) || null;
    const threshold = threeMonthsFromToday();

    let renewalStatus = 'No renewal found';
    if (latestEndDate && latestEndDate > threshold) {
      renewalStatus = 'Renewed/Active';
    } else if (!latestEndDate && renewal) {
      renewalStatus = 'Renewed/Active';
    }

    getCustomerNameFromPage(tabId).then((finalCustomerName) => {
      const latestState = lookups.get(tabId);
      if (!latestState || latestState.lookupId !== lookupId) return;

      const mergedData = {
        ...latestState.data,
        customerName: finalCustomerName || latestState.data.customerName || '',
        billingNumber: latestState.billingNumber,
        accountStatus: latestState.data.accountStatus || '',
        currentContractEnd: current?.end || '',
        renewalStart: renewal?.start || '',
        renewalEnd: renewal?.end || '',
        renewalStatus
      };

      mergedData.manualReviewAlert = buildManualReviewAlert(mergedData);

      finish(tabId, {
        ok: true,
        data: mergedData
      }, lookupId);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && lookups.has(tabId)) {
    const state = lookups.get(tabId);
    if (!state) return;
    const delay = state.step === 'search' ? SEARCH_BOOTSTRAP_DELAY_MS : DEFAULT_BOOTSTRAP_DELAY_MS;
    scheduleBootstrap(tabId, delay, state.lookupId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => lookups.delete(tabId));
