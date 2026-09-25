# eRA Commons Keep Alive

This small, unofficial Chrome extension helps keep **your own** NIH eRA Commons session active on **your own computer**.

eRA logs you out 45 minutes after your last click, key press, or scroll in an eRA page. Reading and moving the mouse do not count. eRA keeps that deadline in a cookie called `ERA_SESSION_TIMEOUT_COOKIE`, and eRA's own page script pushes it 45 minutes ahead each time it sees activity.

While an eRA tab is open, this extension sends the page a harmless scroll signal every 4 minutes, so eRA's own script pushes the deadline ahead. The signal does not move the page or click anything. If eRA shows its session-timeout warning anyway, the extension presses that warning's **Continue** button.

When eRA logs you out — its own timer ran out, or you pressed **Logout** — eRA's page deletes that cookie first. The extension watches for exactly that deletion, so it notices the logout the moment it happens, not at the next 4-minute check.

It never reads, saves, fills, or sends passwords, two-factor codes, or any other credentials. It never tries to log you in.

## Install it in Chrome

1. Download or open this extension folder on your computer.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked**.
5. Select this folder (the one containing `manifest.json`).
6. Open eRA Commons and sign in normally yourself.

When the extension is installed, updated, or Chrome starts, it adds itself to eRA tabs that are already open. You do not need to reload them. If a tab still cannot be reached, the log says **could not reach tab (reload it)**; reloading that tab fixes it.

**Updating from a version before 1.3.0:** reload each open eRA tab once after the update. Older versions left a leftover copy of themselves running inside eRA tabs, and a reload is the only thing that clears it.

## The popup

Click the extension's toolbar icon to see its status.

- **Keep session active** turns the whole extension on or off. While it is off, nothing is scrolled, clicked, or pinged, and nothing is logged.
- **Also ping eRA's server** is **off by default**. See below.
- A green **ON** badge means the extension found a live eRA timer. An orange **ON!** badge means eRA's server turned down the last check-in even though eRA's timer is still running (see below). A red **!** badge and a Chrome notification mean a session the extension had seen as signed in has ended; sign in again normally. The red badge clears as soon as you load an eRA page after signing back in.

### "Also ping eRA's server"

eRA's own page already calls a check-in address (`keepSessionAlive.jsp`) on eRA's server every 40 minutes while its timer is live. So the extension does **not** call it unless you turn this switch on.

The switch exists to answer one question: when a session ends, was it eRA's **page timer** or eRA's **server** that ended it? With the switch on, every 4 minutes the extension calls that check-in address once per eRA application (not once per tab) and records the answer. It gives up on a call after 15 seconds and logs **server timeout**.

If the server answers with a redirect, the extension does not follow it to the login page. It logs **server rejected keep-alive (redirect)**, turns the badge orange, shows a warning line in the popup, and keeps nudging. A redirect by itself does **not** count as a logout while eRA's timer cookie is still live; the session counts as ended only when the cookie is gone too.

## Recent logouts

Each entry shows when the logout was noticed and why, how long you had been signed in, how long since the last activity nudge, how long since you last loaded an eRA page, how many minutes eRA's own timer had left at the last nudge, and the last server answer (or that the server was not called).

Under some entries the popup adds one line saying what ended the session:

- *"eRA deleted its own timeout cookie — eRA's page timer or the Logout button ended the session."* eRA's page deletes the cookie only when its own timer runs out or you press **Logout**.
- *"eRA's own timer ran out before the next activity nudge."* The cookie's deadline had passed.
- *"eRA's own timer still had time left — something else ended the session (server or a hard limit)."* The cookie was still live when the logout was noticed (less time had passed since the last nudge than the timer had left then). That points away from the page timer and toward the server or a fixed maximum session length.

The list keeps the 10 most recent logouts.

## Reading the diagnostic log

The collapsible **Diagnostic log** keeps up to 200 entries on your computer, shows the newest 30, and **Copy log** copies them all as plain text. It stores only times, page paths (with `?query`, `#hash`, and `;jsessionid=` parts removed), minutes, HTTP status numbers, and the events below. It never stores cookie values or page content.

| Line | Meaning |
|---|---|
| `nudge /path: cookie 41.2 -> 45.0 min, …` | eRA's timer had 41.2 minutes left; after the scroll signal it had 45.0. |
| `cookie deleted` | The timeout cookie is gone. eRA deletes it when it logs you out. |
| `cookie -1.0 min (expired)` | The deadline has passed. |
| `no timeout manager, …` | This page has no eRA session timer, so it was not nudged. |
| `could not reach tab (reload it)` | The extension could not talk to this tab. Reload it. |
| `server not called (ping off)` | The server switch is off. |
| `server not called` | The switch is on, but another tab already pinged that application this round, or this tab had no live timer. |
| `server 200` | eRA's server answered normally. |
| `server rejected (redirect)` | eRA's server sent a redirect instead of a normal answer. |
| `server rejected keep-alive (redirect) …; eRA timer still live, still nudging` | The server turned the check-in down, but eRA's timer cookie is live, so the session is still counted as signed in. |
| `server timeout` | The server did not answer within 15 seconds. |
| `server error` | The call failed to get any answer (for example, no network). |
| `page load /path: …` | You opened an eRA page; shows its timer. |
| `status logged-in -> logged-out: reason` | The extension's view of your session changed, and why. `eRA timer cookie deleted` means eRA's page deleted its cookie (its timer ran out, or you pressed Logout). |
| `no eRA tabs open, cookie 30.0 min; still logged in, …` | All eRA tabs are closed, but eRA's timer cookie is still live. The 4-minute timer stops because there is no tab to nudge; it starts again when you open an eRA page. |
| `no eRA tabs open, cookie deleted` | All eRA tabs are closed and the cookie is gone. A session that was signed in is recorded as a logout; otherwise status goes back to unknown. |
| `alarm late by N min (computer asleep?)` | Chrome's 4-minute timer fired late, usually because the computer slept. |
| `continued timeout warning /path` | The extension pressed eRA's warning **Continue** button. |

## Important limits

This extension cannot log you in, and it cannot beat any maximum session length that eRA's server enforces. Its warning-button detection is deliberately cautious; it has not yet been checked against the live eRA dialog. It will never knowingly press buttons labelled log out, sign out, end session, or cancel.

The extension asks only for storage, alarms, notifications, scripting (to add itself to eRA tabs that were open before it was installed or updated), cookies, and access to `https://*.era.nih.gov/*`. It does **not** ask for Chrome's broad `tabs` permission.

The **cookies** permission is how the extension notices the moment eRA logs you out: it lets the extension see eRA's `ERA_SESSION_TIMEOUT_COOKIE` being deleted, and read that cookie's deadline when no eRA tab is open. The site access above already limits it to `era.nih.gov` cookies. The extension looks only at that one cookie, and keeps nothing from it except the logout time it holds (shown in the popup as **eRA will log you out at**).

## Optional local check

No packages are needed. With Node installed, run:

```sh
node --test tests/
```

The included icon generator can be run with `node scripts/generate-icons.js`; it uses only Node's standard library.
