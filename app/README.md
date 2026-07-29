# ESG Customer Account Lookup

<!-- by Mo and Avery -->

A local Chrome/Edge Manifest V3 extension for the signed-in ESG Enterprise Portal. Enter a billing number and the extension navigates the active portal tab to collect:

- Customer name and service number
- The entered billing number, preserved in the final results
- Current contract expiration
- Renewal start and expiration, when an additional service-contract row exists
- Renewal status

The extension does not request, store, or transmit portal credentials. It uses the active browser tab's existing authenticated session.

Before searching, the extension takes the digits before the first dash in the entered billing number. It pads that search value with leading zeroes to eight digits when needed. For example, `1903977-45` is displayed as the billing number and searched as `01903977`.

## Excel Copy/Paste workflow

The popup supports an Excel copy/paste workflow without cloud APIs.

1. Copy rows from Excel.
2. Paste them into the popup text area.
3. Optionally set target value(s) from column A (examples: `7` or `7,8`). Leave blank for top-to-bottom mode.
4. Use **Previous billing number** to load the preceding match. **Next billing number** loads the next match, waits 200 ms, and then automatically starts its account search. Dial remains unavailable until that search has displayed its results.

## Renewal Radar

Renewal Radar runs in the extension background worker, so it continues when the popup is closed or unfocused. It opens a separate inactive portal tab for its automated searches, leaving the tab you are using untouched. Use **Stop** to finish the account currently being checked and stop before the next one; all checked results remain available when the popup is reopened.

## Disposition logging

After a lookup and dial, pick a disposition in the popup and click **Save disposition**. The extension stores the latest billing number, customer name, contract expiration date, and dialed number locally, then updates a CSV file for that disposition in your downloads folder.

The available dispositions are:

- Voicemail
- No voicemail
- Requested call back
- Renewed contract
- Do not call

This uses browser downloads to keep the disposition buckets in separate files.

## Install locally

1. Open Chrome or Edge and navigate to the ESG customer search page.
2. Sign in normally in that browser tab.
3. Open the browser's extensions page (`chrome://extensions` or `edge://extensions`).
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select this project folder.
6. Return to the signed-in portal tab, click the extension icon, enter a customer number, and choose **Find account**.

## Notes

The page markup was inferred from the supplied screenshots. If the portal changes its labels, routing, or table markup, the selectors in `content.js` may need adjustment. Use only with authorization to access and automate the portal's customer data.
