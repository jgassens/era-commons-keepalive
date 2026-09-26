# Session Keeper for eRA Commons (unofficial)

This small, unofficial Chrome extension helps keep **your own** NIH eRA Commons session active on **your own computer**. It is not made by, or affiliated with, NIH or eRA Commons.

eRA logs you out 45 minutes after your last click, key press, or scroll in an eRA page. Reading and moving the mouse do not count. eRA keeps that deadline in a cookie called `ERA_SESSION_TIMEOUT_COOKIE`, and eRA's own page script pushes it 45 minutes ahead each time it sees activity.

While an eRA tab is open, this extension sends the page a harmless scroll signal every 4 minutes, so eRA's own script pushes the deadline ahead. The signal does not move the page or click anything. If eRA shows its session-timeout warning anyway, the extension presses that warning's **Continue** button.

When eRA logs you out — its own timer ran out, or you pressed **Logout** — eRA's page deletes that cookie first. The extension watches for exactly that deletion, so it notices the logout the moment it happens, not at the next 4-minute check.

It never reads, saves, fills, or sends passwords, two-factor codes, or any other credentials. It never tries to log you in.

Privacy policy: https://jgassens.github.io/era-commons-keepalive/privacy-policy.html

Download: [latest release](https://github.com/jgassens/era-commons-keepalive/releases/latest)

## Install it in Chrome

1. Download the [latest release](https://github.com/jgassens/era-commons-keepalive/releases/latest) zip and unzip it. Or clone this repository and choose its folder.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked**.
5. Select the unzipped folder (the one containing `manifest.json`).
6. Open eRA Commons and sign in normally yourself.

When the extension is installed, updated, or Chrome starts, it adds itself to eRA tabs that are already open. You do not need to reload them. If a tab still cannot be reached, the log says **could not reach tab (reload it)**; reloading that tab fixes it.

**Updating from a version before 1.3.0:** reload each open eRA tab once after the update. Older versions left a leftover copy of themselves running inside eRA tabs, and a reload is the only thing that clears it.

## The popup

Click the extension's toolbar icon to see its status. If the popup feels cramped, the **Open in a tab** link at the top opens the same page as a full tab; clicking the "session ended" notification does the same.

- **Keep session active** turns the whole extension on or off. While it is off, nothing is scrolled, clicked, or pinged, and nothing is logged.
- **Also ping eRA's server** is **on by default** and can be switched off. See below.
- A green **ON** badge means the extension found a live eRA timer. An orange **ON!** badge means eRA's server turned down the last check-in once; the extension asks again 30 seconds later (see below). A red **!** badge and a Chrome notification mean a session the extension had seen as signed in has ended; sign in again normally. The red badge clears as soon as you load an eRA page after signing back in.
- A grey **…** badge (status *No eRA tab open — not keeping the session alive*) means you closed every eRA tab while eRA's timer was still running. With no tab there is nothing to nudge, so the session is left to eRA's own timer. When you next open an eRA page (or Chrome restarts), the extension checks the cookie: if it is still live, you are simply logged in again with the same sign-in time; if it has run out or is gone, the logout is recorded quietly — no notification, since it happened while you were away — with the time it **probably ended** (eRA's last known logout time).

### "Also ping eRA's server"

eRA's own page calls a check-in address (`keepSessionAlive.jsp`) on eRA's server every 40 minutes while its timer is live. Keeping eRA's **page timer** alive turned out not to be enough: logs showed eRA's **server** ending sessions it had not heard from in about 60–77 minutes, even while the page timer still had 45 minutes left. With this switch on, a 58-minute stretch without clicking survived.

So since version 1.4.3 the switch is **on by default**. Updating from an older version turns it on once; if you then switch it off, it stays off. With the switch on, every 4 minutes the extension calls that check-in address once per eRA application (not once per tab) and records the answer. The call goes only to eRA's own keep-alive address on eRA's own site. It gives up on a call after 15 seconds and logs **server timeout**. With the switch off, the extension still nudges eRA's page but does not call the server.

If the server answers with a redirect instead, the extension does not follow it to the login page. A redirect means the server refused the check-in. One refusal could be a blip, so the extension logs **server refused keep-alive — rechecking in 30 s**, turns the badge orange, shows *Refused at …* in the popup's **Last server check-in** line, and asks the server once more 30 seconds later. If the server accepts, everything goes back to normal. If it refuses a second time in a row, or an eRA tab lands on eRA's login page while the recheck is pending, the session has ended — see the next section. If no eRA tab can be pinged when the recheck is due, it tries again every 30 seconds, up to three times, and then leaves the question to the next 4-minute check.

### "eRA ended your session — log in again"

This Chrome notification means eRA's **server** has ended your session, even though eRA's page in your tab may still look alive. (It looks alive because the extension kept pushing the page's own timer; that timer lives in your browser and does not know the server has given up.) Anything you click in that tab will land on the login page, so save nothing more there: log in again.

The notification says roughly when the server stopped accepting the session and how long after you signed in that was. Clicking it opens the extension's log in a tab. From that moment the extension stops nudging, stops pressing eRA's **Continue** button (so eRA's own logout can show), and ignores activity on the old tab. Switching the extension off and on again does not change that. It counts you as signed in again only once eRA serves a new page after you log back in.

In one real log, eRA accepted every check-in for about two hours and then refused every one from about **2 hours 10 minutes after sign-in**. That suggests eRA has a **fixed maximum session length** that no amount of activity can extend. This is **not confirmed** — it is one observation. The extension cannot get past such a limit. To help pin it down, the popup lists how long each session lasted, and once two server-ended sessions lasted within 15 minutes of each other it shows a line such as *eRA seems to end sessions about 2 h 10 min after sign-in*.

## Recent logouts

Each entry shows when the logout was noticed and why (for a session that ended while no eRA tab was open, or that eRA's server ended, also when it probably ended), the **session length** (sign-in to the end), how long since the last activity nudge, how long since you last loaded an eRA page, how many minutes eRA's own timer had left at the last nudge, and the last server answer (or that the server was not called). Logouts recorded by older versions show only the facts those versions kept. If one stored entry cannot be read, only that line says so; the rest of the popup still shows.

When the most recent logout was eRA's server ending the session, the status line says so, for example *Signed out — log in to eRA again. eRA's server ended your session at 3:01 PM, 2 h 10 min after sign-in.*

Under some entries the popup adds one line saying what ended the session:

- *"eRA's server stopped accepting the session even though the extension kept checking in. eRA appears to have a fixed session limit that the extension cannot get past."* The server refused two check-ins in a row (the reason reads *eRA's server ended the session (keep-alive refused)*).
- *"eRA's server ended this session even though its page timer was still running. Keep "Also ping eRA's server" on."* eRA sent the tab to its login page while the page's own timer still had time left (the reason reads *eRA sent you to its login page while its page timer still had N min left — eRA's server ended the session*).
- *"eRA deleted its own timeout cookie — eRA's page timer or the Logout button ended the session."* eRA's page deletes the cookie only when its own timer runs out or you press **Logout**.
- *"eRA's own timer ran out before the next activity nudge."* The cookie's deadline had passed.
- *"No eRA tab was open, so nothing kept the session alive; …"* The session ended while you had no eRA tab open (or Chrome was closed, which drops eRA's cookie).
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
| `server refused keep-alive — rechecking in 30 s (/path)` | The server turned the check-in down once. The extension asks again in 30 seconds; a second refusal in a row ends the session. |
| `server recheck: no eRA tab to ping — trying again in 30 s (1 of 3)` | The recheck was due but no eRA tab had a live timer to ping from. It tries again, up to three times. |
| `server recheck: still no eRA tab to ping — the next regular check will ask eRA's server` | Three retries found no tab to ping; the refusal stays pending for the next 4-minute check. |
| `server rejected keep-alive (redirect) …; eRA timer still live, still nudging` | Written by versions before 1.5.0, which kept nudging after a refusal. |
| `server timeout` | The server did not answer within 15 seconds. |
| `server error` | The call failed to get any answer (for example, no network). |
| `page load /path: …` | You opened an eRA page; shows its timer. For a login page it shows the timer that page still saw, if any. |
| `status logged-in -> logged-out: reason` | The extension's view of your session changed, and why. `eRA's server ended the session (keep-alive refused)` means the server refused two check-ins in a row. `eRA timer cookie deleted` means eRA's page deleted its cookie (its timer ran out, or you pressed Logout). A login or logout page counts only when eRA's cookie is gone too; while the cookie is live, the session is still counted as signed in. If the login page itself still saw eRA's timer running, the reason is `eRA sent you to its login page while its page timer still had N min left — eRA's server ended the session`. |
| `no eRA tabs open, cookie 30.0 min; not keeping the session alive …` | All eRA tabs are closed, but eRA's timer cookie is still live. Status goes to idle and the 4-minute timer stops because there is no tab to nudge; it starts again when you open an eRA page. |
| `no eRA tabs open, cookie deleted` | All eRA tabs are closed and the cookie is gone. A session that was signed in is recorded as a logout; otherwise status goes back to unknown. |
| `alarm late by N min (computer asleep?)` | Chrome's 4-minute timer fired late, usually because the computer slept. |
| `continued timeout warning /path` | The extension pressed eRA's warning **Continue** button. |

## Important limits

This extension cannot log you in, and it cannot beat any maximum session length that eRA's server enforces (there appears to be one; see above). What it can do is tell you the moment the server ends the session. Its warning-button detection is deliberately cautious; it has not yet been checked against the live eRA dialog. It will never knowingly press buttons labelled log out, sign out, end session, or cancel.

The extension asks only for storage, alarms, notifications, scripting (to add itself to eRA tabs that were open before it was installed or updated), cookies, and access to `https://*.era.nih.gov/*`. It does **not** ask for Chrome's broad `tabs` permission.

The **cookies** permission is how the extension notices the moment eRA logs you out: it lets the extension see eRA's `ERA_SESSION_TIMEOUT_COOKIE` being deleted, and read that cookie's deadline when no eRA tab is open. The site access above already limits it to `era.nih.gov` cookies. The extension looks only at that one cookie, and keeps nothing from it except the logout time it holds (shown in the popup as **eRA will log you out at**).

## Optional local check

No packages are needed. With Node installed, run:

```sh
node --test tests/
```

The included icon generator can be run with `node scripts/generate-icons.js`; it uses only Node's standard library.
