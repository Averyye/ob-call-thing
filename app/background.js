const lookups = new Map();
const PORTAL_SEARCH_URL = 'https://affordable-ep.esgglobal.net/enterpriseportal/home/customers/customerSearch';
const SHARPEN_DASHBOARD_URL = 'https://app.iz1.sharpen.cx/fathomQ/dashboard/';
const SHARPEN_ORIGIN = 'https://app.iz1.sharpen.cx/';
const SEARCH_BOOTSTRAP_DELAY_MS = 300;
const DEFAULT_BOOTSTRAP_DELAY_MS = 40;

function normalizeDialNumber(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) return digitsOnly.slice(1);
  return digitsOnly;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: ({ value, customerName, billingNumber, customerNumber }) => {
        const normalize = (textValue) => String(textValue || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = (element) => Boolean(element && element.getClientRects().length);
        const dispatchInputEvents = (input) => {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const setNativeValue = (input, nextValue) => {
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          valueSetter?.call(input, nextValue);
        };
        const findDialInput = () => {
          const callButton = [...document.querySelectorAll('button,a,[role="button"]')]
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
    await delay(500);
  }

  throw new Error('Could not find the Sharpen dial field. Keep Sharpen logged in and on the dashboard, then try Dial again.');
}

function scheduleBootstrap(tabId, delayMs) {
  const state = lookups.get(tabId);
  if (!state) return;
  if (state.bootstrapTimer) clearTimeout(state.bootstrapTimer);
  state.bootstrapTimer = setTimeout(() => {
    state.bootstrapTimer = null;
    if (!lookups.has(tabId)) return;
    if (state.inFlightStep === state.step) return;
    bootstrapLookupStep(tabId)
    //by Mo.A and Avery. H
      .catch((error) => finish(tabId, { ok: false, error: `Could not continue lookup after navigation: ${error.message}` }));
  }, Math.max(0, delayMs));
}

function bootstrapLookupStep(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => sendStep(tabId));
}

function searchNumberFromBillingNumber(billingNumber) {
  const baseNumber = billingNumber.split('-')[0].replace(/\D/g, '');
  return baseNumber.padStart(8, '0');//by Mo.A and Avery. H
}

function parsePortalDate(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '—' || normalized === '-') return null;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);//by Mo.A and Avery. H
}
//by Mo.A and Avery. H
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

async function sendStep(tabId, attempt = 0) {
  const state = lookups.get(tabId);
  if (!state) return;
  if (state.inFlightStep === state.step) return;
  state.inFlightStep = state.step;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'RUN_STEP',
      step: state.step,
      customerNumber: state.customerNumber
    });
    if (response?.ok === false) finish(tabId, { ok: false, error: response.error });
  } catch (error) {
    state.inFlightStep = null;
    if (attempt < 3) {
      setTimeout(() => sendStep(tabId, attempt + 1), 250);
    } else {
      finish(tabId, { ok: false, error: `Could not communicate with the portal tab: ${error.message}` });
    }
  }
}

async function finish(tabId, result) {
  const state = lookups.get(tabId);
  if (state?.bootstrapTimer) clearTimeout(state.bootstrapTimer);
  lookups.delete(tabId);
  if (result.ok) await chrome.storage.session.set({ lastResult: result.data });
  chrome.runtime.sendMessage({ type: 'LOOKUP_FINISHED', ...result }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;
  if (message.type === 'START_LOOKUP') {
    const billingNumber = message.billingNumber.trim();
    lookups.set(tabId, {
      step: 'search',
      customerNumber: searchNumberFromBillingNumber(billingNumber),
      billingNumber,
      data: {},
      inFlightStep: null,
      bootstrapTimer: null
    });
    chrome.tabs.update(tabId, { url: PORTAL_SEARCH_URL })
      .then(() => scheduleBootstrap(tabId, SEARCH_BOOTSTRAP_DELAY_MS))
      .catch((error) => finish(tabId, { ok: false, error: `Could not start the portal script: ${error.message}` }));
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
  // mo and avery made
  if (message.type !== 'LOOKUP_STEP') return;
  const state = lookups.get(tabId);
  if (!state) return;
  state.inFlightStep = null;
  if (message.action === 'SEARCH_SUBMITTED') {
    if (message.data?.customerNumber) state.customerNumber = message.data.customerNumber;
    state.step = 'summary';
    scheduleBootstrap(tabId, DEFAULT_BOOTSTRAP_DELAY_MS);
  }
  if (message.action === 'SUMMARY_READY') {
    state.data = { ...state.data, ...message.data };
    state.step = 'account';
    chrome.tabs.update(tabId, { url: message.data.accountHref });
  }
  if (message.action === 'CONTRACTS_TAB_SELECTED') {
    state.data = { ...state.data, ...message.data };
    state.step = 'contracts';
    scheduleBootstrap(tabId, DEFAULT_BOOTSTRAP_DELAY_MS);
  }
  if (message.action === 'CONTRACTS_READY') {// mo and avery made
    const [current, renewal] = message.data.rows;
    const parsedEndDates = (message.data.rows || [])
      .map((row) => parsePortalDate(row?.end))
      .filter(Boolean)
      .sort((first, second) => first - second);
    const latestEndDate = parsedEndDates[parsedEndDates.length - 1] || null;
    const threshold = threeMonthsFromToday();

    let renewalStatus = 'No renewal found';
    if (latestEndDate && latestEndDate > threshold) {
      renewalStatus = 'Renewed/Active';
    } else if (!latestEndDate && renewal) {
      renewalStatus = 'Renewed/Active';
    }

    getCustomerNameFromPage(tabId).then((finalCustomerName) => {
      finish(tabId, { ok: true, data: {
        ...state.data,
        customerName: finalCustomerName || state.data.customerName || '',
        billingNumber: state.billingNumber,
        accountStatus: state.data.accountStatus || '',
        currentContractEnd: current?.end || '',
        renewalStart: renewal?.start || '',
        renewalEnd: renewal?.end || '',
        renewalStatus
      } });
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && lookups.has(tabId)) {
    const state = lookups.get(tabId);
    if (!state) return;
    const delay = state.step === 'search' ? SEARCH_BOOTSTRAP_DELAY_MS : DEFAULT_BOOTSTRAP_DELAY_MS;
    scheduleBootstrap(tabId, delay);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => lookups.delete(tabId));
