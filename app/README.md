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

## Shared Excel (experimental)

The popup includes an experimental Microsoft Graph connector for shared OneDrive/SharePoint workbooks.

1. Create an Azure app registration and configure a redirect URI using your extension ID:
	- `https://<extension-id>.chromiumapp.org/microsoft-callback`
2. Grant delegated permissions that include `Files.ReadWrite`.
3. In the popup, enter:
	- Tenant ID (`common` works for many org setups)
	- Azure Client ID
	- Drive ID
	- Workbook Item ID
	- Worksheet name
	- Assignment value (the first-column value, e.g. `1` to `10`)
4. Click **Connect Microsoft**, then **Pull billing number from sheet**.
5. The extension scans column A for the assignment value and reads the billing number from the configured billing column (default column 2), then autofills the billing number input.

This feature is a draft for experimentation and does not yet include advanced conflict-safe writeback logic.

## Install locally

1. Open Chrome or Edge and navigate to the ESG customer search page.
2. Sign in normally in that browser tab.
3. Open the browser's extensions page (`chrome://extensions` or `edge://extensions`).
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select this project folder.
6. Return to the signed-in portal tab, click the extension icon, enter a customer number, and choose **Find account**.

## Notes

The page markup was inferred from the supplied screenshots. If the portal changes its labels, routing, or table markup, the selectors in `content.js` may need adjustment. Use only with authorization to access and automate the portal's customer data.
