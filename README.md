# Release Check – proof of concept v1.6 (Route 2: installable web app)

**This version captures only the collection Time and the Registration from the Daily Diary.** Every other column (customer, booking ref, VIN and so on) is ignored. Because the VIN is not captured, the VIN check is switched off in this version.

**No names are stored.** Operators and supervisors are identified by an **operator ID**: 2–12 letters, digits or hyphens. Use staff or badge numbers, not names or initials.

**Plate photos setting.** Choose All scans, Exceptions only (default) or Off. Every change is recorded in the audit log, and each logged scan records which mode was in use and whether its photo was saved.

**A day's diary can have up to 3 pages** (page 1 plus 2 additional pages). Each extra page is added to the same list. It never replaces the list.

A phone web app that checks a vehicle against today's Daily Diary before release.

- **Capture the diary.** Photograph the printed Daily Diary. The app reads the collection time and registration from each row, and you check the list before locking it.
- **Scan the vehicle.** Read the number plate with the camera, or type it in.
- **Get a result:** OK TO RELEASE, DO NOT RELEASE, MANUAL CHECK or ALREADY RELEASED.
- **Safeguards:**
  - collector check (booking and photo ID) before handover
  - supervisor override with supervisor ID and reason (the supervisor ID must differ from the operator's)
  - flags on the diary review for:
    - duplicate registrations, including across pages
    - low read confidence on the registration or the time
    - missing times
    - times outside site hours
    - times out of sequence with the rows around them
  - vehicles already handed over can't be released again
- **Audit log** with time, operator ID, result and (depending on the Plate photos setting) a plate photo, exportable as CSV.

Everything runs on the phone. Text reading uses Tesseract.js. Data is stored in the browser on that phone only. Nothing is uploaded.

> **Use test data only** until IT security and the data protection lead have approved a pilot. See "Before using with real data".

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App page |
| `app.js` | All app logic |
| `styles.css` | Styling |
| `sw.js` | Offline cache (service worker) |
| `manifest.webmanifest`, `icons/` | Lets Android install it as an app |
| `sample-diary.html` | Printable 3-page test Daily Diary (with deliberate problems to catch) and test number plates |

---

## 1. Put it online (HTTPS is required for the camera)

Option A works from a phone. Option B is quickest on a computer.

### Option A: GitHub Pages (free)
1. Create a free account at github.com, then tap **New repository**. Name it, for example, `release-check`, and set it to **Public**.
2. Tap **Add file → Upload files**. Upload every file and keep the `icons` folder. Unzip the download first. On a phone, upload the `icons` files from inside a folder named `icons`, or create them with **Add file → Create new file** and type `icons/` in the name box.
3. Go to **Settings → Pages**, then under **Source** choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After 1–2 minutes your app is at `https://<your-username>.github.io/release-check/`.

### Option B: Netlify Drop (no account needed for a quick test)
1. On a computer, open `app.netlify.com/drop`.
2. Drag the unzipped `release-check` folder onto the page.
3. You get an `https://….netlify.app` link straight away. Without an account, the link expires after a while.

A company web server or SharePoint-hosted site works too, as long as it serves the files over HTTPS.

## 2. Install on the Android phone

1. Open the HTTPS link in **Chrome**. On first launch, enter your operator ID.
2. Allow camera access when asked.
3. Chrome menu (⋮) → **Add to home screen** (or **Install app**).
4. Open **Release Check** from the home screen. It opens full screen like a normal app.

The first diary read downloads the text reader (about 10 MB), so do it on Wi‑Fi. After that it is cached on the phone.

## 3. Test it (about 10 minutes)

1. Open `sample-diary.html` on a computer (from the same site, e.g. `…/release-check/sample-diary.html`) and print it, or show it on a second screen.
2. In the app, enter your name, then **Capture Daily Diary** and photograph page 1. Alternatively, tap **Load test diary (demo)** to skip the camera.
3. On **Check extracted list**, tap **Photograph page 2**, then **Photograph page 3**, and photograph pages 2 and 3 of the test diary. The rows are grouped by page. The test pages contain problems the app should flag:
   - page 2: a vehicle repeated from page 1 (Duplicate), and a 21:40 row (outside site hours)
   - page 3: a 12:10 row between 16:00 and 16:30 (out of sequence)

   You will see only Registration and Collection time for each row. Compare them with the paper, fix any wrong characters, confirm the flagged rows, tick the checkbox and **Lock today's list**.
4. **Scan Vehicle** and point the camera at the test plates on page 2:

| Plate | Expected result |
|---|---|
| AB21 XYZ | OK TO RELEASE (shows collection 09:30) → tick collector → **Confirm handover** |
| AB21 XYZ again | ALREADY RELEASED |
| PK66 WEB | DO NOT RELEASE → **Contact supervisor** → override with reason and name |
| YX19 RPL | OK TO RELEASE |
| A blurred or angled plate | MANUAL CHECK → **Checked by eye** or supervisor override |

5. Open **Audit log** and then **Export CSV** to check the record.

What to measure in the proof of concept:
- the share of diary rows read correctly first time
- the share of plates read correctly first time, in daylight, at night with the torch, and with dirty plates
- seconds per handover compared with the current manual check

---

## How the decisions are made

| Situation | Result |
|---|---|
| Plate exactly matches a diary entry, read confidence ≥ threshold (default 85%), not yet released | **OK TO RELEASE**, then collector check before handover |
| Plate matches but the camera read is below the threshold, or characters were auto-corrected | **MANUAL CHECK** |
| No exact match, but one character away from a diary entry (e.g. 0/O, 1/I, 8/B) | **MANUAL CHECK**, with a "did you mean" option |
| The read breaks UK plate rules (e.g. `KP76 MIX`: I and Q are never used in the last three letters; I, Q and Z never in the first two) and a diary entry is one character away | **MANUAL CHECK**, saying the read is impossible and naming the closest diary entry |
| Not on the diary | **DO NOT RELEASE** |
| Already handed over today | **ALREADY RELEASED** |

- **v1.6:**
  - Rows are built from where text sits on the page, so the first registration is still used when the photo's columns are read separately.
  - If the first registration on a row cannot be read, the second line is NOT used in its place. The row is left blank, and the list can't be locked until the registration is typed in.
  - The first two letters of a plate never use I, so a read such as KI26 VAD is corrected to KJ26 VAD and flagged for checking.
- **v1.5 (first registration per row):** when a diary row shows more than one registration (two lines in the registration cell, or two on one line), only the FIRST (top or leftmost) is added to the list. The row is flagged on the review screen, naming the registration that was left out, so the operator confirms it against the paper diary.
- **v1.4 (plate-letter rule):** a camera read that breaks the UK plate rules is treated as a misread. The app ranks it below valid reads, tries two extra reading passes at a larger size, and flags such rows on the diary review screen. It still never releases on a guess: the operator must confirm by eye.
- **MANUAL CHECK:** the operator can confirm the plate by eye, which is logged. The vehicle then goes through the normal collector check.
- **DO NOT RELEASE:** only a supervisor override, with name and reason, releases the vehicle.
- **Settings** (tap your ID, top right): operator ID, confidence threshold, site opening and closing times, and plate photos.
- **Plate photos:**

| Mode | Photo saved for |
|---|---|
| All scans | Every camera read |
| Exceptions only (default) | DO NOT RELEASE, MANUAL CHECK, ALREADY RELEASED and supervisor overrides |
| Off | Nothing (scanning still works, and the photo is shown on screen but not saved) |

  The audit log and CSV record, for every scan:
  - the photo mode in use
  - whether the photo was saved (`yes`, `no`, or `no photo taken` for typed checks)

  A **SETTINGS CHANGED** entry records each change, e.g. "Plate photos: Exceptions only → Off".
- **CSV columns:** timestamp, operator_id, registration, result, detail, confidence, method, supervisor_id, photo_mode, photo_saved.
- **Diary pages:** up to 3 per day.
  - On the review screen, use **Photograph page 2/3** before locking.
  - After locking, use **Add page 2 of 3** (or 3 of 3) on the home screen. Rows already locked stay as they are, and only the new page needs checking. Then lock again.
  - **New diary** replaces the whole list. Vehicles already released stay released.
  - **Remove page** removes the last page added, if it was a bad photo.
- **Time flags.** A row is flagged when:
  - no time was read
  - the time was read with low confidence
  - the time is outside site hours (Settings, default 06:00–20:00)
  - the time breaks the order of the rows around it on the same page

  The order check only runs when a page is mostly in time order, so a diary that isn't sorted by time won't be flagged everywhere. Edit the time or tick "Matches the paper diary".

## Known limits of this proof of concept

- **Reading accuracy.** Tesseract is a general text reader, not a dedicated number-plate (ANPR) engine. Expect weaker results on angled, dirty, wet or reflective plates. That is why low-confidence reads go to Manual check and the VIN check exists. A production version would use Google ML Kit (on-device) or a commercial ANPR software kit.
- **Plate formats.** Plates are auto-detected for current UK plates (AB12 CDE) and older prefix/suffix plates. Northern Ireland and dateless plates can be typed or added to the diary by hand.
- **No VIN check in this version.** The diary capture doesn't read the VIN, so the app can't confirm that the plate belongs to the right car (e.g. a swapped plate). The VIN check code is still in `app.js` and can be switched back on in a later version that captures the VIN.
- **One phone, one record.** Data lives on one phone. Two operators on two phones do not see each other's handovers. A pilot across a team needs a shared backend, such as SharePoint, Dataverse or an API.
- **Upgrading from v1.2 or earlier.** The stored operator name is deleted and the app asks for an operator ID. Audit entries logged by earlier versions still contain names, so export and **Clear log** after updating.
- **Storage.** Browser storage holds roughly a few hundred logged checks with photos (far more with Exceptions only or Off). Export the CSV at the end of each day and **Clear log**.
- **Diary changes.** If bookings change during the day, use **New diary** and capture all pages again. Release records for the day are kept.
- **Page limit.** Up to 3 pages per day. Rows per page are not capped, but smaller print means more misreads to correct. Test with a real full page from the site.
- **Time checks are a safety net, not proof.** A time misread as another plausible, in-order time (e.g. 11:15 read as 11:18) can still pass if its read confidence is high. The operator's check against the paper diary remains the control.

## Before using with real data

- [ ] IT security approval for the hosting location and for using company phones (managed by MDM)
- [ ] Data protection impact assessment (DPIA): customer names, registrations and plate photos are personal data
- [ ] Retention rule for the exported audit CSV
- [ ] Parallel run: the app advises, but the existing manual check stays the control until accuracy is proven
- [ ] Self-host the text reader (`tesseract.js`, `tesseract.js-core`, English language data) instead of loading it from the jsDelivr CDN, if policy requires

## Troubleshooting

- **The camera doesn't open.** The site must be HTTPS. In Chrome, go to ⋮ → Settings → Site settings → Camera and allow the site.
- **"Text reader did not load".** The first use needs internet access to cdn.jsdelivr.net, which some company networks block.
- **The diary reads badly.** Lay the page flat, avoid shadows and glare, and fill the frame. Plain tables with clear print work best. Rows can always be edited or added by hand.
- **Debugging a plate read.** Add `#debug` to the address. The prepared image and text of each attempt are kept in `window.__rcDebug`.

---

## Copyright

© 2026 Justin Akuagwu. All rights reserved.

Shared for portfolio viewing only; no licence is granted to copy, modify or use this code. See [NOTICE](NOTICE) for details and third-party components.
