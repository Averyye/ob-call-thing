const ESG_LOOKUP_CONTENT_VERSION = '2026-07-29-status-stability-v1';
if (globalThis.__esgLookupContentVersion !== ESG_LOOKUP_CONTENT_VERSION) {
  globalThis.__esgLookupContentVersion = ESG_LOOKUP_CONTENT_VERSION;
(() => {
  // portal route bits we keep reusing so no hardcoded chaos later
  const PORTAL_ORIGIN = 'https://affordable-ep.esgglobal.net';
  const SEARCH_PATH = '/enterpriseportal/home/customers/customerSearch';
  // tiny cleanup helpers so text compare dont get weird spacing issues
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim(); // by Mo and Avery
  const lower = (value) => normalize(value).toLowerCase();
  const digits = (value) => normalize(value).replace(/\D/g, '');
  const customerNumberWithPadding = (value) => digits(value).padStart(8, '0');
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const text = (element) => normalize(element?.textContent); //by Mo.A and Avery. H
  const normalizedLabel = (value) => lower(value).replace(/\s*:\s*$/, '');
  let activeLookupId = '';
  const ACCOUNT_FIELD_LABELS = new Set([
    'customer name',
    'billing number',
    'email',
    'phone',
    'service number',
    'service address',
    'status',
    'account',
    'territory',
    'flow dates',
    'bill method',
    'revenue class',
    'pricing plan',
    'commodity price',
    'service contract'
  ]);

  function elementsWithText(value) {
    // grabs visible nodes matching exact text after normalize/lower
    const expected = lower(value);
    return [...document.querySelectorAll('a,button,[role="tab"],input,label,th,td,span,div')]
      .filter((element) => visible(element) && lower(text(element)) === expected);
  }

  function findInput(labelText, placeholderText) {
    // first try placeholder cuz its fastest, label fallback after
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
    // result row has clickable customer number link
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
    // tries exact then contains cuz tab labels can have extra words
    const expected = lower(labelText);
    const tabs = [...document.querySelectorAll('a,button,[role="tab"]')]
      .filter(visible);
    return tabs.find((tab) => lower(text(tab)) === expected)
      || tabs.find((tab) => lower(text(tab)).includes(expected));
  }

  // by Mo and Avery

  function clickByText(value) {
    // sort prefers anchors then simpler elements so click target more stable
    const target = elementsWithText(value)
      .sort((a, b) => a.tagName === 'A' ? -1 : b.tagName === 'A' ? 1 : a.children.length - b.children.length)[0];
    if (!target) return false;
    target.click();
    return true;
  }

  function extractCustomerNameFromResultRow(row, customerNumber) {
    // in search table we want a name-like string thats not the acct number
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

  function extractCustomerSummaryGroupCounts() {
    // reads little counters like Bill Groups / Active / Inactive / Closed
    const labels = ['bill groups', 'active', 'inactive', 'closed'];
    const counts = {
      'bill groups': '',
      active: '',
      inactive: '',
      closed: ''
    };

    const elements = [...document.querySelectorAll('span,a,div,button')]
      .filter(visible)
      .map((element) => text(element))
      .filter(Boolean);

    for (const label of labels) {
      const pattern = new RegExp(`^${escapeRegExp(label)}\\s*(\\d+)$`, 'i');
      const matchText = elements.find((value) => pattern.test(normalize(value)));
      if (!matchText) continue;
      const match = normalize(matchText).match(pattern);
      if (match) counts[label] = match[1];
    }

    const hasAny = Object.values(counts).some(Boolean);
    if (!hasAny) return '';

    return `Bill Groups ${counts['bill groups'] || '?'} | Active ${counts.active || '?'} | Inactive ${counts.inactive || '?'} | Closed ${counts.closed || '?'}`;
  }

  function hasCompleteSummaryGroupCounts(value) {
    // make sure all four counters exist before trusting it
    const textValue = String(value || '');
    return /bill groups\s+\d+/i.test(textValue)
      && /active\s+\d+/i.test(textValue)
      && /inactive\s+\d+/i.test(textValue)
      && /closed\s+\d+/i.test(textValue);
  }

  function escapeRegExp(value) {
    // basic regex escape helper so dynamic label strings dont break patterns
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function sanitizedFieldValue(value) {
    // strips labels if ui smashes a bunch of fields onto one line
    const cleaned = normalize(value);
    if (!cleaned) return '';

    // Remove inline label prefixes from accidentally merged values (e.g., "PHONE: ... STATUS: ...").
    return cleaned
      .replace(/\b(customer name|billing number|email|phone|service number|status|service address|account|territory|flow dates|bill method|revenue class|pricing plan|commodity price|service contract)\s*:/ig, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function findValue(labelText, { allowLineFallback = true } = {}) {
    // tries dom first, text-line fallback second when markup is cursed
    const expected = normalizedLabel(labelText);
    const labelCandidates = [...document.querySelectorAll('label,th,td,span,div,strong,b')]
      .filter((element) => visible(element) && normalizedLabel(text(element)) === expected);

    const isLikelyLabelElement = (element) => ACCOUNT_FIELD_LABELS.has(normalizedLabel(text(element)));

    for (const label of labelCandidates) {
      // for/htmlFor path handles real label-input pairs
      if (label?.htmlFor) {
        const input = document.getElementById(label.htmlFor);
        const inputValue = sanitizedFieldValue(input?.value || '');
        if (inputValue) return inputValue;
      }

      const nextElementValue = sanitizedFieldValue(text(label.nextElementSibling));
      if (nextElementValue) return nextElementValue;

      const parent = label.parentElement;
      if (!parent) continue;

      const siblingValues = [...parent.children]
        .filter((element) => element !== label && visible(element) && !isLikelyLabelElement(element))
        .map((element) => sanitizedFieldValue(text(element)))
        .filter(Boolean)
        .sort((first, second) => first.length - second.length);

      if (siblingValues.length) return siblingValues[0];
    }

    if (!allowLineFallback) return '';

    const lines = (document.body.innerText || '').split(/\r?\n/).map(normalize).filter(Boolean);
    const inlineRegex = new RegExp(`^${escapeRegExp(labelText)}\\s*[:：]\\s*(.+)$`, 'i');
    for (const line of lines) {
      const match = line.match(inlineRegex);
      if (match) {
        const candidate = sanitizedFieldValue(match[1]);
        if (candidate) return candidate;
      }
    }

    const labelIndex = lines.findIndex((line) => normalizedLabel(line) === expected);
    if (labelIndex >= 0) return sanitizedFieldValue(lines[labelIndex + 1] || '');
    return '';
  }

  function findPhoneValue() {
    // phones can hide under Service Number or Phone so we test both
    const phoneLike = /\+?1?[-.\s(]*\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d+)?/i;
    const pickPhone = (value) => {
      const candidate = String(value || '');
      const match = candidate.match(phoneLike);
      return match ? normalize(match[0]) : '';
    };

    const fromServiceNumber = pickPhone(findValue('Service Number'));
    if (fromServiceNumber) return fromServiceNumber;

    const fromPhoneLabel = pickPhone(findValue('Phone'));
    if (fromPhoneLabel) return fromPhoneLabel;

    const lines = (document.body.innerText || '').split(/\r?\n/).map(normalize).filter(Boolean);
    for (const line of lines) {
      if (!/^phone\s*[:：]/i.test(line)) continue;
      const fromLine = pickPhone(line);
      if (fromLine) return fromLine;
    }

    return '';
  }

  function findAccountStatus() {
    // status extraction is messy so we score a bunch of candidates
    const STATUS_KEYWORD_REGEX = /\b(active|pending|inactive|closed|cancel(?:led|ed)?|drop(?:ped)?|move[\s-]?out|final)\b/i;
    const ACCOUNT_CONTEXT_REGEX = /\b(service address|account balance|total balance|last payment|autopay|last bill|commodity price|service contract|flow dates|territory|pricing plan|revenue class|bill method|phone|email)\b/i;
    const STATUS_FIELD_TEXT_REGEX = /\b(phone|email|service number|billing number|customer(?: name)?|service address|account balance|total balance|last payment|autopay|last bill|commodity price|service contract|flow dates|territory|pricing plan|revenue class|bill method)\b/i;
    const PHONE_OR_LONG_NUMBER_REGEX = /\d{3}[\s().-]*\d{3}[\s.-]*\d{4}|\d{5,}/;

    const sanitizeStatusValue = (value) => {
      // clip once another known field name appears after status text
      const normalized = normalize(value);
      if (!normalized) return '';

      // Some layouts keep multiple labels on one line; cut status at the next known label.
      const cutoffMatch = normalized.match(/\b(service address|total balance|account balance|last payment|autopay|last bill|commodity price|service contract|flow dates|territory|pricing plan|revenue class|bill method)\b/i);
      const clipped = cutoffMatch ? normalized.slice(0, cutoffMatch.index).trim() : normalized;
      return clipped
        .replace(/^status\s*[:：]?\s*/i, '')
        .replace(/\s*\/\s*/g, '/')
        .trim();
    };

    const isLikelyStatusValue = (value) => {
      // reject giant merged strings and obvious non-status values
      const candidate = sanitizeStatusValue(value);
      if (!candidate) return false;
      // Status values are short words such as "Active/Flowing" or "Pending Move-out".
      // Reject merged field text before looking for status keywords.
      if (candidate.length > 60) return false;
      if (candidate.includes(':')) return false;
      if (STATUS_FIELD_TEXT_REGEX.test(candidate)) return false;
      if (PHONE_OR_LONG_NUMBER_REGEX.test(candidate)) return false;
      if (!/^[a-z][a-z\s/\-]*$/i.test(candidate)) return false;
      if (/^(status|account|service address|bill method|pricing plan)\s*:?$/i.test(candidate)) return false;
      return STATUS_KEYWORD_REGEX.test(candidate);
    };

    const pickBestStatus = (candidates) => {
      // keep best bonus per value then score for final pick
      const byValue = new Map();
      for (const candidate of candidates) {
        const rawValue = typeof candidate === 'string' ? candidate : candidate?.value;
        const bonus = typeof candidate === 'string' ? 0 : Number(candidate?.bonus || 0);
        const cleaned = sanitizeStatusValue(rawValue);
        if (!cleaned) continue;
        const previousBonus = byValue.get(cleaned) || 0;
        if (bonus > previousBonus) byValue.set(cleaned, bonus);
        if (!byValue.has(cleaned)) byValue.set(cleaned, 0);
      }

      const cleanedValues = [...byValue.keys()].filter(isLikelyStatusValue);
      if (!cleanedValues.length) return '';

      const score = (value) => {
        const v = lower(value);
        let points = value.length + (byValue.get(value) || 0);
        if (isLikelyStatusValue(value)) points += 70;
        if (v === 'active') points += 10;
        if (v.includes('pending')) points += 80;
        if (v.includes('/')) points += 45;
        if (v.includes('move-out') || v.includes('move out') || v.includes('drop')) points += 35;
        if (v.includes('active')) points += 20;
        if (v.includes('closed') || v.includes('inactive') || v.includes('cancel')) points += 10;
        return points;
      };

      return cleanedValues.sort((first, second) => score(second) - score(first))[0];
    };

    const extractStatusFromStatusLine = (line, nextLine = '') => {
      // supports both "Status: Active" and split line "Status" then next line
      const normalizedLine = normalize(line);
      const inlineMatch = normalizedLine.match(/^status\s*[:：]\s*(.+)$/i);
      if (inlineMatch) return sanitizeStatusValue(inlineMatch[1]);
      if (/^status\s*:?$/i.test(normalizedLine)) return sanitizeStatusValue(nextLine);
      return '';
    };

    const fromLabel = sanitizeStatusValue(findValue('Status', { allowLineFallback: false }));
    const bodyText = String(document.body.innerText || '');
    const lines = bodyText.split(/\r?\n/).map(normalize).filter(Boolean);

    const lineCandidates = [];
    for (let index = 0; index < lines.length; index += 1) {
      // nearby account words boost confidence this status is the right one
      const value = extractStatusFromStatusLine(lines[index], lines[index + 1] || '');
      if (!value) continue;
      const contextWindow = lines.slice(Math.max(0, index - 4), index + 5).join(' ');
      let bonus = 0;
      if (ACCOUNT_CONTEXT_REGEX.test(lower(contextWindow))) bonus += 90;
      if (isLikelyStatusValue(value)) bonus += 45;
      lineCandidates.push({ value, bonus });
    }

    // DOM sibling fallback handles key/value blocks where STATUS is one element and value is another.
    const domCandidates = [];
    const statusLabels = [...document.querySelectorAll('label,span,div,td,strong,b')]
      .filter((element) => visible(element) && /^status\s*:?$/i.test(normalize(text(element))));
    for (const labelElement of statusLabels) {
      const siblingValue = sanitizeStatusValue(text(labelElement.nextElementSibling));
      if (siblingValue) {
        domCandidates.push({ value: siblingValue, bonus: isLikelyStatusValue(siblingValue) ? 55 : 0 });
      }

      const parent = labelElement.parentElement;
      if (!parent) continue;
      const siblingParts = [...parent.children]
        .filter((child) => child !== labelElement)
        .map(text)
        .filter(Boolean);
      if (siblingParts.length) {
        const mergedSiblingValue = sanitizeStatusValue(siblingParts.join(' '));
        if (mergedSiblingValue) {
          const accountBonus = ACCOUNT_CONTEXT_REGEX.test(lower(text(parent))) ? 90 : 0;
          const keywordBonus = isLikelyStatusValue(mergedSiblingValue) ? 45 : 0;
          domCandidates.push({ value: mergedSiblingValue, bonus: accountBonus + keywordBonus });
        }
      }
    }

    const slashLineCandidate = lines
      .find((line) => /active\s*\/\s*pending/i.test(line) || /pending\s*(move-out|move out|drop)/i.test(line)) || '';

    return pickBestStatus([
      ...lineCandidates,
      ...domCandidates,
      { value: fromLabel, bonus: 25 },
      { value: slashLineCandidate, bonus: 20 }
    ]);
  }

  function contractRows() {
    // finds contract table and maps just start/end for popup output
    const hasContractShape = (headers) => {
      const hasDates = headers.includes('start date') && headers.includes('end date');
      const hasContractIdentity = headers.includes('contract id')
        || headers.includes('pricing plan')
        || headers.includes('fixed commodity rate');
      return hasDates && hasContractIdentity;
    };

    for (const table of document.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('th,[role="columnheader"]')].map((header) => lower(text(header)));
      if (!hasContractShape(headers)) continue;
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
    if (!hasContractShape(headers)) return [];
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
        // keep poking till the thing exists or we run outta time
        const value = predicate();
        if (value) return resolve(value);
        if (Date.now() - started >= timeout) return reject(new Error('The portal did not finish loading the expected results.'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function post(action, data = {}) {
    // all progress events pipe back to background/popup flow
    chrome.runtime.sendMessage({ type: 'LOOKUP_STEP', action, data, lookupId: activeLookupId });
  }

  async function ensureOnCustomerSearchPage() {
    // force nav to search page before touching form controls
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
    // step 1: load search, set value, hit search, wait result link
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
      // using native setter so portal reacts like a real typed value
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
    // step 2: open result then gather summary bits + account link
    const resultLink = await waitFor(() => findCustomerLink(customerNumber));
    if (!resultLink) throw new Error('No account was found for that customer number.');
    const row = resultLink.closest('tr');
    const customerNameFromResults = extractCustomerNameFromResultRow(row, customerNumber)
      || text(row?.querySelectorAll('a')[1]);
    const searchUrl = location.href;
    resultLink.click();
    // wait till we leave search view or summary text pops in
    await waitFor(() => location.href !== searchUrl || lower(document.body.innerText).includes('customer summary'));

    let customerSummaryGroups = extractCustomerSummaryGroupCounts();
    if (!hasCompleteSummaryGroupCounts(customerSummaryGroups)) {
      try {
        customerSummaryGroups = await waitFor(() => {
          const value = extractCustomerSummaryGroupCounts();
          return hasCompleteSummaryGroupCounts(value) ? value : null;
        }, 2500);
      } catch {
        customerSummaryGroups = extractCustomerSummaryGroupCounts();
      }
    }

    await waitFor(() => findLink('Account'));
    const accountHref = findLink('Account')?.href;
    if (!accountHref) throw new Error('Could not find the Account link on the customer summary.');

    post('SUMMARY_READY', {
      customerName: customerNameFromResults || '',
      customerNumber,
      customerSummaryGroups,
      phone: findPhoneValue(),
      accountStatus: findAccountStatus(),
      accountHref
    });
  }

  async function runAccount() {
    // step 3: read status, open Service Contracts tab
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
    // hop tabs then let ui breathe a sec before reading rows
    serviceContractsTab.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    post('CONTRACTS_TAB_SELECTED', { accountStatus });
  }

  async function runContracts() {
    // step 4: wait till contracts rows are present then send em out
    let rows;
    const readRows = () => {
      const loadedRows = contractRows();
      // null means keep waiting, array means we got data
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
    // tiny router for background to content step commands
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
