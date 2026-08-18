# Venue ROLLER userscript — change registry

Every customisation the userscript (`venue-roller-checkin.user.js`) makes to ROLLER, **what** it does and **why** we did it. This is the housekeeping record behind the watchdog: when a watchdog email says a check is BROKEN, look up the tweak here, decide whether the *reason* still holds, then fix the one anchor or retire the tweak.

- **Config**: nearly everything is a flag in the `CFG` block near the top of the script — flip a flag to disable one tweak without touching logic.
- **Kill switch**: `localStorage.setItem('rcz-off','1')` (then reload) disables the whole script → stock ROLLER. Remove the key to re-enable.
- **Watchdog**: the `WD_CHECKS` array holds the live health checks; the "Watchdog" column below says which tweaks are auto-monitored. Console: `rczDiag()` (status for the current page), `rczHealth()` (this machine's breakage log).
- **Surfaces**: POS = `pos.roller.app`; Dashboard = `manage.roller.app`. The booking check-in **list** is `/search/bookings/<id>` (`activeRoute()`).

⚠️ **Reasons I need you to confirm** are collected at the bottom — anything where I'm inferring the "why".

---

## A. Booking check-in tiles (POS list)

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| A1 | Reformat ROLLER's booking list into full-frame square **photo cards** in a grid | Staff verify who's in front of them by face, fast, instead of reading a cramped text list | `MIN_COLUMN_PX` (340), `GAP_PX`, `CARD_RADIUS_PX` | `pos-tiles`, `pos-details-btn` |
| A2 | Surface each member's **photo on load** (no "Verify" click) | Identity check should be instant, not one click per guest | — | (covered by data hooks F1) |
| A3 | Check-in button restyled into a faint grey **I.D. shield** (grey tick when due, green when done) | Clearer, calmer check-in affordance matching ROLLER's own un-checked look | `SHOW_SHIELD` | `pos-checkin-btn` |
| A4 | Tapping an already-ticked shield runs ROLLER's own **Undo check-in** | On a membership (multi-use pass) a second tap otherwise **re-checks-in and double-counts** the visit; this undoes safely | `UNDO_CHECKIN` | `pos-checkin-btn` |
| A5 | Put ROLLER's per-ticket **session start time** back on the tile | A booking can span sessions; staff need to know who's due when | `SHOW_SESSION_TIME` | — |
| A6 | Top-of-tile **status band** ("Name: … / Photo: …") | At-a-glance readiness (matched? photo on file?) | — | — |
| A7 | **Birthday** flag (cake + month) when birthday falls last/this/next month | Recognition / engagement | `SHOW_BIRTHDAY`, `BIRTHDAY_ANIMATE` | — |
| A8 | Casual (non-member) tiles show a **"Casual Guest"** tag + the ticket type/name in the photo square | Fills the empty photo area and makes non-members obvious | — | — |
| A9 | Non-admission items (gift card, retail, package) show their **real product type**, never a bogus "Adult" | A gift card was rendering as "Adult"; the age classifier defaulted everything non-child to adult | — | — |
| A10 | Foster-care partner tickets tagged **"Foster CARE Ticket"**, never shown as members | Partner free-entry codes (e.g. MacKillop) aren't memberships | `FOSTER_MATCH`, `FOSTER_LABEL` | — |
| A11 | Membership **tier badge** (Gold Pass / Wonder Club) that links to the member's profile | Identify tier at a glance; click through to the member | `LINK_MEMBERSHIP_BADGE`, `TIER_*` | — |
| A12 | **Name-mismatch fraud flag** ("FRAUD FLAG: NAME MISMATCH") when a membership is used by a different-named ticket-holder, with "ADD A TICKET FOR X" / dismiss | Catch a membership pass being used by someone who isn't the member | `MISMATCH_*` | — |
| A13 | Spelling/nickname tolerance so variants are **not** flagged as mismatches (Bree/Breanna, Flyn/Flynn, Aliya/Aliyah) | A misspelling or nickname is not fraud — over-flagging erodes trust in the warning | `sameName()` logic | — |
| A14 | **Family membership** "add individual name" prompt instead of a mismatch | Family slots often carry the account-holder name / blanks; that's a missing name, not an interloper | `FAMILY_NOTE` | — |
| A15 | **Missing-photo** warning ("WARNING: MISSING DATA / COMPLETE MEMBER PROFILE TO AVOID CANCELLATION" + ADD PHOTO) | A check-in **without a photo** is what triggers ROLLER's auto-cancellation of the membership | `WARN_HEADING`, `WARN_SUB`, `LOCK_ON_MISSING_PHOTO`(off) | — |
| A16 | Missing photo warns but does **not** block check-in | Staff must be able to admit the guest in front of them; the warning describes the real risk (check-in w/o photo), it isn't a hard gate | `LOCK_ON_MISSING_PHOTO=false` | — |
| A17 | **Photo-from-file** upload button ("Choose a photo file / drag & drop") beside ROLLER's camera | Alternative to the glitchy live camera; lets staff attach an existing image | `PHOTO_FILE_UPLOAD` | (see A18) |
| A18 | `getUserMedia` override feeding the chosen file into ROLLER's own Capture pipeline | ROLLER captures from the camera *track*, so a file has to masquerade as the camera to save correctly | `PHOTO_FILE_UPLOAD` | — |
| A18b | On a **party booking**, admission tiles read **"Party Guest"** — big centre label AND the bottom-left tag (was "Casual Guest") — and ROLLER's product line ("Number of Children") is hidden | Flag party attendees at a glance; a booking is a party when it carries a form whose name mentions "party" (detected via `<app-booking-forms>`, scoped so the Party Room resource / party discount don't false-trigger). Only party admission tiles are affected (food/add-ons keep their real type) | `FLAG_PARTY_GUESTS`, `PARTY_GUEST_LABEL` | — |

| A25 | **Guest-tab Name field locked** — greyed + read-only with an inline **"Edit"**; clicking Edit shows a warning (heading "Caution: Name changes are not permitted"; "A membership may NOT be changed from one person to another…") and only on acknowledgement does it become editable (re-locks each page load) | Stop a membership being silently reassigned to a different person via the openly-editable name field; force staff to pause and confirm it's only a spelling/cultural-name correction | `LOCK_MEMBER_NAME`, `NAME_EDIT_LABEL`, `NAME_WARN_TITLE`, `NAME_WARN_TEXT` | `name-lock` |
| A26 | **Membership-profile check-in blocked** — on `/search/memberships/*` the per-row check-in ticks (`check-in-button-<id>`) and the row + select-all checkboxes revealed by the "Memberships (N/M)" filter are hidden | Staff must not check a member in from a membership profile (it records a use without a dated session); they should check in via a ticket/booking instead. `/search/bookings` check-in is untouched | `HIDE_MEMBERSHIP_CHECKIN` | (visual only) |

## A′. Member-detection data rules (how a ticket becomes "member")

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| A19 | **Visiting member** (from another museum) → photo prompt + **"send this to admin"** handoff whenever their photo is taken (by any route) | Their photo doesn't sync back to their home venue, so admin must transfer it or it's lost — see `visiting-member-photo-admin-warning` memory | `AUTO_GUEST_TAB`(off), handoff via `rcz-handoff` | — |
| A20 | **Manual/ad-hoc discount** (no member name/receipt/slot and no membership code) excluded from member detection | A $16 desk goodwill discount was being misread as a child Wonder Club membership | — | — |
| A21 | **Desk-redeemed visiting/reciprocal membership** recovered from the discount `code` ("<receipt>-<partId>") when the member fields are null | Redeemed at the desk (vs online) ROLLER only stamps the code, leaving name/receipt/slot null, so the ticket showed as a plain casual guest | — | — |
| A22 | **Age-named membership** detected by **validity span** (≥60 days, not a "Book for" package) even with no membership keyword | Some annual passes are named exactly like admissions ("Adult (18+ years)") with no keyword; an admission is single-day, a membership runs ~a year | — | — |
| A23 | Family mis-pairing fix (name-match skips unnamed slots; exact-amount match runs before fallback) | Otherwise a family's Adult ticket could link to a Child membership slot | — | — |

## B. Global hides & rewording

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| B1 | Hide the **Select all / Hide checked-in** header checkboxes | Staff never use them; they add clutter and mis-selection risk (kept the sibling actions menu so Undo still works) | — | — |
| B2 | Hide the **"verify membership discount"** banner | Not wanted; noise | — | — |
| B3 | Hide the **"Redeem membership"** button everywhere | Not wanted in the check-in flow | `HIDE_REDEEM` | — |
| B4 | Reword ROLLER's **"Missing member photos"** banner → "Add missing photos to avoid auto cancellation of memberships" | Make the real consequence explicit | `MISSING_PHOTOS_MSG` | — |
| B5 | Relabel **"OPEN ITEMS" → "Membership profiles below"** (+ small sub-line) **only when the section actually holds memberships** | Clarify that these are profiles, not dated admissions — but a gift-card/add-on OPEN ITEMS section keeps ROLLER's heading | `OPEN_ITEMS_LABEL`, `OPEN_ITEMS_SUB` | `pos-section-pills` |
| B6 | Relabel grey **"TODAY" → "TICKETS BOOKED FOR TODAY"** and prefix date headers → "TICKETS BOOKED FOR <date>" | Clarify what the section lists | `TODAY_LABEL`, `DATE_PREFIX` | `pos-section-pills` |
| B7 | **Enlarge** the grey section-header pills (~2×) | Make section boundaries obvious on a busy list | `BIG_SECTION_PILLS` | `pos-section-pills` |

## B′. Block checking-in a membership PROFILE

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| B8 | Hide the header check-in tick on a **membership profile detail** page (all tiers) | A membership profile isn't a dated admission — it shouldn't be checkable there | `HIDE_MEMBER_TICK` | — |
| B9 | Hide the per-tile check-in tick on profiles under **"Membership profiles below"** (all tiers); dated-section tiles keep it | Same reason, on the search/list view | `BLOCK_PROFILE_CHECKIN` | — |
| B10 | Hide the blue **bulk "check (N)"** button when a profile tile is selected (keep the ⋮ menu) | Closes the last route to bulk-checking-in a profile | `BLOCK_PROFILE_CHECKIN` | — |

## C. Search results

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| C1 | Badge each search row **M/SHIP · TICKETS · GIFT CARD · OTHER** | Tell result types apart without opening each; OTHER = no guest attached (walk-up café/retail). Uses the guest-attached signal + validity span + product keywords | `TAG_SEARCH_TYPES`, `SEARCH_*_LABEL` | `search-rows` |

## D. Redeem-membership panel

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| D1 | **"WARNING: PHOTO REQUIRED"** overlay on the grey no-photo tile in the Redeem-membership dialog | Warn staff, while attaching a member to a booking, that the member has no photo on file | `LABEL_REDEEM_NOPHOTO`, `REDEEM_NOPHOTO_*` | `redeem-photo-card` |

## E. Management dashboard (manage.roller.app)

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| E1 | Show **"Guests booked" net of "New memberships"** (guests − new memberships) | The headline "Guests booked" should reflect **actual guests coming in**, excluding people who only bought/renewed a membership that day (ROLLER's raw figure counts those sign-ups) | `DASHBOARD_GUESTS_MINUS_MEMBERSHIPS` | `dash-guests`, `dash-newmemberships` |
| E2 | Remove the **"Funds received"** and **"Revenue"** summary tiles, and the **"Funds received ($)"** product-sales column | Keep venue **financial figures off the shared dashboard** that floor staff see | `DASHBOARD_HIDE_FINANCIALS` | `dash-guests`, `dash-product-grid` |

## F. Infrastructure

| # | Tweak | Why | Flag | Watchdog |
|---|---|---|---|---|
| F1 | Network hooks: intercept `fetch`/`XHR` for `/api/bookings/<id>`, `get-membership`, `keyword-search`, `/api/bookings/today` | The data source for member detection, photos, and search/dashboard badges | — | (implicit — its outputs are checked) |
| F2 | **Watchdog** health telemetry → emails admin on breakage | Catch ROLLER platform changes before staff report them — see `watchdog-health-telemetry` memory | `WATCHDOG*` | itself |
| F3 | **Kill switch** `rcz-off` + `TAB_TRACE` diagnostic | Disable the whole skin to compare against stock ROLLER / field-capture the tab-flicker bug | `TAB_TRACE` | — |
| F4 | After **"Done"** on a child member page, step back past the parent page ROLLER pushes | Return staff to where they came from (usually the booking), not the parent membership page | `DONE_STEP_BACK` | — |
| F5 | Add **Back buttons** on the member detail page | That page is otherwise hard to get back from | — | — |

---

## Reasons confirmed by Tom (2026-08-05)

All previously-inferred reasons confirmed correct:
- **E1** — "Guests booked" net of memberships: yes, headline should reflect actual guests coming in, excluding membership-only purchases.
- **E2** — remove Funds received / Revenue / Funds-received column: yes, keep venue financial figures off the shared dashboard floor staff see.
- **A15/A16** — missing-photo warns but never blocks: yes, keep as-is (warn loudly, never hard-stop a check-in).

## Parked / off by default (kept in code, not active)
- `FLAG_MISASSIGNED` (off) — reassurance note for a discount mis-assignment where the real member is on the booking.
- `SHOW_NAME_MEANING` (off) — first-name meaning line (dictionary built, collides with the tier badge; needs repositioning before re-enabling).
- `AUTO_GUEST_TAB` (off) — auto-navigate to the Guest tab + open camera; disabled because ROLLER re-flips the tab.
| A27 | **Audit email on member name change** — when staff Edit -> unlock -> actually change a member Name on the Guest tab, the admin is emailed (old->new name, till operator, booking/item ids, machine, version, time) via the watchdog Apps Script with `{kind:"audit"}` | Give the admin an audit trail of who reassigned/renamed a membership and to what; deters silent name swaps | `AUDIT_NAME_EDITS`, `AUDIT_URL` (falls back to `WATCHDOG_URL`) | (uses the watchdog endpoint; needs Apps Script `kind:"audit"` branch) |
| A28 | **Audit "Location" auto-detected** — each till's ROLLER venue id is captured from the doorlist `Current-Venue` request header (and `/today` `venueId`), mapped to a friendly name via `CFG.VENUE_MAP`; audit emails show the venue. No per-till setup | Tom asked which of the four venues an audit came from, sourced automatically from ROLLER (no feeding). 5311=MoPA Sandringham; other ids self-surface as "Venue #<id>" until mapped | `VENUE_MAP`, `rczCaptureVenue`, `rczLocation`; optional `rczSetLocation()` override | (audit channel) |
| A29 | **Membership-ticket cross-pairing fix** — pairing now runs Pass 0 (exact name+amount) before name-only matching, so same-holder-name tickets of different ages pair to the correct-age membership | Booking 109321637: Adult+Child tickets both named "Han"; Han Yu adult pass got linked to the child ticket (and vice-versa). ROLLER's own records were right; our tile pairing was wrong | (processBooking passes) | — |
| A30 | **Family name-duplicate nudge + PASS DUPLICATE override** — when a family membership's holder name is on 2+ tickets (child ticket carries the parent name, mismatching its own pass), show a soft frosted nudge (FRAUD WARNING: NAME / FAMILY NAME DUPLICATE / PASS DUPLICATE) instead of the hard mismatch lock; PASS DUPLICATE unlocks the shield for 2 min and emails the admin | The hard cross-account mismatch was over-flagging routine family bookings (Ellie, booking 109655443); staff need a one-tap approved override, with an audit trail | `FAMILY_DUP_NUDGE`, `DUP_WARN_HD/SUB/LINK`, `AUDIT_PASS_DUP` | (uses audit endpoint) |
