# eRA Commons Keep Alive

This small Chrome extension helps keep **your own** NIH eRA Commons session active on **your own computer**. When it is on and an eRA Commons tab is open, it sends a harmless background request from that tab every 10 minutes. If eRA shows its session-timeout warning, the extension also tries to press that warning's safe “continue” button.

It never reads, saves, fills, or sends passwords, two-factor codes, or any other credentials. It never attempts to log you in.

## Install it in Chrome

1. Download or open this extension folder on your computer.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked**.
5. Select this folder (the one containing `manifest.json`).
6. Open eRA Commons and sign in normally yourself.

Click the extension's toolbar icon to turn it on or off and see its status. “Enabled — logged in” and a green **ON** badge mean the extension has seen an eRA page and is active. The popup records the most recent successful background request and automatic warning-button click. A red **!** badge and a Chrome notification mean eRA ended the session; sign in again normally.

## Important limits

This extension cannot log you in, and it cannot defeat any absolute maximum session length that eRA may enforce. Its timeout-warning button detection is deliberately conservative and heuristic; it has not yet been verified against the live eRA dialog. It will never intentionally press buttons labelled log out, sign out, end session, or cancel.

The extension needs only storage, alarms, notifications, and access to `https://*.era.nih.gov/*`. It does **not** request Chrome's broad `tabs` permission: Chrome permits finding tabs matching a host permission with `chrome.tabs.query`, without access to other sites' tabs.

## Optional local check

No packages are needed. With Node installed, run:

```sh
node --test tests/
```

The included icon generator can be run with `node scripts/generate-icons.js`; it uses only Node's standard library.
