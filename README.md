# eRA Commons Keep Alive

This small, unofficial Chrome extension helps keep **your own** NIH eRA Commons session active on **your own computer**.

eRA logs you out 45 minutes after your last click, key press, or scroll in an eRA page. Reading and moving the mouse do not count. eRA keeps that deadline in a cookie called `ERA_SESSION_TIMEOUT_COOKIE`, and eRA's own page script pushes it 45 minutes ahead each time it sees activity.

While an eRA tab is open, this extension sends the page a harmless scroll signal every 4 minutes, so eRA's own script pushes the deadline ahead. The signal does not move the page or click anything. If eRA shows its session-timeout warning anyway, the extension presses that warning's **Continue** button.

It never reads, saves, fills, or sends passwords, two-factor codes, or any other credentials. It never tries to log you in.

## Install it in Chrome

1. Download or open this extension folder on your computer.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked**.
5. Select this folder (the one containing `manifest.json`).
6. Open eRA Commons and sign in normally yourself.

When the extension is installed, updated, or Chrome starts, it adds itself to eRA tabs that are already open. You do not need to reload them. If a tab still cannot be reached, the log says **could not reach tab (reload it)**; reloading that tab fixes it.

## The popup

Click the extension's toolbar icon to see its status.

- **Keep session active** turns the whole extension on or off. While it is off, nothing is scrolled, clicked, or pinged, and nothing is logged.
- **Also ping eRA's server** is **off by default**. See below.
- A green **ON** badge means the extension found a live eRA timer. A red **!** badge and a Chrome notification mean a session the extension had seen as signed in has ended; sign in again normally. The red badge clears as soon as you load an eRA page after signing back in.

### "Also ping eRA's server"

eRA's own page already calls a check-in address (`keepSessionAlive.jsp`) on eRA's server every 40 minutes while its timer is live. So the extension does **not** call it unless you turn this switch on.

The switch exists to answer one question: when a session ends, was it eRA's **page timer** or eRA's **server** that ended it? With the switch on, every 4 minutes the extension calls that check-in address once per eRA application (not once per tab) and records the answer. If the server answers with a redirect, the extension treats that as the server saying your session is over. It does not follow the redirect to the login page.

## Recent logouts

Each entry shows when the logout was noticed and why, how long you had been signed in, how long since the last activity nudge, how long since you last loaded an eRA page, how many minutes eRA's own timer had left at the last nudge, and the last server answer (or that the server was not called).

If eRA's timer still had 10 or more minutes left, the popup adds: *"eRA's own timer still had N min left — the session was ended by something else (server or a hard limit)."* That points away from the page timer and toward the server or a fixed maximum session length. The list keeps the 10 most recent logouts.

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
| `server rejected (redirect)` | eRA's server sent a redirect: it no longer accepts the session. |
| `server error` | The call failed to get any answer (for example, no network). |
| `page load /path: …` | You opened an eRA page; shows its timer. |
| `status logged-in -> logged-out: reason` | The extension's view of your session changed, and why. |
| `no eRA tabs open` | All eRA tabs are closed; status goes back to unknown and the 4-minute timer stops. |
| `alarm late by N min (computer asleep?)` | Chrome's 4-minute timer fired late, usually because the computer slept. |
| `continued timeout warning /path` | The extension pressed eRA's warning **Continue** button. |

## Important limits

This extension cannot log you in, and it cannot beat any maximum session length that eRA's server enforces. Its warning-button detection is deliberately cautious; it has not yet been checked against the live eRA dialog. It will never knowingly press buttons labelled log out, sign out, end session, or cancel.

The extension asks only for storage, alarms, notifications, scripting (to add itself to eRA tabs that were open before it was installed or updated), and access to `https://*.era.nih.gov/*`. It does **not** ask for Chrome's broad `tabs` permission.

## Optional local check

No packages are needed. With Node installed, run:

```sh
node --test tests/
```

The included icon generator can be run with `node scripts/generate-icons.js`; it uses only Node's standard library.
