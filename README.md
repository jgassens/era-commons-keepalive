# eRA Commons Keep Alive

This small, unofficial Chrome extension helps keep **your own** NIH eRA Commons session active on **your own computer**. eRA logs you out 45 minutes after your last click, key press, or scroll in an eRA page. Reading and mouse movement do not count. While an eRA tab is open, this extension sends the page a harmless scroll signal every 4 minutes so eRA's own timeout manager renews that timer. At the same time, it calls eRA's own session check-in address so the server session is kept active too. It does not move the viewport or click anything for this keep-alive signal. If eRA shows its session-timeout warning, the extension also tries to press that warning's safe “continue” button.

It never reads, saves, fills, or sends passwords, two-factor codes, or any other credentials. It never attempts to log you in.

## Install it in Chrome

1. Download or open this extension folder on your computer.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked**.
5. Select this folder (the one containing `manifest.json`).
6. Open eRA Commons and sign in normally yourself.

Click the extension's toolbar icon to turn it on or off and see its status. “Enabled — logged in” and a green **ON** badge mean the extension has found a live eRA session timer. The popup records the most recent activity nudge, eRA's current logout time, and automatic warning-button click. A red **!** badge and a Chrome notification mean eRA ended the session; sign in again normally.

The popup's collapsible **Diagnostic log** shows recent page loads, timer nudges, server responses, status changes, and automatic continue-button clicks. It keeps at most 200 entries on your computer, shows about 30 of the newest entries, and can copy the full log as plain text. The log contains only times, page paths without query strings, derived minutes left, HTTP status numbers, and the listed event results. It does not contain cookie values or page content.

## Finding your real timeout

After eRA sends you to a login page, open the extension popup and look at **Recent logouts**. Each entry says when the logout was detected, how long it had been since the extension's last activity nudge, how long it had been since you last loaded an eRA page, how much time remained on eRA's timer at the last nudge, and the last server response status. Compare several entries to find the pattern. If a logout repeatedly follows an activity nudge by fewer than five minutes, the warning below it suggests that eRA may have a hard session limit or may not count the nudge as activity. The list keeps the 10 most recent detected logouts.

## Important limits

This extension cannot log you in, and it cannot defeat any absolute maximum session length that eRA may enforce. Its timeout-warning button detection is deliberately conservative and heuristic; it has not yet been verified against the live eRA dialog. It will never intentionally press buttons labelled log out, sign out, end session, or cancel.

The extension needs only storage, alarms, notifications, and access to `https://*.era.nih.gov/*`. It does **not** request Chrome's broad `tabs` permission: Chrome permits finding tabs matching a host permission with `chrome.tabs.query`, without access to other sites' tabs.

## Optional local check

No packages are needed. With Node installed, run:

```sh
node --test tests/
```

The included icon generator can be run with `node scripts/generate-icons.js`; it uses only Node's standard library.
