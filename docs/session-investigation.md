# Session logout investigation, October 14, 2026

The installed unpacked extension's existing Chrome local storage was read
without changing it. It contained 200 recent diagnostic entries, 10 logout
records, and 19,623 retained diagnostic recording events. The latest saved
event was October 10; these are historical observations, not a fresh live test.
Times below use America/Chicago (CDT).

## What the logs establish

Background renewal was already enabled (`pingServer: true`). It dispatched
synthetic scroll events to renew the browser's 45-minute timeout cookie and
requested each open eRA application's `jsp/keepSessionAlive.jsp` address.
Requests typically ran about four minutes apart in these recordings.

On October 1:

| Time | Observation |
| --- | --- |
| 12:20:35 PM | `/commonsplus/jsp/keepSessionAlive.jsp` returned HTTP 204. The page timer was renewed to 45 minutes. |
| 12:23:23 PM | Normal navigation through `/commonsplus/status/landing.era` reached `/commonsstatus/pi/menu.era`, which redirected to `/commonsplus/public/login.era`. |
| 12:23:23 PM | The recorded `.nih.gov` `NIHSMSESSION` cookie was removed with cause `expired_overwrite`. |
| 12:23:24 PM | The extension noticed the login page while the page timer still showed 45 minutes. |
| 4:29:51 PM | `/assist/jsp/keepSessionAlive.jsp` returned HTTP 204. |
| 4:33:50 PM | The same address returned HTTP 302 to `/assist/public/login.era`. |
| 4:34:20 PM | The 30-second recheck also redirected to login. The extension marked the session logged out and stopped its regular timer. |

September 29 showed the same ASSIST sequence: HTTP 204 at 3:09:30 PM,
redirects at 3:13:30 and 3:14:00 PM, and a browser timer still showing
45 minutes after each simulated activity signal.

Seven saved logout records involved a server refusal or navigation to login.
They occurred approximately 32.5–96.5 minutes after the extension noticed
sign-in. The other three records described cookie deletion or a session
ending while no eRA tab was open. These records do not establish one fixed
maximum session duration. In two failures, actual pages had loaded less than
eight minutes before the first refusal, so a 13-minute refresh cannot be
claimed to solve every observed logout.

## Interpretation and experiment

The page timer is not a reliable indication of server authentication. A
successful HTTP 204 check-in also does not guarantee that another eRA
application will accept the session minutes later. The recording directly
shows a sign-in cookie being removed in one failure, but does not reveal the
server's internal expiration rules or prove which session layer caused all
failures. Cookie values and credentials were not needed for this assessment.

Version 1.7.0 therefore adds an actual page refresh after 13 minutes of eRA
inactivity, with uniform random variation of up to one minute. Activity in
any eRA tab resets the shared deadline. Background renewal remains enabled.
Pages with unsaved edits or form-action URLs are skipped; their background
renewal continues. The log records completed and skipped refreshes.

This is an experiment, not a verified remedy. To assess it, sign in normally
with the updated extension, enable its diagnostic recorder if detailed
evidence is desired, and leave an unedited eRA page idle. Confirm that
`refreshed page` entries appear after 12–14 minutes, that activity postpones
them, and that an ordinary eRA page remains usable afterward. If eRA ends
the session, compare its redirects and cookie events with those recorded
before the change. No fresh signed-in session was tested during this change.
