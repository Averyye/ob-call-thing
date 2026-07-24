const lookups = new Map();
const PORTAL_SEARCH_URL = 'https://affordable-ep.esgglobal.net/enterpriseportal/home/customers/customerSearch';
const SHARPEN_DASHBOARD_URL = 'https://app.iz1.sharpen.cx/fathomQ/dashboard/';
const SHARPEN_ORIGIN = 'https://app.iz1.sharpen.cx/';
const SEARCH_BOOTSTRAP_DELAY_MS = 300;
const DEFAULT_BOOTSTRAP_DELAY_MS = 40; // by Mo and Avery
let nextLookupId = 1;

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
      .catch((error) => finish(tabId, { ok: false, error: `Could not continue lookup after navigation: ${error.message}` }, lookupId));
  }, Math.max(0, delayMs));
}

function transitionLookupStep(tabId, lookupId, nextStep, { delayMs = DEFAULT_BOOTSTRAP_DELAY_MS, navigateUrl = '' } = {}) {
  const state = lookups.get(tabId);
  if (!state || state.lookupId !== lookupId) return;

  state.step = nextStep;

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

  chrome.runtime.sendMessage({ type: 'LOOKUP_FINISHED', requestId: state.lookupId, ...result }).catch(() => {});
}

// by Mo and Avery
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.type === 'START_LOOKUP') {
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: 'Could not identify the portal tab for this lookup.' });
      return true;
    }

    const billingNumber = String(message.billingNumber || '').trim();
    if (!billingNumber) {
      sendResponse({ ok: false, error: 'Billing number is required.' });
      return true;
    }

    const lookupId = String(message.requestId || createLookupId());
    lookups.set(tabId, {
      lookupId,
      step: 'search',
      customerNumber: searchNumberFromBillingNumber(billingNumber),
      billingNumber,
      data: {},
      inFlightStep: null,
      bootstrapTimer: null
    });

    chrome.tabs.update(tabId, { url: PORTAL_SEARCH_URL })
      .then(() => scheduleBootstrap(tabId, SEARCH_BOOTSTRAP_DELAY_MS, lookupId))
      .catch((error) => finish(tabId, { ok: false, error: `Could not start the portal script: ${error.message}` }, lookupId));

    sendResponse({ ok: true, requestId: lookupId });
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

      finish(tabId, {
        ok: true,
        data: {
          ...latestState.data,
          customerName: finalCustomerName || latestState.data.customerName || '',
          billingNumber: latestState.billingNumber,
          accountStatus: latestState.data.accountStatus || '',
          currentContractEnd: current?.end || '',
          renewalStart: renewal?.start || '',
          renewalEnd: renewal?.end || '',
          renewalStatus
        }
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
