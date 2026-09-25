# Chrome Web Store listing — copy/paste sheet

Everything below is written to be pasted directly into the fields of the
Chrome Web Store developer dashboard (chrome.google.com/webstore/devconsole).

## Item name

```
Session Keeper for eRA Commons (unofficial)
```

## Summary (132 characters max)

```
Unofficial helper that keeps your own NIH eRA Commons session from timing out while an eRA tab is open.
```

(103 characters — matches the extension's manifest description, so the
store listing and the extension's own about text always say the same thing.)

## Detailed description

```
Session Keeper for eRA Commons is a small, unofficial helper for your own
NIH eRA Commons account. It is not made by, run by, or affiliated with NIH
or eRA in any way — it is a browser add-on that watches eRA's own page and
gives it a nudge so you are not logged out just for reading instead of
clicking.

What it does, while enabled and an eRA Commons tab is open:

- Every 4 minutes, it sends eRA's own page a harmless scroll signal — the
  same kind of "you're still here" signal a real scroll or click would send.
  This does not move your page, change anything on screen, or click
  anything you didn't ask it to.
- If eRA's own timeout warning pops up anyway, it presses that warning's
  own "Continue" button for you.
- Optionally (off by default — you turn it on yourself in the popup), it
  also calls eRA's own keep-alive web address directly, the same address
  eRA's page already calls on its own every 40 minutes. This only tells you
  whether eRA's server or eRA's page timer ended a session; you can leave
  it off and the extension still works.
- It keeps a small log on your own computer — times, page names, and
  whether eRA's timer was extended — so you can see what it has been
  doing. That log never leaves your computer unless you press "Copy log"
  yourself.

What it never does:

- It never logs you in, and it cannot log you in.
- It never reads, stores, fills in, or sends your username, password, two-
  factor code, or any other credential.
- It sends nothing to anyone, anywhere, except eRA's own keep-alive web
  address on eRA's own site — and only when you have switched that optional
  setting on yourself. There is no server run by the developer, and no
  analytics of any kind.

This extension is meant for your own eRA Commons account, on your own
computer, and does nothing while it is turned off in the popup.
```

## Category

```
Productivity
```

(Closest fit to the current/nearest Chrome Web Store category list; pick
"Productivity" if the dashboard offers it, otherwise the nearest equivalent
such as "Tools" or "Workflow & Planning.")

## Language

```
English (United States)
```

## Visibility

```
Unlisted
```

Set this under the listing's **Distribution** tab, not on the main listing
tab — Unlisted means the item only opens for people who have the exact
store link, and it will not appear in search or browse results.

## Single purpose statement

```
This extension's single purpose is to keep the user's own, already-signed-
in NIH eRA Commons session from timing out due to inactivity, by sending
eRA's own page an activity signal on a timer while an eRA Commons tab is
open, and by pressing eRA's own on-screen "Continue" button if a timeout
warning appears.
```

## Permission justifications

Each permission below is tied to the exact code that uses it, so the
reasoning can be checked against the source at any time.

**storage** — Used to remember whether the extension is turned on, whether
the optional server ping is turned on, the current sign-in/sign-out status,
the times of the last nudge and last warning click, the list of recent
logouts, and the local diagnostic log — all read and written with
`chrome.storage.local` in `background.js` and read back by the popup
(`popup.js`) to show status. Nothing here is synced to a Google account or
sent anywhere; it is `local`, not `sync`, storage.

**alarms** — Used to run the every-4-minute activity nudge on a schedule
that keeps working even when the popup is closed. `background.js` creates
one alarm (`chrome.alarms.create` with a 4-minute period) and reacts to it
with `chrome.alarms.onAlarm`.

**notifications** — Used for exactly one thing: telling you, with a native
Chrome notification, that a session the extension had seen as signed in has
just ended, so you know to sign in again. `background.js` calls
`chrome.notifications.create` only at that moment.

**scripting** — Used to add the extension's content script to eRA Commons
tabs that were already open before the extension was installed or updated
(a tab that was open beforehand does not get a fresh content script
automatically). `background.js` calls `chrome.scripting.executeScript`,
scoped to tabs already matching the `https://*.era.nih.gov/*` host
permission below.

**cookies** — Used to notice the instant eRA logs you out and to read the
logout deadline eRA itself has already set. `background.js` reads eRA's own
`ERA_SESSION_TIMEOUT_COOKIE` with `chrome.cookies.getAll` and watches it
with `chrome.cookies.onChanged`. It looks at that one cookie's name and
expiry only — never its value's meaning beyond the timestamp eRA already
put there, and never any other site's cookies.

**Host permission `https://*.era.nih.gov/*`** — This is the one site the
extension is allowed to act on at all: it scopes the content script
(`manifest.json` `content_scripts`), which tab this extension will inject
into or send an activity signal to (`chrome.tabs.query`, `content.js`), the
cookie reads above, and the optional keep-alive web address the extension
may call, which `src/matcher.js` builds and refuses to use unless the
result is still an `https://*.era.nih.gov` address. The extension cannot
act on any other website.

## Remote code

```
No, I am not using remote code.
```

Why: every script the extension runs ships inside the package itself
(`background.js`, `content.js`, `src/matcher.js`, `popup.js`). Nothing is
fetched and executed from a remote URL, there is no `eval` of downloaded
code, and there are no `<script src="https://...">` references anywhere —
`scripts/package.sh` builds the store package from exactly these local
files, so what you upload is what is reviewed.

## Data usage

**What the disclosure form is really asking:** Chrome Web Store's Data
Usage disclosure covers data the extension *handles* — including data it
only stores on the device and never transmits — not just data sent to a
server. The categories exist so a user can see what the extension touches,
even locally.

**The diagnostic log:** it is stored only in `chrome.storage.local` (never
leaves the device unless you personally press "Copy log" and paste it
somewhere), and it holds page **paths** on `era.nih.gov` (with any
`?query`, `#hash`, or session-id portion stripped) plus timestamps and
minute counts — never page content, never form data, never credentials.

**Recommended, conservative answer:** because a URL path is technically
"web history" / "site content" even when it is local-only and stripped of
identifiers, tick the box for **Website content** (or your dashboard's
closest equivalent, sometimes labeled "Web history" or "User activity")
rather than claiming "No data collected." Add a note in that field's free-
text box: *"Page paths and timing only, stored locally on the user's
device, stripped of query strings and session IDs, never transmitted."*
Leave every other data category (personal info, financial info, health,
location, authentication info, etc.) as **not collected** — none of that
data is read, stored, or handled anywhere in the extension.

**Certifications — check all three:**
- ☑ I do not sell or transfer user data to third parties outside of the
  approved use cases. *(True — nothing is sold or transferred; the only
  outbound call is the optional, user-controlled ping to eRA's own site.)*
- ☑ I do not use or transfer user data for purposes unrelated to the item's
  single purpose. *(True — the local log exists only to show the extension
  is working; it is not used for anything else.)*
- ☑ I do not use or transfer user data to determine creditworthiness or for
  lending purposes. *(True — not applicable to anything this extension
  does.)*

## Privacy policy URL

```
https://jgassens.github.io/era-commons-keepalive/privacy-policy.html
```

This is the GitHub Pages URL for `docs/privacy-policy.html`, hosted from
this repository's `main` branch `/docs` folder. Paste this URL into the
dashboard's **Privacy policy** field.
