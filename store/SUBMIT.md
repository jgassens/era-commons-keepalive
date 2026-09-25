# How to publish this as an Unlisted Chrome Web Store item

Plain steps, in order. Everything you paste in step 5 is already written out
for you in `store/listing.md`.

1. **Register as a Chrome Web Store developer**, if you have not already.
   Go to https://chrome.google.com/webstore/devconsole, sign in with the
   Google account you want to own this listing, and pay the one-time
   developer registration fee (currently a small one-time charge, paid by
   you — this is Google's fee, not something this project collects).

2. **Build the package.** From this repository, run:
   ```sh
   bash scripts/package.sh
   ```
   This creates `dist/session-keeper-era-<version>.zip`, where `<version>`
   is the version in `manifest.json`; the script prints the exact path on
   its "Built" line. That zip is what you upload — nothing else.

3. **Start a new item.** In the developer dashboard, click **New item**,
   then upload the zip that `scripts/package.sh` printed when prompted.

4. **Take the screenshots and promo tile** if you have not already (see
   `store/screenshots/` and `store/promo-small-440x280.png` — they are
   already built if you followed the steps in this repo). Upload the two
   screenshots and the promo tile in the **Store listing** tab's image
   section.

5. **Fill in the listing fields**, copying each one straight from
   `store/listing.md`:
   - Item name
   - Summary
   - Detailed description
   - Category
   - Language

6. **Set up the Privacy tab:**
   - Paste `https://jgassens.github.io/era-commons-keepalive/privacy-policy.html`
     (the GitHub Pages URL for `docs/privacy-policy.html`) into the
     **Privacy policy URL** field.
   - Under **Permission justifications**, paste in the paragraph for each
     permission from `store/listing.md` (storage, alarms, notifications,
     scripting, cookies, and the `https://*.era.nih.gov/*` host permission).
   - Under **Remote code**, choose "No, I am not using remote code" and
     paste in the one-line reason from `store/listing.md`.
   - Under **Data usage**, tick the boxes and the three certifications
     exactly as `store/listing.md` recommends, and paste in the note about
     what the local diagnostic log is and is not.
   - Since 1.4.3 the "Also ping eRA's server" switch is **on by default**
     (it can be switched off in the popup). Its only network call goes to
     eRA's own keep-alive address on eRA's own site. The listing text and
     the privacy policy already say so; make sure any wording you type in
     the dashboard yourself says the same.

7. **Set Visibility to Unlisted.** This is under the **Distribution** tab
   (a separate tab from the main store listing), not a checkbox on the
   listing page itself. Unlisted means the item never shows up in Chrome
   Web Store search or browse pages — only someone with the exact link can
   open it.

8. **Submit for review.**

## What to expect

Review can take longer than a typical extension because this item asks for
a host permission (`https://*.era.nih.gov/*`) and the `cookies` permission —
Google reviews those more closely since they can, in principle, be misused
by other extensions. A review taking one to a few weeks is normal for that
permission combination; it is not a sign anything is wrong with the
submission.

## Sharing the unlisted link

Once approved, the item's page has a normal `chrome.google.com/webstore/...`
(or newer `chromewebstore.google.com/detail/...`) URL. Because it is
Unlisted, that URL will not appear in search or browsing — you have to send
it directly to whoever you want to install it (yourself, on another
computer, or anyone you choose to share it with). Anyone with the link can
open and install it, so only share it with people you actually want to have
it.
