const ESG_LOOKUP_CONTENT_VERSION = '2026-07-24-requestid-v1';
if (globalThis.__esgLookupContentVersion !== ESG_LOOKUP_CONTENT_VERSION) {
  globalThis.__esgLookupContentVersion = ESG_LOOKUP_CONTENT_VERSION;
(() => {
  const PORTAL_ORIGIN = 'https://affordable-ep.esgglobal.net';
  const SEARCH_PATH = '/enterpriseportal/home/customers/customerSearch';
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim(); // by Mo and Avery
  const lower = (value) => normalize(value).toLowerCase();
  const digits = (value) => normalize(value).replace(/\D/g, '');
  const customerNumberWithPadding = (value) => digits(value).padStart(8, '0');
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const text = (element) => normalize(element?.textContent); //by Mo.A and Avery. H
  const normalizedLabel = (value) => lower(value).replace(/\s*:\s*$/, '');
  let activeLookupId = '';

  function elementsWithText(value) {
    const expected = lower(value);
    return [...document.querySelectorAll('a,button,[role="tab"],input,label,th,td,span,div')]
      .filter((element) => visible(element) && lower(text(element)) === expected);
  }

  function findInput(labelText, placeholderText) {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const byPlaceholder = inputs.find((input) => lower(input.placeholder).includes(lower(placeholderText)));
    if (byPlaceholder) return byPlaceholder; //by Mo.A and Avery. H
    const label = elementsWithText(labelText)[0];
    if (label?.htmlFor) return document.getElementById(label.htmlFor);
    return inputs.find((input) => input.type !== 'hidden');
  }//by Mo.A and Avery. H

  function isInputInteractive(input) {
    return Boolean(
      input
      && visible(input)
      && !input.disabled
      && !input.readOnly
      && input.type !== 'hidden'
    );
  }//by Mo.A and Avery. H

  function findCustomerLink(customerNumber) {
    const expected = normalize(customerNumber);
    return [...document.querySelectorAll('a')]
      .find((link) => {
        const linkText = normalize(text(link));
        return visible(link) && linkText === expected;
      });
  }

  function findLink(labelText) {
    const expected = lower(labelText);
    return [...document.querySelectorAll('a')]
      .find((link) => visible(link) && lower(text(link)) === expected);
  }

  function findTab(labelText) {
    const expected = lower(labelText);
    const tabs = [...document.querySelectorAll('a,button,[role="tab"]')]
      .filter(visible);
    return tabs.find((tab) => lower(text(tab)) === expected)
      || tabs.find((tab) => lower(text(tab)).includes(expected));
  }

  // by Mo and Avery

  function clickByText(value) {
    const target = elementsWithText(value)
      .sort((a, b) => a.tagName === 'A' ? -1 : b.tagName === 'A' ? 1 : a.children.length - b.children.length)[0];
    if (!target) return false;
    target.click();
    return true;
  }

  function extractCustomerNameFromResultRow(row, customerNumber) {
    if (!row) return '';
    const expectedNumber = normalize(customerNumber);
    const expectedDigits = digits(customerNumber);
    const isCustomerNumber = (value) => {
      const normalizedValue = normalize(value);
      const digitsValue = digits(value);
      return normalizedValue === expectedNumber || (digitsValue && digitsValue === expectedDigits);
    };

    const anchorCandidates = [...row.querySelectorAll('a')]
      .map(text)
      .filter((value) => value && /[a-z]/i.test(value) && !isCustomerNumber(value));
    if (anchorCandidates.length) return anchorCandidates[0];

    const cellCandidates = [...row.querySelectorAll('td,[role="cell"],span,div')]
      .map(text)
      .filter((value) => value && /[a-z]/i.test(value) && !isCustomerNumber(value));
    if (cellCandidates.length) return cellCandidates[0];

    return '';
  }

  function findValue(labelText) {
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
      const nestedValue = [...parent.querySelectorAll('*')]
        .filter((element) => visible(element) && element !== label && text(element))
        .filter((element) => ![...element.children].some((child) => text(child)))
        .sort((first, second) => first.children.length - second.children.length)[0];
      if (nestedValue) return text(nestedValue);
      const parts = text(parent).split(/\s{2,}|:/).map(normalize).filter(Boolean);
      if (parts.length > 1) return parts[parts.length - 1];
    }
    const lines = (document.body.innerText || '').split(/\r?\n/).map(normalize).filter(Boolean);
    const labelIndex = lines.findIndex((line) => normalizedLabel(line) === expected);
    if (labelIndex >= 0) return lines[labelIndex + 1] || '';
    return '';
  }

  function findAccountStatus() {
    const sanitizeStatusValue = (value) => {
      const normalized = normalize(value);
      if (!normalized) return '';

      // Some layouts keep multiple labels on one line; cut status at the next known label.
      const cutoffMatch = normalized.match(/\b(service address|total balance|account balance|last payment|autopay|last bill|commodity price|service contract|flow dates|territory|pricing plan|revenue class|bill method)\b/i);
      const clipped = cutoffMatch ? normalized.slice(0, cutoffMatch.index).trim() : normalized;
      return clipped.replace(/\s*\/\s*/g, '/');
    };

    const pickBestStatus = (candidates) => {
      const cleaned = [...new Set(candidates.map(sanitizeStatusValue).filter(Boolean))];
      if (!cleaned.length) return '';
      const score = (value) => {
        const v = lower(value);
        let points = value.length;
        if (v.includes('pending')) points += 80;
        if (v.includes('/')) points += 45;
        if (v.includes('move-out') || v.includes('move out') || v.includes('drop')) points += 35;
        if (v.includes('active')) points += 20;
        if (v.includes('closed') || v.includes('inactive') || v.includes('cancel')) points += 10;
        return points;
      };
      return cleaned.sort((first, second) => score(second) - score(first))[0];
    };

    const fromLabel = sanitizeStatusValue(findValue('Status'));
    const bodyText = String(document.body.innerText || '');
    const lines = bodyText.split(/\r?\n/).map(normalize).filter(Boolean);

    // Prefer explicit "STATUS: ..." lines when present because they include full compound values.
    const inlineStatus = lines
      .map((line) => {
        const match = line.match(/^status\s*:\s*(.+)$/i);
        return match ? sanitizeStatusValue(match[1]) : '';
      })
      .find(Boolean);

    // Some pages render STATUS on one line and value on the next line.
    let nextLineStatus = '';
    const statusOnlyIndex = lines.findIndex((line) => /^status\s*:?$/i.test(line));
    if (statusOnlyIndex >= 0) {
      nextLineStatus = sanitizeStatusValue(lines[statusOnlyIndex + 1] || '');
    }

    // Raw text regex fallback catches layouts where label/value are rendered inline without easy DOM siblings.
    const regexMatch = bodyText.match(/(?:^|\n)\s*status\s*[:：]\s*([^\n\r]+)/i);
    const regexStatus = sanitizeStatusValue(regexMatch?.[1] || '');

    // DOM sibling fallback handles key/value blocks where STATUS is one element and value is another.
    const domCandidates = [];
    const statusLabels = [...document.querySelectorAll('label,span,div,td,strong,b')]
      .filter((element) => visible(element) && /^status\s*:?$/i.test(normalize(text(element))));
    for (const labelElement of statusLabels) {
      const siblingValue = sanitizeStatusValue(text(labelElement.nextElementSibling));
      if (siblingValue) domCandidates.push(siblingValue);

      const parent = labelElement.parentElement;
      if (!parent) continue;
      const siblingParts = [...parent.children]
        .filter((child) => child !== labelElement)
        .map(text)
        .filter(Boolean);
      if (siblingParts.length) domCandidates.push(sanitizeStatusValue(siblingParts.join(' ')));
    }
    const domStatus = domCandidates
      .sort((first, second) => second.length - first.length)[0] || '';

    const slashLineCandidate = lines.find((line) => /active\s*\/\s*pending/i.test(line) || /pending\s*(move-out|move out|drop)/i.test(line)) || '';
    const compositeBodyMatch = bodyText.match(/\b(active\s*\/\s*pending[^\n\r]*)/i);
    const compositeStatus = sanitizeStatusValue(compositeBodyMatch?.[1] || '');

    return pickBestStatus([
      compositeStatus,
      slashLineCandidate,
      inlineStatus,
      nextLineStatus,
      regexStatus,
      domStatus,
      fromLabel
    ]);
  }

  function contractRows() {
    for (const table of document.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('th,[role="columnheader"]')].map((header) => lower(text(header)));
      const startIndex = headers.findIndex((header) => header === 'start date');
      const endIndex = headers.findIndex((header) => header === 'end date');
      if (startIndex < 0 || endIndex < 0) continue;
      const rows = [...table.querySelectorAll('tbody tr,tr,[role="row"]')].map((row) => {
        const cells = [...row.querySelectorAll('td,[role="cell"]')].map(text);
        return { start: cells[startIndex] || '', end: cells[endIndex] || '' };
      }).filter((row) => row.start && row.end && lower(row.start) !== 'start date' && lower(row.end) !== 'end date');
      if (rows.length) return rows;
    }
    const headers = [...document.querySelectorAll('th,[role="columnheader"]')].map((header) => lower(text(header)));
    const startIndex = headers.findIndex((header) => header === 'start date');
    const endIndex = headers.findIndex((header) => header === 'end date');
    if (startIndex < 0 || endIndex < 0) return [];
    return [...document.querySelectorAll('tbody tr,tr,[role="row"]')].map((row) => {
      const cells = [...row.querySelectorAll('td,[role="cell"]')].map(text);
      return { start: cells[startIndex] || '', end: cells[endIndex] || '' };
    }).filter((row) => row.start && row.end && lower(row.start) !== 'start date' && lower(row.end) !== 'end date');
  }

  function waitFor(predicate, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const value = predicate();
        if (value) return resolve(value);
        if (Date.now() - started >= timeout) return reject(new Error('The portal did not finish loading the expected results.'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function post(action, data = {}) {
    chrome.runtime.sendMessage({ type: 'LOOKUP_STEP', action, data, lookupId: activeLookupId });
  }

  async function ensureOnCustomerSearchPage() {
    const expectedUrl = `${PORTAL_ORIGIN}${SEARCH_PATH}`;
    if (!location.href.startsWith(expectedUrl)) {
      location.href = expectedUrl;
      await waitFor(() => location.href.startsWith(expectedUrl));
    }
    await waitFor(() => {
      const input = findInput('Customer Number', 'customer number');
      return isInputInteractive(input) ? input : null;
    }, 12000);
  }

  async function runSearch(customerNumber) {
    await ensureOnCustomerSearchPage();
    const normalizedCustomerNumber = customerNumberWithPadding(customerNumber);
    const input = await waitFor(() => {
      const candidate = findInput('Customer Number', 'customer number');
      return isInputInteractive(candidate) ? candidate : null;
    }, 12000);
    if (!input) throw new Error('Could not find the Customer Number field.');

    const submitSearch = async (resultTimeout) => {
      input.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, normalizedCustomerNumber);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      if (!clickByText('Search')) input.form?.requestSubmit();
      return waitFor(() => findCustomerLink(normalizedCustomerNumber), resultTimeout);
    };

    try {
      await submitSearch(7000);
    } catch {
      // One retry handles brief portal lag without forcing every lookup to wait long.
      await submitSearch(12000);
    }
    post('SEARCH_SUBMITTED', { customerNumber: normalizedCustomerNumber });
  }

  async function runSummary(customerNumber) {
    const resultLink = await waitFor(() => findCustomerLink(customerNumber));
    if (!resultLink) throw new Error('No account was found for that customer number.');
    const row = resultLink.closest('tr');
    const customerNameFromResults = extractCustomerNameFromResultRow(row, customerNumber)
      || text(row?.querySelectorAll('a')[1]);
    const searchUrl = location.href;
    resultLink.click();
    await waitFor(() => location.href !== searchUrl || lower(document.body.innerText).includes('customer summary'));
    await waitFor(() => findLink('Account'));
    const accountHref = findLink('Account')?.href;
    if (!accountHref) throw new Error('Could not find the Account link on the customer summary.');

    post('SUMMARY_READY', {
      customerName: customerNameFromResults || '',
      customerNumber,
      phone: findValue('Service Number') || findValue('Phone'),
      accountStatus: findAccountStatus() || findValue('Status') || '',
      accountHref
    });
  }

  async function runAccount() {
    let accountStatus = '';
    try {
      accountStatus = await waitFor(() => {
        const value = findAccountStatus();
        return value ? value : null;
      }, 7000);
    } catch {
      // Continue even if Status is late/missing so contracts can still load.
      accountStatus = findAccountStatus() || '';
    }
    const serviceContractsTab = await waitFor(() => findTab('Service Contracts'));
    serviceContractsTab.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    post('CONTRACTS_TAB_SELECTED', { accountStatus });
  }

  async function runContracts() {
    let rows;
    const readRows = () => {
      const loadedRows = contractRows();
      return loadedRows.length ? loadedRows : null;
    };

    try {
      rows = await waitFor(readRows, 15000);
    } catch {
      // Retry once with a longer window to handle slower portal renders.
      rows = await waitFor(readRows, 30000);
    }

    post('CONTRACTS_READY', { rows });
  }

  // by Mo and Avery
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'RUN_STEP') return;
    activeLookupId = String(message.lookupId || '');
    Promise.resolve().then(async () => {
      if (message.step === 'search') await runSearch(message.customerNumber);
      if (message.step === 'summary') await runSummary(message.customerNumber);
      if (message.step === 'account') await runAccount();
      if (message.step === 'contracts') await runContracts();
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
}
