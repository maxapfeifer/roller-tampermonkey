// ==UserScript==
// @name         Venue — ROLLER Check-in Cards + Member Photos
// @namespace    venue.roller.checkin-cards
// @version      5.154
// @description  Reformats the ROLLER POS booking check-in list into full-frame photo cards, surfaces member photos on load (no Verify click), alerts when a member has no photo, handles family memberships (best-effort photos + add-name prompt) and close/similar name matches.
// @match        https://pos.roller.app/*
// @match        https://*.roller.app/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/maxapfeifer/roller-tampermonkey/main/venue-roller-checkin.user.js
// @updateURL    https://raw.githubusercontent.com/maxapfeifer/roller-tampermonkey/main/venue-roller-checkin.user.js
// ==/UserScript==
(function () {
  'use strict';

  /* ======================================================================
     DEBUG KILL-SWITCH — fully disables this script so ROLLER's stock UX is
     visible, for comparing native behaviour against our skin. When active, we
     inject nothing, add no overlays/classes, install no click handlers, and
     start no observers. Toggle from the browser console, then reload the page:
         localStorage.setItem('rcz-off','1');   // OFF  -> stock ROLLER UX
         localStorage.removeItem('rcz-off');    // ON   -> our skin (default)
     Or append #rcz-off to the URL for a one-off disable without persisting.
     ====================================================================== */
  try {
    if (localStorage.getItem('rcz-off') === '1' || /[?#].*rcz-off/.test(location.href)) return;
  } catch (e) {}

  /* ======================================================================
     CONFIG  — the dials you can safely tweak
     ====================================================================== */
  var CFG = {
    MIN_COLUMN_PX:     340,  // smaller = more (and smaller) cards per row; larger = fewer, bigger photos. 340 (not 360) keeps 3 cols stable: at ~1100px content, 3 cols need 3*MIN+2*gap; 360 lands exactly on the boundary so a vertical scrollbar (~17px, present on long bookings) tips it to 2 cols while short bookings stay 3 — 340 gives the headroom for a consistent count either way.
    GAP_PX:            12,   // gutter between cards
    CARD_RADIUS_PX:    18,
    PLACEHOLDER_ICON_PX: 150,// size of the grey person icon when there's no photo
    CDN:              'https://cdn.rollerdigital.com/ticket/',
    GET_MEMBERSHIP:   'https://doorlist.roller.app/api/customers/get-membership',
    // Foster-care partnership discounts: free-entry codes that are NOT memberships. Matched (lower-cased,
    // substring) against the discount code and name. Add future partner codes here. Guests carrying one are
    // shown as a "Foster CARE Ticket" (where "Casual Guest" normally sits), never as members.
    FOSTER_MATCH:     ['mfslumk', 'mackillop family services'],
    FOSTER_LABEL:     'Foster CARE Ticket',
    PHOTO_FILE_UPLOAD: true,  // add a "Choose a photo file / drag-drop" button by ROLLER's camera capture, feeding the chosen image into ROLLER's own Capture pipeline
    HIDE_REDEEM:      true,   // hide ROLLER's "Redeem membership" button everywhere
    LABEL_REDEEM_NOPHOTO: true,        // overlay a "no photo on file" warning on the grey placeholder in ROLLER's Redeem-membership panel
    REDEEM_NOPHOTO_HD:  'WARNING:',    // first line of that warning
    REDEEM_NOPHOTO_SUB: 'PHOTO REQUIRED',  // second line (wraps to fill the small grey square)
    DASHBOARD_GUESTS_MINUS_MEMBERSHIPS: true,  // on manage.roller.app dashboard, display "Guests booked" NET of "New memberships" (guests - new memberships)
    DASHBOARD_HIDE_FINANCIALS: true,           // on manage.roller.app dashboard, remove the "Funds received" + "Revenue" summary tiles and the "Funds received ($)" product-sales column
    // ---- WATCHDOG: silent health telemetry across all deployments ----
    WATCHDOG: true,             // run the health checks in the background and report breakage
    WATCHDOG_URL: 'https://script.google.com/macros/s/AKfycbyxAzme9u1v0Q8nx585z4fbvhkyRYFoUfOyZNHRNtTFwreJ5ZWZDMtzDVo_kUvO6eSl/exec',   // your Google Apps Script webhook (emails you). '' = detect + log locally only, SEND NOTHING
    WATCHDOG_EVERY_MS: 60000,   // how often to run the checks (1 min)
    WATCHDOG_STREAK: 3,         // must be broken this many consecutive runs before reporting (rides out page-load transients)
    WATCHDOG_MIN_HOURS: 24,     // per machine, report each check+version at most once in this many hours (anti-spam)
    DONE_STEP_BACK:   true,   // after "Done" on a child member page, step back past the parent page it pushes
    FLAG_MISASSIGNED: false,  // OFF: a discount mis-assignment where the real member IS on the booking shows nothing (normal member). Set true to restore the "MEMBERSHIP DISCOUNT MIS-ASSIGNED" reassurance note.
    WARN_HEADING:     'WARNING: MISSING DATA',                   // ACTION REQUIRED banner big heading (missing-data / ADD PHOTO box only)
    WARN_SUB:         'COMPLETE MEMBER PROFILE TO AVOID CANCELLATION',  // ACTION REQUIRED banner sub-line
    MISMATCH_ACTREQ_HD: 'FRAUD FLAG: NAME MISMATCH',              // heading on the name-mismatch action box
    MISMATCH_ACTREQ_SUB: 'PLEASE CHECK PHOTO EXTRA CAREFULLY',    // sub-line on the name-mismatch action box
    MISSING_PHOTOS_MSG: 'Add missing photos to avoid auto cancellation of memberships',  // reword ROLLER's "Missing member photos" banner sub-line (native text: "Add missing photos to help staff verify members quickly.")
    OPEN_ITEMS_LABEL:  'Membership profiles below',  // relabel ROLLER's "OPEN ITEMS" section pill ('' = leave it as-is)
    OPEN_ITEMS_SUB:    '(If you’re trying to check these guests in, please find or add tickets)',  // smaller second line under OPEN_ITEMS_LABEL ('' = none)
    TODAY_LABEL:       'TICKETS BOOKED FOR TODAY',   // relabel the grey "TODAY" section-header pill above the ticket tiles ('' = leave it). Only the grey (color--neutral) pill; the green "Today" status badge is untouched.
    BIG_SECTION_PILLS: true,                         // enlarge the grey section-header pills (~3x) so section boundaries are obvious; in-card status pills stay normal size
    DATE_PREFIX:       'TICKETS BOOKED FOR ',        // prefix grey DATE section-header pills, e.g. "11 May 2026" -> "TICKETS BOOKED FOR 11 May 2026" ('' = leave dates as-is)
    TAG_SEARCH_TYPES:  true,                         // badge each booking-search result as a MEMBERSHIP purchase vs attendance TICKET (from the search response's productName)
    SEARCH_MEM_LABEL:  'M/SHIP',                      // badge text for a membership-purchase search result
    SEARCH_TKT_LABEL:  'TICKETS',                    // badge text for an attendance-ticket search result
    SEARCH_GIFT_LABEL: 'GIFT CARD',                  // badge text for a gift-card search result
    SEARCH_OTHER_LABEL:'OTHER',                      // badge text for a result with no guest attached (walk-up café/retail/misc)
    BLOCK_PROFILE_CHECKIN: true,  // hide the check-in tick on membership tiles under the "MEMBERSHIP PROFILES ONLY" (ROLLER's OPEN ITEMS) section — those are membership PROFILES, not a dated admission. ALL member types. Tiles under a DATE section (a real session booking) keep their tick.
    HIDE_MEMBER_TICK: true,      // on a membership PROFILE detail page (member profile via search, or a membership item detail), hide ROLLER's check-in tick in the header. All member types. Leaves the Back button and ticket item details alone.
    // Age-type icons for casual/foster tiles (infant/child/adult), by ticket type. Populated with data:URIs
    // just below the CFG block (kept out of the literal so the base64 blobs don't clutter the config).
    AGE_ICONS:        {},
    ALERT_LINES:      ['ADD PHOTO NOW!', 'WARNING: ANY CHECK-IN WITHOUT PHOTO WILL CAUSE CANCELLATION'],
    // Casual (non-member) card: big NAME, then the ticket TYPE, then a small sub-line.
    // Solo tickets show the type upper-cased (ADULT/CHILD/…); "Book for 6 @ $…" package tickets
    // show "Group of 6". {N} filled at render time.
    CASUAL_SUB:        'CASUAL BOOKING (NO PHOTO REQUIRED)',
    CASUAL_GROUP_TYPE: 'Group of {N}',
    FLAG_PARTY_GUESTS:  true,          // on a PARTY booking (has a form whose name mentions "party"), label admission tiles "Party Guest" instead of Adult/Child
    PARTY_GUEST_LABEL:  'Party Guest', // the label used for party admission tiles
    // Shown in the name slot when a ticket genuinely has no holder name anywhere (blank on the ticket AND
    // absent from the Ticket Holder Details form) — e.g. a child added at the door and never named. Sentence
    // case + same name font, so staff can tell "customer didn't provide it" apart from "script missed it".
    NO_NAME:           'No name provided',
    MISMATCH_LINES:   ['NAME MIS-MATCH'],
    // {MEMBER} is filled in bold + UPPERCASE, {TICKET} as the proper-cased ticket first name.
    MISMATCH_NOTE_TMPL: 'The membership number used belongs to {MEMBER}, not {TICKET}. Search Members to confirm {TICKET} is a member prior to check-in.',
    VISITING_LINES:   ['PHOTO REQUIRED NOW', 'THE SYSTEM CANCEL\'S MEMBERSHIPS IF A CHECK-IN OCCURS WITHOUT A PHOTO ON FILE. NOTE: THIS MEMBER IS VISITING FROM ANOTHER MUSEUM!'],
    // Family membership: photo shown best-effort (positional), with a prompt to add the individual's name.
    FAMILY_NOTE:      'Please add name to this membership. To do so, click the corresponding BLUE DISCOUNT LABEL in the bottom left, then click GUEST, then add the NAME in the empty NAME field.',
    // Close/similar name (e.g. member "Jax" vs ticket "Jaxson"): photo shown, staff verify it's the
    // same person. {NAME} = membership first name, {TICKET} = ticket first name.
    CLOSE_TITLE:      'EXACT NAME VERIFICATION REQUIRED',
    CLOSE_NOTE_TMPL:  'The Membership Number used for this ticket belongs to {NAME}, not {TICKET}. Do not check this person in if {NAME} is not the same person as {TICKET}.',
    // Member whose OWN ticket shows no discount, while their membership discount landed on another guest
    // (checkout mis-assigned it). Reassures the POS user the total is still right. {NAME} = member first
    // name; {TYPE} = the ticket type (adult/child/…) of the guest who actually received the discount.
    PAID_MEMBER_TITLE:    'MEMBERSHIP DISCOUNT MIS-ASSIGNED',
    PAID_MEMBER_NOTE_TMPL:'{NAME} does have a Membership but this booking shows that they have paid full price. It is likely that the online checkout assigned their discount to another {TYPE}, resulting in the correct total amount being charged to these guests but a simple mis-assignment of which adult the membership was applied to - No action required.',
    // Companion banner shown ONLY on the paired name-mismatch tile when the "paid full price" banner is
    // also showing on this booking — reassures the two are the same harmless mis-assignment.
    MISALIGN_TITLE:       'MEMBERSHIP DISCOUNT MIS-ALIGNED',
    MISALIGN_NOTE:        'On this booking is a Member that should have received a Member discount, but actually paid full price. This Member name mis-match error is probably explained by this whoopsy: i.e. One adult that ISN\'T a member has received a member discount, and one adult that IS a member hasn\'t. Therefore - No action required.',
    TIER_LABEL:       'Membership',
    TIER_GOLD:        'Gold Pass',
    TIER_WONDER:      'Wonder Club',
    // ---- prototype engagement features (toggle off by setting to false) ----
    SHOW_NAME_MEANING: false, // PARKED — dictionary is built (see NAME_MEANINGS); flip to true to prototype
    // NOTE: when re-enabling, the meaning line currently collides with the enlarged tier badge; reposition first.
    SHOW_BIRTHDAY:     true,  // flag birthdays falling in last / this / next calendar month
    BIRTHDAY_ANIMATE:  true,  // animate the cake (bounce) + a small confetti burst
    SHOW_SHIELD:       true,  // reshape the check-in button into an I.D. shield: amber "I.D." -> green tick
    SHIELD_LABEL:      'Confirm',
    SHIELD_SUB:        'I.D.',   // shield reads "Confirm" (small top) over "I.D." (big bottom)
    // Tapping a shield that is ALREADY ticked runs ROLLER's own "Undo check-in" (see the UNDO CHECK-IN
    // section further down for how that works). Setting this false hands the tap back to ROLLER's raw
    // button — which on a membership RE-CHECKS THEM IN instead of undoing, so only turn it off when
    // deliberately comparing against stock behaviour.
    UNDO_CHECKIN:      true,
    // Record the Guest/Membership tab flip-flop when it happens. It's intermittent and has resisted being
    // reproduced on demand, so rather than ask staff to paste console snippets, capture it in the field.
    // Costs nothing until an ADD PHOTO / link-through actually runs; then samples on a timer for 12s and
    // keeps the capture ONLY if it looks pathological. Read it back with rczTabTrace() in the console.
    TAB_TRACE:         true,
    // Auto-navigate staff to the Guest tab (and pre-open the camera) after an ADD PHOTO / link-through.
    // OFF for now: ROLLER re-flips the tab on its own whenever our script touches it, so we've stopped
    // fighting it — the detail page just lands where ROLLER puts it (usually the Membership tab) and staff
    // click the Guest tab + the Capture button themselves. Flip back to true to restore the auto flow.
    AUTO_GUEST_TAB:    false,
    // Does a MISSING PHOTO block the shield? No — deliberately. We tell staff that a check-in WITHOUT a
    // photo is what triggers the cancellation flag, so blocking the check-in outright made that warning
    // describe something that could never happen, and left staff stuck with a guest in front of them.
    // The prompts stay exactly as loud as they were; only the lock is lifted. A NAME mismatch still locks
    // hard (see nameGate) — that one is a fraud signal, not an admin gap.
    LOCK_ON_MISSING_PHOTO: false,
    // Put ROLLER's per-ticket session start time back on the tile. Stock ROLLER prints it against every
    // ticket; our full-frame redesign hid it along with the rest of .summary-detail. Staff need it —
    // a booking can span sessions, and it's how they know who is due when.
    SHOW_SESSION_TIME: true,
    // ---- membership search results ----
    SHOW_MEMBERSHIP:   true,  // format membership results (photo + "Membership Found" panel). false = leave as ROLLER draws them
    MEM_TITLE:         'Membership Found',
    MEM_VALID_DAYS:    364,   // membership validity; Ends = purchase date + this many days
    // ---- membership tag → link-through ----
    LINK_MEMBERSHIP_BADGE: true,  // make the "Membership / <tier>" tag a link to that member's detail page
    MEM_LINK_NEWTAB:   false, // false = navigate in the same tab (mirrors ROLLER's blue discount link); true = new tab
    FORMS_URL:        'https://doorlist.roller.app/api/bookings/forms?formResponseId='
  };
  CFG.AGE_ICONS = {infant:'data:image/png;base64,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',child:'data:image/png;base64,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',adult:'data:image/png;base64,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'};

  /* Bundled first-name -> meaning dictionary (no network needed). Common names only; anything not
     listed simply shows nothing. Keyed lowercase. Extend freely. */
  var NAME_MEANINGS = {
    aaliyah:'rising; exalted', abigail:'my father is joy', ada:'noble', adam:'man; of the earth', addison:'child of Adam',
    adrian:'from Hadria; dark one', aiden:'little fire', alan:'handsome; harmony', alex:'defender of the people',
    alexander:'defender of the people', alexis:'defender', alice:'noble; truthful', amber:'jewel; golden', amelia:'work; industrious',
    amy:'beloved', anderson:'son of Andrew', andrew:'strong; manly', angus:'one strength', anna:'grace', annabelle:'loving; grace',
    anthony:'priceless; praiseworthy', archer:'bowman', archie:'genuine; bold', aria:'melody; air', arlo:'fortified hill',
    arthur:'bear; noble', asher:'happy; blessed', ashley:'ash-tree meadow', aubrey:'elf ruler', audrey:'noble strength',
    aurora:'dawn', austin:'great; magnificent', ava:'life; birdlike', axel:'father of peace', bailey:'steward; bailiff',
    banjo:'from the instrument; Australian classic', bella:'beautiful', ben:'son of the right hand', benjamin:'son of the right hand',
    beau:'handsome', billie:'resolute protector', blake:'dark; fair', bodhi:'awakening; enlightenment', bodey:'awakening; enlightenment',
    bonnie:'pretty; cheerful', brayden:'brave; broad', brody:'ditch; brother', brooke:'small stream', bruce:'the willowlands',
    caleb:'devotion; whole-hearted', cameron:'crooked nose', carter:'transporter of goods', charlie:'free man', charlotte:'free woman',
    chase:'huntsman', chelsea:'chalk landing place', chloe:'blooming; young shoot', chris:'bearer of Christ', christopher:'bearer of Christ',
    claire:'clear; bright', clara:'bright; clear', cody:'helpful; pillow', connor:'lover of hounds', cooper:'barrel maker',
    daisy:"day's eye; the flower", daniel:'God is my judge', darcy:'from Arcy; dark', david:'beloved', declan:'full of goodness',
    dylan:'son of the sea', eddie:'wealthy guardian', eden:'delight; paradise', edward:'wealthy guardian', elena:'bright; shining light',
    eli:'ascended; my God', elijah:'the Lord is my God', ella:'fairy maiden; light', ellie:'light; bright', elliot:'the Lord is my God',
    ellis:'benevolent; the Lord is my God', eloise:'healthy; wide', elsie:'pledged to God', emily:'rival; industrious', emma:'whole; universal',
    ethan:'strong; firm', eva:'life', evelyn:'wished-for child', evie:'life', ezra:'help', felix:'happy; fortunate',
    finn:'fair; white', finley:'fair-haired hero', fletcher:'arrow-maker', flynn:'son of the red-haired one', frankie:'free one',
    freya:'noble lady; Norse goddess of love', gabriel:'God is my strength', george:'farmer; earth-worker', georgia:'farmer',
    grace:'grace; goodness', grayson:'son of the steward', gus:'great; majestic', hallie:'meadow; home ruler',
    hannah:'grace; favour', harley:'hare meadow', harper:'harp player', harrison:'son of Harry', harry:'home ruler',
    harvey:'battle-worthy', hazel:'the hazel tree', heidi:'noble; serene', henry:'home ruler', holly:'the holly tree',
    hope:'hope', hudson:'son of Hugh', hugo:'mind; intellect', hunter:'one who hunts', iris:'rainbow', isaac:'he will laugh',
    isabella:'devoted to God', isabelle:'devoted to God', isla:'island', ivy:'the ivy plant; faithfulness', jack:'God is gracious',
    jackson:'son of Jack', jacob:'supplanter', jade:'the green stone', jake:'supplanter', james:'supplanter',
    jasmine:'the jasmine flower', jasper:'treasurer; bringer of treasure', jax:'God has been gracious', jaxon:'son of Jack',
    jaxson:'son of Jack', jayden:'thankful; God has heard', jed:'beloved of God', jemima:'dove', jenna:'fair; white wave',
    jessica:'God beholds', joel:'the Lord is God', john:'God is gracious', jonah:'dove', jordan:'to flow down',
    joseph:'God will increase', joshua:'the Lord is salvation', judah:'praised', jude:'praised', julia:'youthful',
    juliet:'youthful', karen:'pure', kate:'pure', katie:'pure', kayla:'pure; crown of laurels', kai:'sea',
    keira:'dark-haired', kimberly:'from the royal meadow', kobe:'supplanter', kyla:'narrow; strait', lachlan:'from the land of lakes',
    lara:'protection; cheerful', laura:'laurel; victory', lauren:'laurel', layla:'night', leah:'weary; delicate',
    leo:'lion', leon:'lion', levi:'joined; attached', lewis:'renowned warrior', liam:'strong-willed protector',
    lila:'night; playful', lily:'the lily flower; purity', lincoln:'town by the pool', logan:'little hollow', lola:'lady of sorrows',
    lucas:'bringer of light', lucy:'light', luke:'bringer of light', luna:'moon', mackenzie:'child of the wise leader',
    maddison:'child of Maud', madeleine:'high tower; woman of Magdala', maisie:'pearl', mara:'bitter; sea', marcus:'warlike',
    margaret:'pearl', maria:'bitter; beloved', mary:'beloved; bitter', mason:'stone worker', matilda:'mighty in battle',
    matthew:'gift of God', max:'greatest', maximilian:'greatest', maya:'illusion; water', megan:'pearl', mia:'mine; beloved',
    michael:'who is like God?', michelle:'who is like God?', mila:'gracious; dear', millie:'gentle strength', molly:'star of the sea',
    montana:'mountain', morgan:'sea-born; sea-circle', muhammad:'praiseworthy', nate:'gift of God', nathan:'he gave',
    nathaniel:'gift of God', nell:'bright; shining', nicholas:'victory of the people', noah:'rest; comfort', nora:'light; honour',
    oakley:'oak meadow', olive:'the olive tree; peace', oliver:'olive tree; peace', olivia:'olive tree', oscar:'friend of deer; spear of the gods',
    owen:'young warrior; well-born', paige:'young attendant', parker:'park keeper', patrick:'nobleman', paul:'small; humble',
    penelope:'weaver', peter:'rock', phoebe:'bright; radiant', piper:'pipe player', poppy:'the red flower', quinn:'descendant of Conn; wise',
    rachel:'ewe; one with purity', raphael:'God has healed', rebecca:'to bind; captivating', reef:'ridge of rock; coastal',
    reuben:'behold, a son', riley:'courageous; rye clearing', river:'flowing water', rose:'the rose flower', ruby:'the red gemstone',
    ryan:'little king', sadie:'princess', sam:'God has heard', samuel:'God has heard', sara:'princess', sarah:'princess',
    savannah:'open plain', scarlett:'red; rich cloth', sebastian:'venerable; revered', seth:'appointed', sienna:'reddish-brown; from Siena',
    simon:'he has heard', sofia:'wisdom', sophia:'wisdom', sophie:'wisdom', spencer:'steward; dispenser', stella:'star',
    summer:'the summer season', sunny:'cheerful; of the sun', tara:'hill; star', taylor:'tailor', theodore:'gift of God',
    thomas:'twin', tilly:'mighty in battle', tobias:'God is good', toby:'God is good', tom:'twin', tommy:'twin',
    violet:'the purple flower', viv:'alive; lively', vivian:'alive; lively', vivienne:'alive; lively', william:'resolute protector',
    willow:'the willow tree; grace', wyatt:'brave in war', xavier:'bright; new house', zac:'the Lord remembers', zachary:'the Lord remembers',
    zara:'blooming flower; princess', zoe:'life', zoey:'life'
  };

  /* ======================================================================
     STATE
     ====================================================================== */
  var state = {
    authByOrigin: {},   // origin -> {header:value}  (borrowed from ROLLER's own calls)
    booking:      null, // last booking payload seen
    byCard:       {},   // cardId(bookingItemPartId) -> {member, pending, photo}
    discountIndex:{},   // memberBookingItemPartId -> {name, cardId}  (Verify-click fallback)
    birthdays:    {},   // cardId(bookingItemPartId) -> month number 1-12 (from Ticket Holder Details form)
    formNames:    {},   // cardId(bookingItemPartId) -> first name (from Ticket Holder Details form) when the ticket's own name is blank
    formsSeen:    {},   // rollerFormResponseId -> true (so we fetch each form's answers only once)
    searchTypes:  {}    // receiptNumber -> {membership:bool, product:str}  (from keyword-search, to tag search rows)
  };

  /* ======================================================================
     NETWORK HOOKS  (installed at document-start, before ROLLER runs)
     ====================================================================== */
  var AUTH_RE = /^(authorization|x-[a-z-]+|requestverificationtoken|traceparent|baggage)$/i;

  function stashAuth(url, headers) {
    try {
      var m = String(url).match(/^https?:\/\/[^/]+/); if (!m) return;
      var origin = m[0], picked = {};
      Object.keys(headers || {}).forEach(function (k) { if (AUTH_RE.test(k)) picked[k] = headers[k]; });
      if (Object.keys(picked).length) state.authByOrigin[origin] = picked;
    } catch (e) {}
  }

  function onResponse(url, text) {
    try {
      url = String(url);
      if (/\/api\/bookings\/\d+(\?|$)/.test(url)) {
        var j = JSON.parse(text); if (j && j.bipDetail) { state.booking = j; processBooking(); }
      } else if (url.indexOf('get-membership') > -1) {
        var g = JSON.parse(text); if (g && g.bookingItemPartId !== undefined) resolveFromMemberPart(g.bookingItemPartId, g.imageFileName || null);
      } else if (url.indexOf('keyword-search') > -1) {
        indexSearchResults(JSON.parse(text));
      } else if (url.indexOf('/api/bookings/today') > -1) {
        indexTodayBookings(JSON.parse(text));
      }
    } catch (e) {}
  }
  // Today's bookings are served from an in-memory cache loaded from GET /api/bookings/today at app boot (and
  // topped up by ?modifiedDate= deltas). Searches that match TODAY's guests filter that cache client-side with NO
  // keyword-search call, so we must index this response too to badge those rows. We hook at document-start, so we
  // catch the boot load. Field names differ from keyword-search, so we probe defensively (and stash a debug sample).
  function indexTodayBookings(j) {
    if (!j) return;
    var arr = Array.isArray(j) ? j : (j.bookings || j.data || j.items || j.results || []);
    if (!arr || !arr.length) return;
    arr.forEach(function (o) {
      if (!o) return;
      var receipt = o.receiptNumber != null ? o.receiptNumber
                  : o.bookingReceiptNumber != null ? o.bookingReceiptNumber
                  : o.receipt != null ? o.receipt : null;
      if (receipt == null) return;
      var product = o.productName || o.productSummary || o.products || o.productDescription || '';
      if (!product && Array.isArray(o.bipDetail)) product = o.bipDetail.map(function (b) { return b.name || b.productName || ''; }).join(', ');
      state.searchTypes[receipt] = { type: classifyResult(o, product), product: String(product || '') };
    });
    setTimeout(tagSearchRows, 0);  // rows may already be on screen (or render right after) -> tag them now
  }
  // The booking search (POST /api/bookings/keyword-search) returns a productName per result even though ROLLER
  // doesn't show it in the list. We index receiptNumber (the # shown on each row) -> membership? so tagSearchRows()
  // can badge each row as a MEMBERSHIP purchase vs an attendance TICKET without opening it.
  function indexSearchResults(j) {
    if (!j) return;
    var arr = Array.isArray(j) ? j : Object.keys(j).map(function (k) { return j[k]; });
    arr.forEach(function (o) {
      if (!o || o.receiptNumber == null) return;
      state.searchTypes[o.receiptNumber] = { type: classifyResult(o, o.productName), product: o.productName || '' };
    });
    setTimeout(tagSearchRows, 0);  // rows may already be rendered when the response lands -> re-tag now
  }
  // A search result has a GUEST attached when any booking-holder identity field is populated. Walk-up café /
  // retail sales come through with all of these blank (confirmed on live data), so "no guest" cleanly marks them.
  function hasGuest(o) {
    return !!(o && (o.customerId || String(o.bookingName || '').trim() || String(o.contactName || '').trim() || String(o.email || '').trim() || String(o.phoneNumber || '').trim()));
  }
  // Does the product text look like an admission (an entry / visit product for a person)?
  function isAdmission(p) {
    return /adult|child|infant|senior|concession|\b\d{1,2}\s*\+|\byears?\b|\byrs?\b|book for|\bentry\b|\bsession\b|\bcasual\b|\bplay\b/i.test(String(p || ''));
  }
  // Classify a search result into a badge type. Order matters:
  //   1. membership  -> M/SHIP    (priority, with or without a guest)
  //   2. gift card   -> GIFT CARD (priority, with or without a guest)
  //   3. no guest    -> OTHER     (walk-up café / retail — no person attached)
  //   4. guest + admission product -> TICKETS
  //   5. guest but not an admission (e.g. café charged to an account) -> OTHER
  // Validity window in days (bookingEndDate - bookingDate). An admission is single-day (~0); a membership /
  // annual pass runs long (~365); a gift card longer still.
  function spanDays(o) {
    try { var a = new Date(o.bookingDate), b = new Date(o.bookingEndDate); if (isNaN(a) || isNaN(b)) return 0; return Math.round((b - a) / 86400000); } catch (e) { return 0; }
  }
  function classifyResult(o, product) {
    var p = String(product || (o && o.productName) || '');
    if (/wonder club|gold pass|\bmembership\b|unlocks/i.test(p)) return 'membership';
    if (/gift\s*card/i.test(p)) return 'giftcard';
    if (!hasGuest(o)) return 'other';
    // Some memberships/annual passes are named exactly like admissions ("Adult (18+ years), Child (0-18 years)")
    // with NO membership keyword. An admission is single-day; a membership runs long — so a long validity span
    // means membership even without a keyword. Exclude multi-visit packages ("Book for 6") which can also run long.
    if (!/book for|group booking/i.test(p) && spanDays(o) >= 60) return 'membership';
    if (isAdmission(p)) return 'tickets';
    return 'other';
  }

  var X = XMLHttpRequest.prototype;
  var oOpen = X.open, oSet = X.setRequestHeader, oSend = X.send;
  X.open = function (m, u) { this.__rczUrl = u; this.__rczHdr = {}; return oOpen.apply(this, arguments); };
  X.setRequestHeader = function (k, v) { try { (this.__rczHdr = this.__rczHdr || {})[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
  X.send = function () {
    var xhr = this, u = String(xhr.__rczUrl || '');
    if (u.indexOf('/api/') > -1) stashAuth(u, xhr.__rczHdr);
    if (/\/api\/bookings\/\d+(\?|$)/.test(u) || u.indexOf('get-membership') > -1 || u.indexOf('keyword-search') > -1 || u.indexOf('/api/bookings/today') > -1) {
      xhr.addEventListener('load', function () { onResponse(u, xhr.responseText); });
    }
    return oSend.apply(this, arguments);
  };

  var oFetch = window.fetch;
  window.fetch = function () {
    var args = arguments, url = (args[0] && args[0].url) || args[0], init = args[1] || {};
    try {
      var hdrs = {};
      if (init.headers) { if (typeof init.headers.forEach === 'function') init.headers.forEach(function (v, k) { hdrs[k] = v; }); else Object.assign(hdrs, init.headers); }
      if (String(url).indexOf('/api/') > -1) stashAuth(url, hdrs);
    } catch (e) {}
    return oFetch.apply(this, args).then(function (res) {
      try { var u = (res && res.url) || url; if (/\/api\/bookings\/\d+(\?|$)/.test(String(u)) || String(u).indexOf('get-membership') > -1 || String(u).indexOf('keyword-search') > -1 || String(u).indexOf('/api/bookings/today') > -1) res.clone().text().then(function (t) { onResponse(u, t); }).catch(function () {}); } catch (e) {}
      return res;
    });
  };

  /* ======================================================================
     CORE LOGIC
     ====================================================================== */
  function firstName(s) { return String(s || '').trim().toLowerCase().split(/\s+/)[0]; }
  // A foster-care partner discount (free entry via a partnership code, NOT a membership). Matched by the
  // discount code or its name so new partner codes can be added to CFG.FOSTER_MATCH without touching logic.
  function isFosterDisc(d) {
    if (!d) return false;
    var hay = ((d.code || '') + ' ' + (d.name || '')).toLowerCase();
    return CFG.FOSTER_MATCH.some(function (p) { return hay.indexOf(p) > -1; });
  }
  function normName(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function proper(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // "close" = one name is the leading stub of the other: a nickname that is a prefix of the full
  // name (Jax/Jaxson, Sam/Samuel, Ben/Benjamin, Alex/Alexander). Deliberately NARROW: we do NOT use
  // fuzzy edit-distance, because on short names it treats different people as similar (Tom/Tim,
  // Dan/Don) and would soften a real name-mismatch into a mere "please confirm" note. Anything that
  // isn't a clean prefix falls through to the loud red mismatch alert instead — safer to over-warn.
  function closeName(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a || !b || a === b) return false;
    var s = a.length < b.length ? a : b, l = a.length < b.length ? b : a;
    return s.length >= 3 && l.indexOf(s) === 0;
  }
  // Levenshtein edit distance — used sparingly (see sameName) to catch single-letter misspellings.
  function editDistance(a, b) {
    var m = a.length, n = b.length, i, j, prev = [], cur = [];
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }
  // Same person, allowing common alternative spellings / nicknames — so a MIS-SPELLING is never flagged as
  // fraud. TRUE when: identical; OR the shorter is the leading stub of the longer (Jo/Joh, Flyn/Flynn,
  // Flyn/Flynny, Aliya/Aliyah — min 2 chars); OR a single-letter difference on a name long enough (>=4) that a
  // one-char change reads as a typo, not a different short name (Alyah/Aliyah, Catherine/Katherine — but NOT
  // Tom/Tim, Dan/Don, which stay genuinely different). Case-insensitive.
  function sameName(a, b) {
    a = normName(a); b = normName(b);
    if (!a || !b) return false;
    if (a === b) return true;
    var s = a.length <= b.length ? a : b, l = a.length <= b.length ? b : a;
    if (s.length >= 2 && l.indexOf(s) === 0) return true;               // one name is a clean prefix of the other (Sam/Samuel, Jo/John)
    if (s.length >= 4 && editDistance(a, b) <= 1) return true;          // single-letter typo (Flyn/Flynn, Aliya/Aliyah)
    // Nickname / abbreviation tolerance: two names that share their first 3 letters are treated as the SAME
    // person — this catches nicknames that alter a letter off the stem (Bree/Breanna, Kate/Katrina, Nat/Natalie)
    // which the prefix + typo rules miss. DELIBERATELY BROAD: it can't tell a real nickname from a coincidental
    // shared syllable, so it also matches genuinely-different same-stem names (Bree/Brendan, Mark/Margaret,
    // Nathan/Natalie, Michael/Michelle). That's an accepted trade — fewer false mismatch flags on legit
    // nicknames, at the cost of missing mismatches that share a first syllable. Only fires when the shorter
    // name is >=3 chars, so 2-letter names still rely on the exact-prefix rule above.
    if (s.length >= 3 && a.slice(0, 3) === b.slice(0, 3)) return true;
    return false;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthName(m) { return (m >= 1 && m <= 12) ? MONTHS[m - 1] : ''; }
  // birthday month falls in the last / current / next calendar month
  function birthdayInWindow(m) {
    if (!(m >= 1 && m <= 12)) return false;
    var cur = new Date().getMonth() + 1, next = cur === 12 ? 1 : cur + 1, prev = cur === 1 ? 12 : cur - 1;
    return m === cur || m === next || m === prev;
  }
  function nameMeaning(name) { var k = firstName(name); return (k && NAME_MEANINGS[k]) || null; }

  function processBooking() {
    try {
      var j = state.booking; if (!j) return;
      var bip = Array.isArray(j.bipDetail) ? j.bipDetail : [];
      var discs = (j.discounts || []).map(function (d) {
        var r = d.memberReceiptNumber, b = d.memberBookingItemPartId;
        // Visiting / reciprocal membership redeemed at the DESK (vs online): ROLLER records the member
        // reference only in the discount CODE ("<receiptNumber>-<bookingItemPartId>") and leaves memberName,
        // memberReceiptNumber and memberBookingItemPartId all null. Recover r/b from that code so the ticket is
        // treated as a (visiting) membership and can resolve the member via /get-membership — instead of being
        // dropped as a manual/ad-hoc discount (b/r/name all null) and shown as a plain casual guest. A genuine
        // manual discount has no "<n>-<n>" code, so this never re-catches the manual-discount case. (Online
        // bookings populate memberName/r/b directly, which is why they link the profile and these didn't.)
        if (r == null && b == null) {
          var cm = String(d.code || '').match(/^(\d+)-(\d+)$/);
          if (cm) { r = Number(cm[1]); b = Number(cm[2]); }
        }
        return { raw: d.memberName, name: firstName(d.memberName), amount: d.amount, pct: d.percentageOff, r: r, b: b, used: false, foster: isFosterDisc(d) };
      });
      // Foster-care partnership (e.g. MacKillop Family Services): a plain discount CODE that zeroes entry so
      // partner guests come in free. It is NOT a membership (no memberName / member slot). When the booking
      // carries such a discount and nothing that looks like a paid membership check-in (a discount with a
      // real member slot id), every discounted ticket is a partner guest, not a member.
      var bookingFoster = discs.some(function (d) { return d.foster; }) && !discs.some(function (d) { return !d.foster && d.b != null; });
      // Family membership signal: the same membership (memberReceiptNumber) appears across 2+ discount
      // slots in this one booking. Individual children's slots usually carry the account-holder's name
      // (or blank), so we must NOT treat them as name-mismatches — instead show the photo best-effort
      // and prompt staff to add the individual's name.
      var rCount = {};
      discs.forEach(function (d) { if (d.r != null) rCount[d.r] = (rCount[d.r] || 0) + 1; });
      discs.forEach(function (d) { d.family = (d.r != null && rCount[d.r] >= 2); });
      // Within a family membership, is this slot individually identifiable? A slot whose member name
      // is blank, or is shared across 2+ slots of the same membership (the account-holder name
      // defaulted onto un-named children, e.g. three slots all reading "Emma Turner"), is "un-named":
      // a non-matching ticket there simply needs the individual's name added. But a slot with a UNIQUE
      // individual name (e.g. "Michelle Vicenzino") that the ticket does NOT match is a different
      // person using the pass (e.g. Chris on Michelle's slot) -> that's a real NAME MISMATCH, not a
      // missing name. This is what tells the two cases apart.
      var nameCountByR = {};
      discs.forEach(function (d) {
        if (d.r == null) return;
        (nameCountByR[d.r] = nameCountByR[d.r] || {});
        nameCountByR[d.r][d.name || ''] = (nameCountByR[d.r][d.name || ''] || 0) + 1;
      });
      discs.forEach(function (d) {
        d.unnamed = !d.name || (d.r != null && nameCountByR[d.r][d.name] >= 2);
      });
      // A discount that references no membership at all — no member slot id (b), no receipt (r) and no member
      // name — is a MANUAL / ad-hoc discount (e.g. a $16 goodwill discount at the desk). It must NOT be matched
      // to a ticket and turn a plain guest into a member/visiting, so mark it used up-front to keep it out of
      // the name/amount matching below. Real memberships — including visiting members (they fetch their photo
      // via b/r) — always carry a slot id and/or a receipt, so this only removes genuinely non-membership discounts.
      discs.forEach(function (d) { if (d.b == null && d.r == null && !d.name) d.used = true; });
      var next = {}, toFetch = [];
      state.discountIndex = {};
      // A ticket is a MEMBER check-in when it carries a membership discount (bookingItemDiscount != 0).
      var memberTickets = bip.filter(function (p) { return p.bookingItemDiscount; });
      var assign = {}; // cardId -> discount
      // Pass 1: match the ticket-holder's name to a membership name. Only match on an IDENTIFYING name:
      // skip discounts flagged unnamed (blank, or the account-holder name defaulted across 2+ family
      // slots). Otherwise a family whose tickets all carry the holder name "Amanda Hawker" would pair
      // ticket[i] -> discs[i] by ROLLER's arbitrary array order, sending e.g. the Adult ticket to a
      // Child slot. Letting those fall through to Pass 2 pairs them by the per-slot discount amount
      // (Adult $12 vs Child $16), which lands each ticket on its correct-type membership slot.
      memberTickets.forEach(function (p) {
        var d = discs.find(function (x) { return !x.used && x.name && !x.unnamed && x.name === firstName(p.name); });
        if (d) { d.used = true; assign[p.bookingItemPartId] = d; }
      });
      // Pass 2a: exact dollar-amount match, for ALL tickets, BEFORE any fallback. Doing every exact match
      // first is what keeps a family correct: e.g. the Adult ticket's unique $12 must claim the Adult slot
      // before a Child ticket (whose own discount amount doesn't line up with any slot) grabs it via the
      // fallback below. (Previously the fallback ran per-ticket, so a mis-lining Child processed first stole
      // the Adult's slot and the Adult spilled onto a Child slot.)
      memberTickets.forEach(function (p) {
        if (assign[p.bookingItemPartId]) return;
        var d = discs.find(function (x) { return !x.used && x.amount != null && Number(x.amount) === Number(p.bookingItemDiscount); });
        if (d) { d.used = true; assign[p.bookingItemPartId] = d; }
      });
      // Pass 2b: leftovers (their amount matched no slot) take any remaining discount, in order.
      memberTickets.forEach(function (p) {
        if (assign[p.bookingItemPartId]) return;
        var d = discs.find(function (x) { return !x.used; });
        if (d) { d.used = true; assign[p.bookingItemPartId] = d; }
      });
      bip.forEach(function (p) {
        var cardId = p.bookingItemPartId;
        if (!p.bookingItemDiscount) { next[cardId] = { member: false, pending: false, photo: null }; return; } // casual
        if (bookingFoster) { next[cardId] = { member: false, fosterCare: true, pending: false, photo: null }; return; } // foster-care partner (free entry, not a member)
        var d = assign[cardId];
        if (!d) {
          // Member discount on this ticket, but every discount record was already mapped to another ticket
          // (e.g. Bronte's membership code discounted a second adult on the booking). Attribute it to the
          // membership whose amount matches — so we can NAME the real member (Bronte) rather than say
          // "another member" — and still flag it, because the discount is being used by someone else.
          var src = discs.find(function (x) { return x.name && x.amount != null && Number(x.amount) === Number(p.bookingItemDiscount); }) || discs.find(function (x) { return x.name; });
          if (!src) { next[cardId] = { member: false, pending: false, photo: null }; return; }  // only a manual/ad-hoc discount on this ticket (no membership to attribute) -> plain casual guest
          next[cardId] = { member: true, mismatch: true, unmapped: true, pending: false, photo: null,
            tier: src ? ((src.pct === 100) ? 'gold' : 'wonder') : null,
            memberName: src ? proper(firstName(src.raw)) : '', memberFull: src ? (src.raw || '') : '',
            ticketName: proper(firstName(p.name)) };
          if (src && src.r != null) toFetch.push({ cardId: cardId, r: src.r, b: src.b }); // pull the member's photo to show behind the mismatch
          return;
        }
        // The "member" field with no letters (null / blank / an ID number) = member visiting from another museum.
        var mn = d.raw == null ? '' : String(d.raw);
        var visiting = !/[a-zA-Z]/.test(mn);
        // percentageOff 100 = whole ticket comped (legacy Gold Pass); otherwise a partial discount (Wonder Club).
        var tier = (d.pct === 100) ? 'gold' : 'wonder';
        state.discountIndex[d.b] = { cardId: cardId };
        var fnM = firstName(mn), fnT = firstName(p.name);
        var same = sameName(fnM, fnT);   // exact OR a spelling/nickname variant -> the same person, no warning
        if (visiting) {
          // member visiting from another museum -> fetch photo (photo essential)
          next[cardId] = { member: true, pending: true, photo: null, visiting: true, tier: tier };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else if (d.family && d.unnamed) {
          // family slot with NO real individual identity (blank name, or the account-holder name defaulted
          // onto every slot so the slots are effectively un-named) -> prompt to add the individual's name.
          // Checked BEFORE exact, so a slot whose ticket happens to match that defaulted name (e.g. "Tori"
          // on a "Tori Allen" slot that is actually blank) STILL gets the "Add individual names" prompt.
          next[cardId] = { member: true, pending: true, photo: null, family: true, tier: tier };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else if (same) {
          // same person — exact match OR a spelling/nickname variant (Jo/Joh, Aliya/Aliyah, Flyn/Flynn) ->
          // just the photo, NO warning. Only a genuinely different name reaches the mismatch branch below.
          next[cardId] = { member: true, pending: true, photo: null, tier: tier };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else if (!fnT) {
          // ticket has NO holder name (e.g. a front-desk / walk-up sale where the attendee's name was never
          // captured on the ticket). With no name to compare we can't assert a mismatch — show the member's
          // photo best-effort as a clean member card. When the membership slot is genuinely, uniquely named
          // (NOT a family's shared/defaulted name), bring that member name through to the bottom of the tile
          // so staff see who it is — the ticket just didn't record it. (#8/#9)
          next[cardId] = { member: true, pending: true, photo: null, tier: tier };
          if (!d.unnamed && d.raw && /[a-zA-Z]/.test(d.raw)) next[cardId].displayName = String(d.raw).trim();
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else {
          // ticket name != membership name -> name-mismatch. Covers both a single membership AND a
          // family slot that IS individually named but this ticket isn't that person (someone using
          // another member's pass, e.g. Chris checking in on Michelle's slot).
          next[cardId] = { member: true, mismatch: true, pending: false, photo: null, tier: tier, memberName: proper(fnM), ticketName: proper(fnT) };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b }); // pull the member's photo to show behind the mismatch
        }
        // Full membership name (same source ROLLER prints on the blue discount link) — used to look up
        // that member's detail URL and turn the tier tag into a link. d is guaranteed set here.
        if (next[cardId]) next[cardId].memberFull = d.raw || '';
      });
      // Mis-assigned discount: an unmapped ticket (its membership discount couldn't be mapped because the
      // record was already used by its true owner) means that owner is ALSO on this booking but their own
      // ticket didn't carry the discount — i.e. the checkout applied it to the wrong guest. There is still
      // only one discount record per membership, so the booking TOTAL is correct. Flag the real member's
      // card with a reassurance banner and point it at the guest who received the discount. Classification
      // based (no dollar-field guessing), so it works regardless of how ROLLER stores the discount amount.
      // Gated OFF for now (CFG.FLAG_MISASSIGNED): a pure assignment error where the real member IS on the
      // booking is treated as a normal member — no reassurance note, no "assignment error only" status. Code
      // kept so we can switch it back on. (The rider still demotes to a plain casual below, flag or not.)
      if (CFG.FLAG_MISASSIGNED) {
        Object.keys(next).forEach(function (cid) {
          var e = next[cid];
          if (!(e && e.unmapped && e.memberFull)) return;
          var key = normName(e.memberFull), linked = false;
          Object.keys(next).forEach(function (cid2) {
            var m = next[cid2];
            if (m && m.member && !m.mismatch && m.memberFull && normName(m.memberFull) === key) {
              m.paidMember = true; m.recipPart = cid; linked = true;
            }
          });
          // only flag the mismatch tile when its paired "paid full price" member is actually on this booking
          if (linked) e.misaligned = true;
        });
      }
      // An "unmapped" ticket carries a mis-distributed discount AMOUNT but has no membership record of its own
      // (every real membership is already claimed by its true member) -> it's a CASUAL riding along, not a name
      // mismatch. The linking pass above has already flagged the true member's card, so demote the rider to a
      // plain casual now. Genuine fraud always keeps a real discount record, so it is never "unmapped".
      var _riders = {};
      Object.keys(next).forEach(function (cid) {
        if (next[cid] && next[cid].unmapped) { next[cid] = { member: false, pending: false, photo: null }; _riders[cid] = true; }
      });
      // don't fetch a membership photo for a demoted rider — the fetch would re-set member=true and paint the
      // member's photo on what should be a plain casual tile.
      toFetch = toFetch.filter(function (t) { return !_riders[t.cardId]; });
      state.byCard = next;
      render();
      toFetch.forEach(fetchMembership);
      fetchForms(j); // Ticket Holder Details form — supplies birthday month AND a fallback name for blank-named tickets
    } catch (e) {}
  }

  /* Birthday months live in the "Ticket Holder Details" form, fetched separately. Each answer group's
     uniqueGroupId is "bookingId-bookingItemPartId", so it maps straight onto our card ids. */
  function fetchForms(j) {
    try {
      var forms = (j && j.forms) || [], frm = null, i;
      for (i = 0; i < forms.length; i++) { if (forms[i] && forms[i].rollerFormResponseId && /ticket|holder/i.test(forms[i].formName || '')) { frm = forms[i]; break; } }
      if (!frm) for (i = 0; i < forms.length; i++) { if (forms[i] && forms[i].rollerFormResponseId) { frm = forms[i]; break; } }
      if (!frm) return;
      var id = frm.rollerFormResponseId;
      if (state.formsSeen[id]) return;
      var auth = state.authByOrigin['https://doorlist.roller.app'];
      if (!auth) return; // no borrowed auth yet -> try again on the next booking render
      state.formsSeen[id] = true;
      window.fetch(CFG.FORMS_URL + encodeURIComponent(id), { credentials: 'include', headers: auth })
        .then(function (res) { return res.ok ? res.json().catch(function () { return null; }) : null; })
        .then(function (f) { if (!f) { state.formsSeen[id] = false; return; } parseBirthdays(f); render(); })
        .catch(function () { state.formsSeen[id] = false; });
    } catch (e) {}
  }

  function parseBirthdays(f) {
    try {
      var def = f.formJson ? JSON.parse(f.formJson) : null;
      var resp = f.formResponseJson ? JSON.parse(f.formResponseJson) : null;
      if (!def || !resp) return;
      // Collect every field so we can find the DOB (month) and a first-name field, wherever they sit.
      var dobId = null, fields = [];
      (function walk(items) {
        (items || []).forEach(function (it) {
          if (!it) return;
          var db = String(it.dataBinding || '');
          if (db === 'Booking.TicketHolder.DOB') dobId = it.id;
          fields.push({ id: it.id, db: db, title: String(it.title || it.label || it.text || it.name || '') });
          if (it.items) walk(it.items);
        });
      })(def.items);
      // Pick the name field by priority: TicketHolder.FirstName -> any "first name" -> a general Name/FullName (first word)
      function pick(test) { for (var i = 0; i < fields.length; i++) { if (fields[i].id != null && test(fields[i])) return fields[i]; } return null; }
      var nf = pick(function (c) { return /TicketHolder\.FirstName$/i.test(c.db); })
            || pick(function (c) { return /first\s*name/i.test(c.db) || /first\s*name/i.test(c.title); })
            || pick(function (c) { return /TicketHolder\.(Full)?Name$/i.test(c.db) || /^full\s*name$|^name$/i.test(c.title); });
      var nameId = nf ? nf.id : null;
      var nameFirstWord = nf ? !/first/i.test(nf.db + ' ' + nf.title) : false; // full-name field -> keep only the first word
      // Pull each answer group into {part, name, month}, in form order.
      var entries = [];
      (resp.items || []).forEach(function (g) {
        var part = String(g.uniqueGroupId || '').split('-')[1] || '';
        var month = null, nm = '';
        (g.items || []).forEach(function (si) {
          if (!si || !si.answer || !si.answer.length) return;
          if (dobId != null && si.id === dobId) { var m = Number(si.answer[0]); if (m >= 1 && m <= 12) month = m; }
          if (nameId != null && si.id === nameId) { var v = String(si.answer[0] || '').trim(); if (v) nm = nameFirstWord ? v.split(/\s+/)[0] : v; }
        });
        if (nm || month) entries.push({ part: part, name: nm, month: month, mapped: false });
      });
      var bip = (state.booking && Array.isArray(state.booking.bipDetail)) ? state.booking.bipDetail : [];
      var currentPart = {}; bip.forEach(function (p) { currentPart[String(p.bookingItemPartId)] = true; });
      // 1) direct match: the answer's ticket id is a ticket that still exists on the booking.
      entries.forEach(function (e) {
        if (e.part && currentPart[e.part]) {
          if (e.month) state.birthdays[e.part] = e.month;
          if (e.name) state.formNames[e.part] = proper(e.name);
          e.mapped = true;
        }
      });
      // 2) positional fallback: answers whose ticket was replaced (e.g. re-added at the door -> new id) can't
      //    match by id. Pair the leftover answers to the still-blank tickets in booking order, best-effort.
      var orphans = entries.filter(function (e) { return !e.mapped; });
      // Guardrail: never let a form name that already belongs to a NAMED ticket get re-placed onto a blank
      // one. e.g. a 3-ticket booking (adult Florence + 2 kids) whose form lists "Florence" and one child:
      // Florence is already on her adult ticket, so her form entry must NOT be blindly paired to a blank
      // CHILD slot. Drop any orphan whose first name already appears as a holder on the booking (ticket-level
      // name, or a name we just assigned this pass), keeping month-only orphans intact.
      var fw = function (s) { return String(s || '').trim().split(/\s+/)[0].toLowerCase(); };
      var knownNames = {};
      bip.forEach(function (p) { var n = fw(p.name); if (n) knownNames[n] = true; });
      Object.keys(state.formNames).forEach(function (k) { var n = fw(state.formNames[k]); if (n) knownNames[n] = true; });
      orphans = orphans.filter(function (e) { var n = fw(e.name); return !n || !knownNames[n]; });
      var blanks = bip.filter(function (p) {
        var tp = String(p.bookingItemPartId);
        return !String(p.name || '').trim() && !state.formNames[tp];
      });
      for (var oi = 0; oi < orphans.length && oi < blanks.length; oi++) {
        var oe = orphans[oi], btp = String(blanks[oi].bookingItemPartId);
        if (oe.name && !state.formNames[btp]) state.formNames[btp] = proper(oe.name);
        if (oe.month && !state.birthdays[btp]) state.birthdays[btp] = oe.month;
      }
    } catch (e) {}
  }

  function fetchMembership(t) {
    var auth = state.authByOrigin['https://doorlist.roller.app'];
    if (!auth) return; // no borrowed auth yet -> stays pending; Verify-click fallback still works
    var headers = Object.assign({ 'Content-Type': 'application/json' }, auth);
    window.fetch(CFG.GET_MEMBERSHIP, {
      method: 'POST', credentials: 'include', headers: headers,
      body: JSON.stringify({ receiptNumber: t.r, bookingItemPartId: t.b })
    }).then(function (res) { return res.ok ? res.json().catch(function () { return null; }) : undefined; })
      .then(function (gm) {
        if (gm === undefined) return; // request failed -> stay pending (Verify-click fallback can still resolve)
        var e = state.byCard[t.cardId] || {};
        e.member = true; e.pending = false; e.photo = (gm && gm.imageFileName) || null; // null gm (e.g. visiting member) = no photo
        state.byCard[t.cardId] = e;
        render();
      }).catch(function () {});
  }

  function resolveFromMemberPart(memberPartId, imageFileName) {
    var idx = state.discountIndex[memberPartId];
    if (!idx) return;
    var e = state.byCard[idx.cardId] || {};
    e.member = true; e.pending = false; e.photo = imageFileName || null; // preserve the visiting flag
    state.byCard[idx.cardId] = e;
    render();
  }

  /* ======================================================================
     RENDER
     ====================================================================== */
  // The card layout is ONLY for the booking check-in list (/search/bookings/<id>, single ID).
  // Everywhere else — ticket-detail (/bookings/<id>/<partId>), the Memberships area, any other
  // screen — we stay out, or we blow up single cards, block scrolling, or bleed onto unrelated
  // pages (e.g. an alert painted over a membership photo). So we activate on the list route only.
  function activeRoute() { return /^\/search\/bookings\/\d+\/?$/.test(location.pathname); }
  // The member detail page (/search/memberships/<acct>/<memberId>) — where "Add name" lands staff on the
  // Guest tab. Hard to get back from, so we add our own Back buttons here (#4).
  function membershipDetailRoute() { return /^\/search\/memberships\/\d+\/\d+/.test(location.pathname); }
  // A Back button that does exactly what the browser Back does (history.back()) — a big back-arrow over a
  // "Back" label, matching the two mockup spots on the member detail page.
  function makeBackBtn() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'rcz-backbtn';
    b.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#2f3540" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span class="rcz-backbtn__lbl">Back</span>';
    b.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:#fff;border:1px solid #d6d9de;border-radius:12px;padding:8px 16px;cursor:pointer;color:#2f3540;font:700 13px/1 Roboto,Arial,sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.14);z-index:60;';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); history.back(); });
    return b;
  }
  function ensureBackButtons() {
    var detail = document.querySelector('app-booking-detail'); if (!detail) return;
    if (getComputedStyle(detail).position === 'static') detail.style.position = 'relative';
    if (!detail.querySelector('.rcz-backbtn--top')) {
      var t = makeBackBtn(); t.classList.add('rcz-backbtn--top');
      t.style.position = 'absolute'; t.style.top = '12px'; t.style.left = '12px';
      detail.insertBefore(t, detail.firstChild);
    }
    if (!detail.querySelector('.rcz-backbtn--bottom')) {
      var b = makeBackBtn(); b.classList.add('rcz-backbtn--bottom');
      b.style.display = 'flex'; b.style.margin = '18px auto 24px';
      detail.appendChild(b);
    }
  }
  function removeBackButtons() { document.querySelectorAll('.rcz-backbtn').forEach(function (e) { e.remove(); }); }

  // A name lookup can return memberships / gift cards / tabs mixed in with tickets. Our whole card
  // treatment assumes a TICKET; a membership record must be left exactly as ROLLER draws it. A
  // membership card carries a status pill ("Current"/"Expired"/…) AND/OR its type text says
  // "Membership" ($14 Adult Membership, Venue: Annual Membership) — a ticket has neither.
  function isMembershipCard(host) {
    try {
      var pills = host.querySelectorAll('.ui-pill');
      for (var i = 0; i < pills.length; i++) {
        if (/\b(current|expired|cancell?ed|suspended|pending|lapsed)\b/i.test(pills[i].textContent || '')) return true;
      }
      var txt = '';
      var emph = host.querySelector('.summary-detail__item--emphasis'); if (emph) txt += ' ' + emph.textContent;
      var prod = host.querySelector('.summary-detail__item:not(.summary-detail__item--emphasis)'); if (prod) txt += ' ' + prod.textContent;
      return /membership/i.test(txt);
    } catch (e) { return false; }
  }
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function parseCardDate(s) {
    var m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/); if (!m) return null;
    var mo = MON3.indexOf(m[2].slice(0, 3).replace(/^./, function (c) { return c.toUpperCase(); }));
    if (mo < 0) return null;
    return new Date(Number(m[3]), mo, Number(m[1]));
  }
  function fmtCardDate(d) { return d.getDate() + ' ' + MON3[d.getMonth()] + ' ' + d.getFullYear(); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  // Gold vs Wonder for a membership: Wonder Club products say "unlocks $X entry"; everything else is Gold.
  function membershipTier(host) {
    var e = host.querySelector('.summary-detail__item--emphasis');
    var emph = e ? (e.getAttribute('data-rcz-full') || e.textContent) : '';  // full text (pre-shorten)
    var prod = (host.querySelector('.summary-detail__item:not(.summary-detail__item--emphasis)') || {}).textContent || '';
    return /unlocks/i.test(emph + ' ' + prod) ? 'wonder' : 'gold';
  }
  // Everything we need is already on the card — scrape it (per the mock's "use what's on screen").
  function membershipInfo(host) {
    var date = '', uses = '';
    host.querySelectorAll('*').forEach(function (el) {
      if (el.children.length) return;
      var t = (el.textContent || '').trim();
      if (!date && /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(t)) date = t;
      if (!uses && /\d\s*uses?\b/i.test(t)) uses = t;
    });
    var nmRaw = (host.querySelector('.summary-detail__item-holder-wrapper') || {}).textContent || '';
    var name = nmRaw.split(/person|current|expired|cancell?ed|suspended/i)[0].trim();
    var emph = (host.querySelector('.summary-detail__item--emphasis') || {}).textContent || '';
    var tm = emph.match(/\b(adult|child|infant|concession|senior|family|teen|student|junior)\b/i);
    return { date: date, uses: uses, name: name, first: name.split(/\s+/)[0], type: tm ? tm[1] : '' };
  }
  // Tag every non-ticket card with .rcz-skip so all our CSS (app-bip-summary:not(.rcz-skip) ...) and
  // the render loop leave it untouched. Runs before shorten()/render so nothing is applied to them.
  function markSkips() {
    document.querySelectorAll('app-bip-summary').forEach(function (host) {
      var mem = isMembershipCard(host);
      host.classList.toggle('rcz-mem', mem && CFG.SHOW_MEMBERSHIP);  // format it
      if (mem && !CFG.SHOW_MEMBERSHIP) {                              // or leave it as ROLLER draws it
        if (!host.classList.contains('rcz-skip')) {
          host.classList.add('rcz-skip');
          host.querySelectorAll('.rcz-alert,.rcz-casual,.rcz-mismatch,.rcz-visiting,.rcz-badge,.rcz-note,.rcz-bday,.rcz-meaning,.rcz-status,.rcz-actreq,.rcz-nameact,.rcz-botbar,.rcz-memstrip,.rcz-mem-info,.rcz-mem-name,.rcz-mmnames,.rcz-mmveil,img.rcz-photo').forEach(function (e) { e.remove(); });
          host.querySelectorAll('.rcz-alert-on,.rcz-casual-on,.rcz-mismatch-on,.rcz-visiting-on,.rcz-mmnames-on').forEach(function (w) { w.classList.remove('rcz-alert-on', 'rcz-casual-on', 'rcz-mismatch-on', 'rcz-visiting-on', 'rcz-mmnames-on'); });
        }
      } else {
        host.classList.remove('rcz-skip');
      }
    });
  }
  // The shield label ("I.D." over a small "& Checkin") needs two font sizes, so it can't be a CSS
  // pseudo-element — inject a real element into each check-in button; CSS shows it only when the
  // button is in the not-checked-in (theme--secondary) state.
  function ensureShields() {
    if (!CFG.SHOW_SHIELD) return;
    document.querySelectorAll('app-bip-summary:not(.rcz-skip) button[id^="check-in-button"]').forEach(function (btn) {
      if (btn.querySelector('.rcz-shieldtxt')) return;
      var el = document.createElement('span'); el.className = 'rcz-shieldtxt';
      // "Needs check-in" state: a FAINT grey shield outline (no fill) with a faint grey tick inside, both in
      // ROLLER's own icon grey at the same low opacity — matching ROLLER's stock un-checked UX, not our old
      // gold shield / "Confirm I.D." label. Shield path matches the green success shield so they line up;
      // the green (checked-in) shield is untouched, so a checked-in guest still stands out.
      el.innerHTML = '<span class="rcz-shieldtxt__tick"><svg viewBox="0 0 48 48" fill="none" stroke="#72727a" stroke-opacity="0.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 2 L44 9 L44 24 C44 36 35 43 24 47 C13 43 4 36 4 24 L4 9 Z" stroke-width="1.8"/><path d="M15.5 24.5 l5.5 5.5 L34 16.5" stroke-width="3"/></svg></span>';
      btn.appendChild(el);
    });
  }

  function ensureBotBar(w) {
    if (!w.querySelector('.rcz-botbar')) { var b = document.createElement('div'); b.className = 'rcz-botbar'; w.appendChild(b); }
  }
  function injectStyle() {
    if (!activeRoute()) return;
    if (document.getElementById('rcz-style') || !document.head) return;
    var s = document.createElement('style'); s.id = 'rcz-style';
    s.textContent = [
      /* skipped (membership/non-ticket) cards: un-clip ROLLER's fixed-height holder so the narrower
         grid cell doesn't cut off the "CURRENT" status pill. */
      'app-bip-summary.rcz-skip .summary-detail__item-holder-wrapper{overflow:visible !important;height:auto !important;}',
      /* grid — tight gutters, use full width. Lift ROLLER's 786px max-width cap on the
         container and cut its side padding so the space goes into bigger photos. */
      '.panel__main-inner:has(app-card app-bip-summary){max-width:none !important;padding-left:12px !important;padding-right:12px !important;}',
      'app-card .card.size--medium{max-width:none !important;padding-left:8px !important;padding-right:8px !important;}',
      'app-card .card__section:has(app-bip-summary){display:grid !important;grid-template-columns:repeat(auto-fill,minmax(' + CFG.MIN_COLUMN_PX + 'px,1fr)) !important;gap:' + CFG.GAP_PX + 'px !important;padding:6px !important;align-items:start !important;}',
      'app-card .card__section hr.card-divider--summary{display:none !important;}',
      'app-bip-summary:not(.rcz-skip){display:block !important;width:100% !important;}',

      /* card = frame for the photo */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper{position:relative !important;display:block !important;width:100% !important;aspect-ratio:1/1 !important;height:auto !important;box-sizing:border-box !important;margin:0 !important;padding:0 !important;border:none !important;border-radius:' + CFG.CARD_RADIUS_PX + 'px !important;overflow:hidden !important;box-shadow:0 1px 3px rgba(0,0,0,.18) !important;background:#eceef0 !important;}',

      /* avatar/photo fills the whole card */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper app-icon-button.align-top:has(button[id^="booking-details-button"]){position:absolute !important;inset:0 !important;top:0 !important;left:0 !important;transform:none !important;width:100% !important;height:100% !important;margin:0 !important;z-index:1 !important;}',
      'app-bip-summary:not(.rcz-skip) button[id^="booking-details-button"]{width:100% !important;height:100% !important;min-width:0 !important;border-radius:0 !important;border:none !important;background:#eceef0 !important;overflow:hidden !important;}',
      'app-bip-summary:not(.rcz-skip) button[id^="booking-details-button"] img.rcz-photo{width:100% !important;height:100% !important;object-fit:cover !important;border-radius:0 !important;display:block !important;}',
      'app-bip-summary:not(.rcz-skip) button[id^="booking-details-button"] mat-icon{font-size:' + CFG.PLACEHOLDER_ICON_PX + 'px !important;width:' + CFG.PLACEHOLDER_ICON_PX + 'px !important;height:' + CFG.PLACEHOLDER_ICON_PX + 'px !important;line-height:' + CFG.PLACEHOLDER_ICON_PX + 'px !important;color:#9aa2ac !important;}',

      /* overlays ON TOP of the photo */
      /* select checkbox hidden in the new design */
      /* stock select checkbox, TOP-LEFT of every card. Material wraps the visible 18px box in a 40px target
         (box centred, +11px), which threw the alignment off — so shrink the wrapper/target to the box itself. */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox{position:absolute !important;top:12px !important;left:11px !important;width:18px !important;height:18px !important;z-index:7 !important;margin:0 !important;pointer-events:auto !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox .mdc-checkbox{width:18px !important;height:18px !important;padding:0 !important;flex:0 0 18px !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox .mat-mdc-checkbox-touch-target{width:18px !important;height:18px !important;top:0 !important;left:0 !important;transform:none !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox .mdc-checkbox__background{top:0 !important;left:0 !important;border-radius:50% !important;overflow:hidden !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox .mdc-checkbox__native-control{width:18px !important;height:18px !important;top:0 !important;left:0 !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper .summary-detail{position:absolute !important;right:76px !important;left:auto !important;bottom:12px !important;flex:none !important;width:auto !important;max-width:44% !important;background:none !important;border:none !important;border-radius:0 !important;padding:0 !important;box-shadow:none !important;z-index:6 !important;text-align:right !important;}',
      'app-bip-summary:not(.rcz-skip) .summary-detail p.summary-detail__item:not(.summary-detail__item--emphasis){display:none !important;}',
      /* category ("Adult"/"Child"/"Infant") smaller; name ("Erin") larger, bold. Type text is BLACK. */
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__item--emphasis{font-size:18px !important;font-weight:600 !important;color:#111827 !important;margin:0 !important;line-height:1.32 !important;}',
      // On party-guest tiles, drop ROLLER's product line ("Number of Children") — the tile already reads "Party Guest".
      'app-bip-summary.rcz-partyguest .summary-detail__item--emphasis{display:none !important;}',
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__item-holder-wrapper{display:block !important;font-size:18px !important;font-weight:800 !important;color:#1f2933 !important;margin-top:0 !important;line-height:1.32 !important;}',
      /* kill the empty modifiers row\'s 4px margin so the type + name lines sit flush (align with the tier) */
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__modifiers{margin:0 !important;}',
      /* compress the "Select all / Hide checked in" header — trim the top gap and pull the */
      /* bottom in to ~32px (tight, but enough that ROLLER\'s verify banner clears the row) */
      '.panel__header:has(.bip-list-header){padding-top:6px !important;padding-bottom:32px !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper .summary-detail-time{display:none !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper app-icon-button.align-top:has(button[id^="check-in-button"]){position:absolute !important;right:18px !important;bottom:12px !important;margin:0 !important;z-index:6 !important;}',
      // Membership tiles under "MEMBERSHIP PROFILES ONLY" (tagged .rcz-nocheckin by tagProfileOnlyCards) —
      // hide the check-in tick entirely so a profile can't be checked in there. Dated-section tiles keep it.
      'app-bip-summary.rcz-nocheckin app-icon-button:has(button[id^="check-in-button"]){display:none !important;}',
      'app-bip-summary.rcz-nocheckin button[id^="check-in-button"]{display:none !important;}',
      // When a membership profile is selected, hide ROLLER's blue bulk "check (N)" button (the filled/unelevated
      // one in the header actions) so profiles can't be bulk-checked-in. The "..." more-actions icon-button stays.
      'body.rcz-hidecheckinbtn .bip-list-header__actions app-generic-button:has(button.mat-mdc-unelevated-button){display:none !important;}',
      'body.rcz-hidecheckinbtn .bip-list-header__actions button.mat-mdc-unelevated-button{display:none !important;}',
      // Grey section-header pills at ~2x (12px->24px text, 2px 8px->4px 16px padding). Tagged .rcz-sectionpill
      // in retextSectionPills (neutral pills not inside a card). In-card "Current" status pills are untouched.
      '.rcz-sectionpill.ui-pill{padding:4px 16px !important;border-radius:999px !important;}',
      '.rcz-sectionpill .ui-pill__text{font-size:24px !important;line-height:1.15 !important;}',
      // Smaller second line under "Membership profiles below" — sentence case (no uppercase), lighter, its own line.
      '.rcz-sectionpill .rcz-pill-sub{display:block;font-size:14px !important;font-weight:400 !important;line-height:1.25 !important;text-transform:none !important;opacity:.9;margin-top:1px;}',
      /* check-in button: 66px square sized to the name-label height; glyph scaled to match. Full box
         stays clickable; the shield (when on) is drawn as ::before so the whole square still taps. */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper app-icon-button.align-top:has(button[id^="check-in-button"]) button{width:48px !important;height:48px !important;min-width:48px !important;min-height:48px !important;padding:0 !important;position:relative !important;overflow:visible !important;' + (CFG.SHOW_SHIELD ? 'background:transparent !important;border:none !important;box-shadow:none !important;border-radius:0 !important;' : 'border-radius:12px !important;box-shadow:0 2px 8px rgba(0,0,0,.35) !important;') + '}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"] mat-icon{font-size:26px !important;width:26px !important;height:26px !important;line-height:26px !important;position:relative !important;z-index:1 !important;}',
      /* SHIELD — reacts to ROLLER\'s own state class: theme--secondary = NOT checked in (amber "I.D."),
         theme--success = checked in (green tick). Pure CSS, so it flips the instant staff check someone in. */
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"]::before{content:"" !important;position:absolute !important;inset:0 !important;z-index:0 !important;clip-path:path("M24 2 L44 9 L44 24 C44 36 35 43 24 47 C13 43 4 36 4 24 L4 9 Z") !important;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4)) !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--secondary::before{background:transparent !important;filter:none !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--success::before{background:#16a34a !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--secondary mat-icon{display:none !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt{position:absolute !important;inset:0 !important;z-index:1 !important;display:none;flex-direction:column !important;align-items:center !important;justify-content:center !important;padding-bottom:6px !important;color:#fff !important;pointer-events:none !important;text-align:center !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) button[id^="check-in-button"].theme--secondary .rcz-shieldtxt{display:flex !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt__tick{display:flex !important;align-items:center !important;justify-content:center !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt__tick svg{width:46px !important;height:46px !important;margin:0 !important;overflow:visible !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--success mat-icon{color:#fff !important;margin-bottom:6px !important;}' : ''),

      /* ALERT (member with no photo) — fills the whole card and dominates; icon hidden */
      '.rcz-alert{position:absolute !important;inset:0 !important;display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;text-align:center !important;color:#e5231b !important;z-index:5 !important;pointer-events:none !important;padding:16px 18px 92px !important;gap:8px !important;}',
      '.rcz-alert__hd{font:900 25px/1.02 Roboto,Arial,sans-serif !important;letter-spacing:.01em !important;}',
      '.rcz-alert__body{font:800 12px/1.28 Roboto,Arial,sans-serif !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-alert-on button[id^="booking-details-button"] mat-icon{display:none !important;}',
      /* CASUAL (non-member) — calm grey, same card-filling layout; icon hidden */
      '.rcz-casual{position:absolute !important;left:16px !important;bottom:12px !important;z-index:6 !important;pointer-events:none !important;}',
      '.rcz-casual__tag{font:700 18px/1.32 Roboto,Arial,sans-serif !important;color:#565d66 !important;}',
      /* big near-black NAME, then the ticket TYPE, then the small grey casual sub-line */
      '.rcz-casual__name{font:900 48px/1.02 Roboto,Arial,sans-serif !important;color:#111827 !important;letter-spacing:.01em !important;}',
      // genuine "no name on file" placeholder: same name font, softened to grey so it reads as a system note,
      // not a person literally called "No name provided".
      '.rcz-casual__name--none{color:#9aa3af !important;letter-spacing:normal !important;}',
      '.rcz-casual__type{font:700 22px/1.3 Roboto,Arial,sans-serif !important;color:#1f2933 !important;margin-top:6px !important;}',
      '.rcz-casual__sub{font:400 15px/1.3 Roboto,Arial,sans-serif !important;color:#6b7280 !important;margin-top:9px !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-casual-on button[id^="booking-details-button"] mat-icon{display:none !important;}',
      /* age-type icon (#2): centred in the photo square, kept clear of the bottom bar */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="booking-details-button"] img.rcz-ageicon{position:absolute !important;top:44% !important;left:50% !important;transform:translate(-50%,-50%) !important;width:auto !important;height:62% !important;max-width:74% !important;object-fit:contain !important;pointer-events:none !important;z-index:2 !important;}',
      /* age-TEXT (#2, replaces the silhouette): ticket type over the name, centred, medium size */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="booking-details-button"] .rcz-agetext{position:absolute !important;top:42% !important;left:50% !important;transform:translate(-50%,-50%) !important;width:86% !important;z-index:2 !important;pointer-events:none !important;text-align:center !important;}',
      '.rcz-agetext__ty{font:600 36px/1.15 Roboto,Arial,sans-serif !important;color:#5b636d !important;letter-spacing:.02em !important;}',
      '.rcz-agetext__nm{font:700 44px/1.12 Roboto,Arial,sans-serif !important;color:#1f2933 !important;margin-top:5px !important;overflow-wrap:anywhere !important;}',
      /* MISMATCH (member, ticket name != membership name) — red, card-filling; icon hidden */
      '.rcz-mismatch{position:absolute !important;inset:0 !important;display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;text-align:center !important;color:#e5231b !important;z-index:5 !important;pointer-events:none !important;padding:16px 20px 78px !important;gap:14px !important;}',
      '.rcz-mismatch__hd{font:900 48px/1 Roboto,Arial,sans-serif !important;letter-spacing:.02em !important;}',
      '.rcz-mismatch__note{font:400 18px/1.32 Roboto,Arial,sans-serif !important;margin-top:10px !important;max-width:94% !important;}',
      '.rcz-mismatch__note b{font-weight:400 !important;}',
      /* member photo behind the mismatch text -> keep the FACE clearly visible; the warning is only a light
         semi-transparent reminder (a soft white wash + reduced opacity) so staff still see to verify the name */
      '.rcz-mismatch--onphoto{background:rgba(255,255,255,.3) !important;opacity:.72 !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-mismatch-on button[id^="booking-details-button"] mat-icon{display:none !important;}',
      /* VISITING (member from another museum, no photo) — red, card-filling; icon hidden */
      '.rcz-visiting{position:absolute !important;inset:0 !important;display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;text-align:center !important;color:#e5231b !important;z-index:5 !important;pointer-events:none !important;padding:16px 18px 78px !important;gap:10px !important;}',
      '.rcz-visiting__hd{font:900 48px/1 Roboto,Arial,sans-serif !important;letter-spacing:.02em !important;}',
      '.rcz-visiting__body{font:400 18px/1.32 Roboto,Arial,sans-serif !important;}',
      '.rcz-visiting__note{margin-top:2px !important;background:#e5231b !important;color:#fff !important;padding:8px 14px !important;border-radius:9px !important;font:400 15px/1.25 Roboto,Arial,sans-serif !important;letter-spacing:.03em !important;max-width:94% !important;box-shadow:0 2px 8px rgba(0,0,0,.28) !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-visiting-on button[id^="booking-details-button"] mat-icon{display:none !important;}',
      /* MEMBERSHIP TIER badge — small pill low over the photo */
      /* membership tag, bottom-LEFT: two lines ("Membership" over the tier), dark border. */
      /* min-height 66px so the tag matches the name label + shield heights (Tom\'s "similar heights" mock) */
      '.rcz-badge{position:absolute !important;left:16px !important;right:auto !important;bottom:12px !important;z-index:6 !important;display:flex !important;flex-direction:column !important;align-items:flex-start !important;justify-content:flex-end !important;gap:0 !important;white-space:nowrap !important;text-align:left !important;pointer-events:none !important;background:none !important;border:none !important;box-shadow:none !important;padding:0 !important;}',
      '.rcz-badge__tier{font:700 18px/1.32 Roboto,Arial,sans-serif !important;color:#2f6fed !important;}',
      '.rcz-badge__lbl{font:700 18px/1.32 Roboto,Arial,sans-serif !important;color:#2f6fed !important;}',
      '.rcz-badge--gold .rcz-badge__tier,.rcz-badge--gold .rcz-badge__lbl,.rcz-badge--wonder .rcz-badge__tier,.rcz-badge--wonder .rcz-badge__lbl{color:#2f6fed !important;}',
      '.rcz-badge__visit{color:#b4308f !important;}',
      /* link variant: base badge is pointer-events:none, so re-enable clicks + show it is tappable */
      '.rcz-badge--link{pointer-events:auto !important;cursor:pointer !important;text-decoration:none !important;transition:filter .1s,box-shadow .1s !important;}',
      '.rcz-badge--link:hover{filter:brightness(1.07) !important;box-shadow:0 3px 13px rgba(0,0,0,.45) !important;text-decoration:none !important;}',
      '.rcz-badge--link .rcz-badge__tier{text-decoration:none !important;}',
      /* NOTE banner over a photo card — family "add name" prompt / close-name "similar name" prompt.
         Sits across the top with a dark scrim; left padding clears the checkbox. */
      /* uniform left indent clears the checkbox (top-left over the card) so EVERY line — including */
      /* ones below the checkbox — sits on the same left axis, rather than wrapping around it. */
      '.rcz-note{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;z-index:5 !important;pointer-events:none !important;background:rgba(17,20,24,.82) !important;color:#fff !important;padding:12px 16px 13px 68px !important;text-align:left !important;font:400 11px/1.32 Roboto,Arial,sans-serif !important;}',
      '.rcz-note b{font-weight:400 !important;}',
      '.rcz-note--important b:first-child{color:#ffd23d !important;}',
      '.rcz-note__title{display:block !important;font:600 11px/1.25 Roboto,Arial,sans-serif !important;letter-spacing:.04em !important;margin-bottom:4px !important;}',
      '.rcz-note__body{font:400 11px/1.34 Roboto,Arial,sans-serif !important;}',
      '.rcz-note--similar .rcz-note__title{color:#7fd4ff !important;}',
      '.rcz-note--paid .rcz-note__title{color:#57d977 !important;}',
      /* BIRTHDAY flag — cake + month, top-right of the card, clear of the tick/alerts/checkbox */
      /* top set inline (default 12px) so it can be pushed below a top note banner when one is present */
      '.rcz-bday{position:absolute !important;right:12px !important;z-index:7 !important;display:flex !important;flex-direction:column !important;align-items:center !important;gap:0 !important;pointer-events:none !important;background:rgba(255,255,255,.93) !important;border-radius:13px !important;padding:6px 10px 5px !important;box-shadow:0 2px 8px rgba(0,0,0,.3) !important;}',
      '.rcz-bday__cake{font-size:36px !important;line-height:1 !important;display:inline-block !important;transform-origin:50% 90% !important;animation:rczCake 1.8s ease-in-out infinite !important;}',
      '.rcz-bday__m{font:900 13px/1.1 Roboto,Arial,sans-serif !important;color:#b4308f !important;letter-spacing:.03em !important;margin-top:2px !important;}',
      '@keyframes rczCake{0%,100%{transform:translateY(0) rotate(0)}20%{transform:translateY(-3px) rotate(-9deg)}45%{transform:translateY(0) rotate(0)}70%{transform:translateY(-2px) rotate(9deg)}}',
      /* opacity intentionally NOT !important — an !important value cannot be animated, which would */
      /* freeze the confetti invisible; the keyframe drives opacity from 0 up and back to 0. */
      '.rcz-bday__c{position:absolute !important;top:14px !important;left:50% !important;width:7px !important;height:7px !important;border-radius:1px !important;opacity:0;pointer-events:none !important;animation:rczConfetti 2.6s ease-out infinite !important;}',
      '@keyframes rczConfetti{0%{opacity:0;transform:translate(-50%,0) scale(.3) rotate(0)}10%{opacity:1}80%{opacity:1}100%{opacity:0;transform:translate(calc(-50% + var(--dx)),var(--dy)) scale(1) rotate(var(--r))}}',
      /* NAME MEANING — small italic line under the guest name in the bottom-left label */
      '.rcz-meaning{display:block !important;font:italic 500 13px/1.25 Roboto,Arial,sans-serif !important;color:#8a94a3 !important;margin-top:2px !important;}',
      /* ---- MEMBERSHIP card (photo fill + "Membership Found" panel). ROLLER's own label is hidden; we
             draw our own name label + info panel + tier tag. Placed last so the hide rule wins. ---- */
      'app-bip-summary.rcz-mem .summary__wrapper .summary-detail{display:none !important;}',
      'app-bip-summary.rcz-mem .summary__wrapper .summary-detail-time{display:none !important;}',
      '.rcz-mem-info{position:absolute !important;top:12px !important;left:64px !important;right:12px !important;z-index:5 !important;pointer-events:none !important;background:rgba(255,255,255,.9) !important;border-radius:12px !important;padding:9px 13px 10px !important;box-shadow:0 1px 4px rgba(0,0,0,.2) !important;}',
      '.rcz-mem-info__hd{font:900 22px/1.15 Roboto,Arial,sans-serif !important;color:#111827 !important;margin-bottom:3px !important;}',
      '.rcz-mem-info__row{font:700 15px/1.45 Roboto,Arial,sans-serif !important;color:#374151 !important;}',
      '.rcz-mem-info__row b{font-weight:900 !important;color:#111827 !important;}',
      '.rcz-mem-name{position:absolute !important;right:76px !important;bottom:12px !important;z-index:6 !important;display:flex !important;flex-direction:column !important;align-items:flex-end !important;justify-content:flex-end !important;white-space:nowrap !important;background:none !important;border:none !important;box-shadow:none !important;padding:0 !important;text-align:right !important;pointer-events:none !important;}',
      '.rcz-mem-name__cat{font:600 18px/1.32 Roboto,Arial,sans-serif !important;color:#111827 !important;}',
      '.rcz-mem-name__nm{font:800 18px/1.32 Roboto,Arial,sans-serif !important;color:#1f2933 !important;margin-top:0 !important;}',
      /* NAME-MISMATCH comparison, bottom-right: black labels, red values, right-aligned, clears the shield */
      '.rcz-mmnames{position:absolute !important;right:76px !important;bottom:12px !important;z-index:6 !important;display:flex !important;flex-direction:column !important;align-items:flex-end !important;gap:1px !important;white-space:nowrap !important;text-align:right !important;pointer-events:none !important;}',
      '.rcz-mmnames__row{font:700 18px/1.32 Roboto,Arial,sans-serif !important;}',
      '.rcz-mmnames__lbl{color:#111827 !important;}',
      '.rcz-mmnames__val{color:#e5231b !important;margin-left:5px !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-mmnames-on .summary-detail__item--emphasis,app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-mmnames-on .summary-detail__item-holder-wrapper{display:none !important;}',
      '.rcz-memstrip{position:absolute !important;left:0 !important;right:0 !important;bottom:70px !important;z-index:5 !important;pointer-events:none !important;background:#1f2429 !important;color:#fff !important;font:800 12px/1 Roboto,Arial,sans-serif !important;letter-spacing:.06em !important;text-align:center !important;padding:7px 8px !important;}',
      /* on a membership card the ADD PHOTO box sits ABOVE the "MEMBERSHIP: N USES" strip (which ends ~96px) */
      'app-bip-summary.rcz-mem .summary__wrapper .rcz-actreq{bottom:106px !important;}',
      /* STATUS BAND — Name:/Photo: readout across the top of the tile (grey = fine, red = needs action) */
      '.rcz-status{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;z-index:6 !important;pointer-events:none !important;background:rgba(255,255,255,.55) !important;-webkit-backdrop-filter:blur(6px) !important;backdrop-filter:blur(6px) !important;border-bottom:1px solid rgba(0,0,0,.07) !important;padding:8px 11px 5px 40px !important;font:400 12.5px/1.3 Roboto,Arial,sans-serif !important;color:#1f2933 !important;}',
      /* band is a row: Name/Photo readout on the left, session time hard right */
      '.rcz-status{display:flex !important;align-items:flex-start !important;justify-content:space-between !important;gap:10px !important;}',
      '.rcz-status__main{min-width:0 !important;}',
      /* single line, so centre it against the two-row readout rather than letting it ride the top edge */
      '.rcz-status__time{flex:none !important;align-self:center !important;}',
      '.rcz-status__time b{font:700 15px/1.15 Roboto,Arial,sans-serif !important;color:#1f2933 !important;white-space:nowrap !important;}',
      /* NB: no margin hack for the birthday cake here — it's dropped below the band instead (see bdayTop),
         which is self-adjusting rather than a magic number that breaks when the band changes height. */
      '.rcz-status__row{display:flex !important;gap:4px !important;align-items:center !important;}',
      '.rcz-status__lbl{color:#1f2933 !important;}',
      '.rcz-status__ok{color:#1f2933 !important;}',
      '.rcz-status__warn{color:#e5231b !important;}',
      '.rcz-status__tick{color:#8b929b !important;font-weight:700 !important;margin-left:5px !important;}',
      /* FROSTED BOTTOM BAR — unified translucent band behind tier / name / shield */
      '.rcz-botbar{position:absolute !important;left:0 !important;right:0 !important;bottom:0 !important;height:70px !important;z-index:4 !important;pointer-events:none !important;background:rgba(255,255,255,.55) !important;-webkit-backdrop-filter:blur(6px) !important;backdrop-filter:blur(6px) !important;border-top:1px solid rgba(0,0,0,.07) !important;}',
      /* top overlays sit clear of the status band */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-alert-on .rcz-alert,app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-mismatch-on .rcz-mismatch{padding-top:52px !important;}',
      '.rcz-note{top:47px !important;}',
      /* LOCKED shield — dim + block the check-in button until staff action a prompt */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper.rcz-locked button[id^="check-in-button"]{pointer-events:none !important;opacity:.34 !important;filter:grayscale(.7) !important;}',
      /* UNDO CHECK-IN — while we drive ROLLER's own actions menu (open it, pick "Undo check-in"), keep the
         menu + its backdrop off screen so staff see one tap go straight to ROLLER's confirm modal instead
         of a menu flashing open and shut. Cleared the moment the option is clicked. */
      'body.rcz-undoing .cdk-overlay-container .mat-mdc-menu-panel,body.rcz-undoing .cdk-overlay-container .mat-menu-panel{opacity:0 !important;}',
      'body.rcz-undoing .cdk-overlay-backdrop{opacity:0 !important;}',
      /* ACTION REQUIRED prompt — frosted banner with tappable links */
      /* Box spans (near) the full tile width and is a query container, so the three lines can size
         themselves to the tile (min(cap, N cqw)) and always land on ONE line — no wrap, less grey hidden.
         On a wide tile they cap at the approved 23/15px; on a narrow tile they shrink just enough to fit. */
      '.rcz-actreq{position:absolute !important;left:8px !important;right:8px !important;transform:none !important;max-width:none !important;bottom:76px !important;z-index:6 !important;pointer-events:none !important;container-type:inline-size !important;background:rgba(255,255,255,.86) !important;-webkit-backdrop-filter:blur(4px) !important;backdrop-filter:blur(4px) !important;border-radius:13px !important;padding:12px 12px 13px !important;box-shadow:0 3px 12px rgba(0,0,0,.18) !important;text-align:center !important;}',
      /* NAME-action box (fix #1): a second frosted card, identical style, stacked ABOVE the ADD PHOTO box on a
         no-photo close/mismatch tile. Its bottom is set in JS to clear the box below it. Reuses __hd/__links. */
      '.rcz-nameact{position:absolute !important;left:8px !important;right:8px !important;bottom:168px !important;z-index:6 !important;pointer-events:none !important;container-type:inline-size !important;background:rgba(255,255,255,.86) !important;-webkit-backdrop-filter:blur(4px) !important;backdrop-filter:blur(4px) !important;border-radius:13px !important;padding:12px 12px 13px !important;box-shadow:0 3px 12px rgba(0,0,0,.18) !important;text-align:center !important;}',
      '.rcz-actreq__hd{font-family:Roboto,Arial,sans-serif !important;font-weight:800 !important;font-size:min(20px,5.6cqw) !important;line-height:1.15 !important;white-space:nowrap !important;letter-spacing:0 !important;color:#e5231b !important;}',
      '.rcz-actreq__sub{font-family:Roboto,Arial,sans-serif !important;font-weight:700 !important;font-size:min(12px,3.3cqw) !important;line-height:1.25 !important;white-space:nowrap !important;letter-spacing:0 !important;color:#e5231b !important;margin-top:5px !important;}',
      '.rcz-actreq__links{display:flex !important;gap:10px !important;align-items:center !important;justify-content:center !important;margin-top:8px !important;flex-wrap:wrap !important;}',
      '.rcz-actreq a,.rcz-nameact a,.rcz-addlink{color:#2f6fed !important;text-decoration:underline !important;text-underline-offset:2px !important;pointer-events:auto !important;cursor:pointer !important;font:700 12px/1 Roboto,Arial,sans-serif !important;}',
      '.rcz-actreq__links a{font-family:Roboto,Arial,sans-serif !important;font-weight:800 !important;font-size:min(23px,6.5cqw) !important;line-height:1.1 !important;white-space:nowrap !important;}',
      '.rcz-actreq__or{color:#a12a20 !important;font-family:Roboto,Arial,sans-serif !important;font-weight:700 !important;font-size:min(23px,6.5cqw) !important;line-height:1.1 !important;white-space:nowrap !important;}',
      '.rcz-actreq--mm .rcz-actreq__hd,.rcz-nameact .rcz-actreq__hd{font-size:min(16px,4.7cqw) !important;line-height:1.18 !important;}',
      /* NAME-MISMATCH redesign: red wash over the photo, a dismiss X, and one bordered "ADD A TICKET FOR X" button */
      '.rcz-mmveil{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;bottom:70px !important;background:rgba(229,35,27,.42) !important;z-index:2 !important;pointer-events:none !important;}',
      '.rcz-actreq a.rcz-mmx,.rcz-nameact a.rcz-mmx{position:absolute !important;top:-13px !important;right:-6px !important;width:28px !important;height:28px !important;border-radius:50% !important;background:#111827 !important;color:#fff !important;display:flex !important;align-items:center !important;justify-content:center !important;font:700 18px/1 Roboto,Arial,sans-serif !important;text-decoration:none !important;pointer-events:auto !important;cursor:pointer !important;box-shadow:0 2px 6px rgba(0,0,0,.4) !important;z-index:7 !important;}',
      '.rcz-actreq__links a.rcz-mmbtn{display:inline-block !important;border:2px solid #111827 !important;border-radius:10px !important;padding:8px 16px !important;background:rgba(255,255,255,.55) !important;color:#2f6fed !important;font:800 min(20px,5.6cqw)/1.1 Roboto,Arial,sans-serif !important;text-decoration:none !important;white-space:nowrap !important;pointer-events:auto !important;cursor:pointer !important;}',
      '.rcz-addlink{font-size:16px !important;margin-left:8px !important;}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function shorten() {
    document.querySelectorAll('app-bip-summary:not(.rcz-skip):not(.rcz-mem) .summary-detail__item--emphasis').forEach(function (p) {
      if (!p.hasAttribute('data-rcz-full')) p.setAttribute('data-rcz-full', p.textContent.trim());
      var sh = p.getAttribute('data-rcz-full').split(' (')[0].split(' -')[0].trim();
      if (p.textContent.trim() !== sh) p.textContent = sh;
    });
  }
  function addAlert(w, href, cardId) {
    w.classList.add('rcz-alert-on');
    var a = w.querySelector('.rcz-alert');
    if (!a) { a = document.createElement('div'); a.className = 'rcz-alert'; w.appendChild(a); }
    var html = '<div class="rcz-alert__hd">' + CFG.ALERT_LINES[0] +
               (href ? ' <a class="rcz-addlink" href="#" data-rcz-unlock="' + esc(cardId) + '" data-rcz-href="' + esc(href) + '">Add</a>' : '') + '</div>' +
               '<div class="rcz-alert__body">' + CFG.ALERT_LINES[1] + '</div>';
    if (a.getAttribute('data-h') !== html) { a.innerHTML = html; a.setAttribute('data-h', html); }
    // clicking the alert box goes to this member's membership detail (NOT the ticket-holder tile behind it)
    if (href) a.setAttribute('data-rcz-href', href); else a.removeAttribute('data-rcz-href');
  }
  function clrAlert(w) { w.classList.remove('rcz-alert-on'); var a = w.querySelector('.rcz-alert'); if (a) a.remove(); }
  function addCasual(w, name, category, tagLabel) {
    // New design: casual tiles carry no centre text — the person-icon placeholder, the "No Match Required"
    // status band, and the name in the bottom bar already say everything. We keep a small tag in the
    // bottom-left (styled via .rcz-casual) in place of a membership tier badge — "Casual Guest" by default,
    // or a partnership label like "Foster CARE Ticket" when passed.
    w.classList.add('rcz-casual-on');
    var c = w.querySelector('.rcz-casual');
    if (!c) { c = document.createElement('div'); c.className = 'rcz-casual'; w.appendChild(c); }
    var html = '<span class="rcz-casual__tag">' + esc(tagLabel || 'Casual Guest') + '</span>';
    if (c.getAttribute('data-h') !== html) { c.innerHTML = html; c.setAttribute('data-h', html); }
  }
  function clrCasual(w) { w.classList.remove('rcz-casual-on'); var c = w.querySelector('.rcz-casual'); if (c) c.remove(); }
  // Age-type icon for casual/foster tiles (#2): map the ticket type to infant/child/adult and paint the
  // matching icon in the photo square (replacing ROLLER's blank person placeholder).
  // Classify a ticket-type string into an admission age band, or null when it is NOT an admission (e.g. a gift
  // card, retail item or visit package). Non-admissions have no age, so they must not default to "Adult".
  function ageType(t) {
    t = String(t || '').toLowerCase();
    if (/infant|baby|under\s?1\b/.test(t)) return 'infant';
    if (/child|junior|youth|\bkid/.test(t)) return 'child';
    if (/adult|senior|concession|\b\d{1,2}\s*\+|\byears?\b|\byrs?\b/.test(t)) return 'adult';
    return null;
  }
  function ageIconKey(t) { return ageType(t) || 'adult'; }   // icon fallback stays 'adult'
  // A booking is a PARTY when it carries a ROLLER form whose name mentions "party" (e.g. "Party Details",
  // "1-Week Out: Hosted Party Details"). Scoped to <app-booking-forms> so the "Party Room" resource / party
  // discount elsewhere in the panel never trigger it. Graceful: if the component is ever renamed, it just
  // stops flagging (falls back to Adult/Child), never breaks.
  function rczIsPartyBooking() {
    var f = document.querySelector('app-booking-forms');
    return !!(f && /party/i.test(f.textContent || ''));
  }
  // Tidy a non-admission product type for the tile label: drop a leading "N x", trailing pricing and parentheticals.
  function typeLabel(t) {
    return String(t || '').replace(/^\s*\d+\s*x\s*/i, '').replace(/\s*@.*$/, '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function setAgeIcon(btn, type) {
    if (!btn) return;
    var uri = CFG.AGE_ICONS[ageIconKey(type)];
    var im = btn.querySelector('img.rcz-ageicon');
    if (!uri) { if (im) im.remove(); return; }
    var mi = btn.querySelector('mat-icon'); if (mi) mi.style.display = 'none';
    if (!im) { im = document.createElement('img'); im.className = 'rcz-ageicon'; im.alt = ''; btn.appendChild(im); }
    if (im.getAttribute('src') !== uri) im.setAttribute('src', uri);
  }
  function clrAgeIcon(btn) { if (!btn) return; var im = btn.querySelector('img.rcz-ageicon'); if (im) im.remove(); }
  // Text placeholder for casual/foster tiles: the ticket TYPE over the NAME, medium size, centred in the
  // square — replaces the silhouette. Bottom bar still carries type+name; this just fills the empty photo area.
  function setAgeText(btn, typeRaw, name) {
    if (!btn) return;
    var at = ageType(typeRaw);
    // Party booking -> admission tiles read "Party Guest" (flag the whole party). Otherwise: admission -> the age
    // word (Infant/Child/Adult); non-admission (gift card, retail, package) -> its real product type, never a
    // bogus "Adult". Non-admission items on a party (food/add-ons) keep their real type — only age tiles flip.
    var party = CFG.FLAG_PARTY_GUESTS && state.isParty && !!at;
    var ty = party ? CFG.PARTY_GUEST_LABEL
           : at ? (at.charAt(0).toUpperCase() + at.slice(1))
           : typeLabel(typeRaw);
    // Mark party-guest tiles so the CSS can hide ROLLER's product line ("Number of Children") on them.
    var _ph = btn.closest && btn.closest('app-bip-summary'); if (_ph) _ph.classList.toggle('rcz-partyguest', party);
    var nm = proper(firstName(name || ''));
    var oi = btn.querySelector('img.rcz-ageicon'); if (oi) oi.remove();   // drop any prior silhouette
    var mi = btn.querySelector('mat-icon'); if (mi) mi.style.display = 'none';
    var el = btn.querySelector('.rcz-agetext');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-agetext'; btn.appendChild(el); }
    var html = '<div class="rcz-agetext__ty">' + esc(ty) + '</div>' +
               (nm ? '<div class="rcz-agetext__nm">' + esc(nm) + '</div>' : '');
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrAgeText(btn) { if (!btn) return; var el = btn.querySelector('.rcz-agetext'); if (el) el.remove(); var im = btn.querySelector('img.rcz-ageicon'); if (im) im.remove(); var h = btn.closest && btn.closest('app-bip-summary'); if (h) h.classList.remove('rcz-partyguest'); }
  function addMismatch(w, noteHtml, onPhoto) {
    w.classList.add('rcz-mismatch-on');
    var m = w.querySelector('.rcz-mismatch');
    if (!m) { m = document.createElement('div'); m.className = 'rcz-mismatch'; w.appendChild(m); }
    // when the member's photo sits behind the text, add a translucent veil so the red stays readable
    var cls = 'rcz-mismatch' + (onPhoto ? ' rcz-mismatch--onphoto' : '');
    if (m.className !== cls) m.className = cls;
    // non-breaking hyphen so "MIS-MATCH" stays whole and the title wraps as "NAME" / "MIS-MATCH"
    var title = String(CFG.MISMATCH_LINES[0]).replace(/-/g, '‑');
    var html = '<div class="rcz-mismatch__hd">' + title + '</div>' +
               '<div class="rcz-mismatch__note">' + noteHtml + '</div>';
    if (m.getAttribute('data-h') !== html) { m.innerHTML = html; m.setAttribute('data-h', html); }
  }
  function clrMismatch(w) { w.classList.remove('rcz-mismatch-on'); var m = w.querySelector('.rcz-mismatch'); if (m) m.remove(); }
  // NOTE banner over a photo card. kind 'important' = family add-name; kind 'similar' = close-name match.
  function addNote(w, kind, memberName, ticketName) {
    var el = w.querySelector('.rcz-note');
    if (!el) { el = document.createElement('div'); w.appendChild(el); }
    var cls, html, key = kind + '|' + (memberName || '') + '|' + (ticketName || '');
    if (kind === 'important') {
      cls = 'rcz-note rcz-note--important';
      html = '<b>IMPORTANT:</b> ' + esc(CFG.FAMILY_NOTE);
    } else if (kind === 'paidmember') {
      // memberName carries the member's first name; ticketName carries the other guest's ticket type.
      cls = 'rcz-note rcz-note--paid';
      var pnm = '<b>' + esc(memberName) + '</b>';
      var pbody = esc(CFG.PAID_MEMBER_NOTE_TMPL).split('{NAME}').join(pnm).split('{TYPE}').join('<b>' + esc(ticketName || 'guest') + '</b>');
      html = '<div class="rcz-note__title">' + esc(CFG.PAID_MEMBER_TITLE) + '</div><div class="rcz-note__body">' + pbody + '</div>';
    } else if (kind === 'misaligned') {
      cls = 'rcz-note rcz-note--paid';
      html = '<div class="rcz-note__title">' + esc(CFG.MISALIGN_TITLE) + '</div><div class="rcz-note__body">' + esc(CFG.MISALIGN_NOTE) + '</div>';
    } else {
      cls = 'rcz-note rcz-note--similar';
      var mn = '<b>' + esc(memberName) + '</b>', tn = '<b>' + esc(ticketName) + '</b>';
      var body = esc(CFG.CLOSE_NOTE_TMPL).split('{NAME}').join(mn).split('{TICKET}').join(tn);
      var title = esc(CFG.CLOSE_TITLE).replace(/-/g, '‑'); // non-breaking hyphen keeps CLOSE-MATCH whole
      html = '<div class="rcz-note__title">' + title + '</div><div class="rcz-note__body">' + body + '</div>';
    }
    if (el.className !== cls) el.className = cls;
    if (el.getAttribute('data-k') !== key) { el.innerHTML = html; el.setAttribute('data-k', key); }
  }
  function clrNote(w) { var el = w.querySelector('.rcz-note'); if (el) el.remove(); }
  function addVisiting(w) {
    w.classList.add('rcz-visiting-on');
    var v = w.querySelector('.rcz-visiting');
    if (!v) { v = document.createElement('div'); v.className = 'rcz-visiting'; w.appendChild(v); }
    var L = CFG.VISITING_LINES;
    // Second line reads like the standard photo alert, then an appended "NOTE: ... VISITING ..."
    // callout. Split on NOTE: so the visiting flag renders as its own highlighted banner.
    var body = String(L[1] || ''), note = '';
    var idx = body.toUpperCase().indexOf('NOTE:');
    if (idx > -1) { note = body.slice(idx).trim(); body = body.slice(0, idx).replace(/[\s.]+$/, '').trim(); }
    var html = '<div class="rcz-visiting__hd">' + esc(L[0]) + '</div>' +
               '<div class="rcz-visiting__body">' + esc(body) + '</div>' +
               (note ? '<div class="rcz-visiting__note">' + esc(note) + '</div>' : '');
    if (v.getAttribute('data-h') !== html) { v.innerHTML = html; v.setAttribute('data-h', html); }
  }
  function clrVisiting(w) { w.classList.remove('rcz-visiting-on'); var v = w.querySelector('.rcz-visiting'); if (v) v.remove(); }
  // ROLLER prints a blue "Member: <name>" pill in the booking's discounts panel, each linking to that
  // member's detail page (/search/memberships/<acct>/<memberId>). Scrape those into a name->href map so
  // we can point the tier tag at the exact same URL. Keyed on the lowercased member name — the same
  // field (memberName) we already read off the discount, so it lines up 1:1 with no ticket-name guessing.
  function membershipLinkMap() {
    var m = {};
    try {
      document.querySelectorAll('a[id^="membership-discount-link-"]').forEach(function (a) {
        var href = a.getAttribute('href') || '';
        if (!/^\/search\/memberships\/\d+\/\d+/.test(href)) return;
        var t = (a.textContent || '').replace(/^\s*member:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t && !m[t]) m[t] = href;
      });
    } catch (e) {}
    return m;
  }
  // this card's OWN membership slot: cardId -> its memberBookingItemPartId (state.discountIndex) -> the
  // matching per-slot discount pill's href. Family-safe: each child resolves to their own slot (not the
  // first name-match, which for a family is always the account holder).
  function cardMemberHref(cardId) {
    if (!cardId) return null;
    try {
      for (var b in state.discountIndex) {
        if (state.discountIndex[b] && String(state.discountIndex[b].cardId) === String(cardId)) {
          var pill = document.getElementById('membership-discount-link-' + b);
          if (pill) { var h = pill.getAttribute('href'); if (h && /^\/search\/memberships\/\d+\/\d+/.test(h)) return h; }
        }
      }
    } catch (e) {}
    return null;
  }
  // Has this card's family slot been individually NAMED yet? Reads the live blue pills (which update the
  // instant staff add a name in the member's Guest tab): a slot whose pill name is UNIQUE among the
  // booking's pills has been named; a name repeated across slots is still the defaulted account-holder
  // name (still un-named). Lets us drop the "Add individual names" prompt for slots that are now done.
  function slotNamed(cardId) {
    var pills = document.querySelectorAll('a[id^="membership-discount-link-"]');
    if (pills.length < 2) return false;
    var counts = {}, mine = null;
    for (var i = 0; i < pills.length; i++) {
      var nm = (pills[i].textContent || '').replace(/^\s*member:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
      counts[nm] = (counts[nm] || 0) + 1;
      var id = pills[i].id.replace('membership-discount-link-', '');
      if (state.discountIndex[id] && String(state.discountIndex[id].cardId) === String(cardId)) mine = nm;
    }
    return !!(mine && counts[mine] === 1);
  }
  function memHref(info, cardId) {
    if (!CFG.LINK_MEMBERSHIP_BADGE) return null;
    var slot = cardMemberHref(cardId); if (slot) return slot;   // prefer this card's own slot
    var lm = state.memLinks; if (!lm) return null;
    var k = String((info && info.memberFull) || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return k && lm[k] ? lm[k] : null;
  }
  // Holder name for a card: ROLLER's own label if present, else the name captured in the Ticket Holder
  // Details form (some bookings leave the ticket's name blank but collect it in that form, e.g. children
  // added to a parent's booking, or an adult whose name only went into the form).
  function holderNameFor(w, cardId) {
    var t = ((w.querySelector('.summary-detail__item-holder-wrapper') || {}).textContent || '').trim();
    if (!t && cardId && state.formNames[cardId]) t = state.formNames[cardId];
    return t;
  }
  // Family-membership guard: the blue discount pills list the TRUE members on the membership(s) used on
  // this booking (e.g. "Ciara Kett"). If a ticket draws on a membership but the holder isn't one of those
  // named members (e.g. an adult "Will" riding on Ciara's slot), flag it — even when ROLLER's own discount
  // name field let it through as a match. Pairs the odd-one-out ticket to the odd-one-out member to name it.
  function pillMismatchCheck(w, cardId) {
    var pills = document.querySelectorAll('a[id^="membership-discount-link-"]');
    if (!pills.length) return null;
    var pillFirsts = [];
    pills.forEach(function (a) {
      var full = (a.textContent || '').replace(/^\s*member:\s*/i, '').replace(/\s+/g, ' ').trim();
      var f = firstName(full); if (f && pillFirsts.indexOf(f) < 0) pillFirsts.push(f);
    });
    var nm = firstName(holderNameFor(w, cardId));
    if (!nm) return null;                          // no name to compare -> leave alone
    if (pillFirsts.indexOf(nm) >= 0) return null;  // ticket-holder IS a named member -> fine
    for (var i = 0; i < pillFirsts.length; i++) if (sameName(pillFirsts[i], nm)) return null; // spelling/nickname variant of a member -> same person, not an interloper
    // genuine interloper. Find the single membership name not claimed by any ticket, so we can name it.
    var ticketFirsts = [];
    document.querySelectorAll('app-bip-summary:not(.rcz-skip) .summary__wrapper').forEach(function (w2) {
      var b2 = w2.querySelector('button[id^="booking-details-button-"]'); if (!b2) return;
      var c2 = b2.id.replace('booking-details-button-', ''); var i2 = state.byCard[c2];
      if (i2 && i2.member) { var n2 = firstName(holderNameFor(w2, c2)); if (n2) ticketFirsts.push(n2); }
    });
    var unclaimed = pillFirsts.filter(function (pf) { return ticketFirsts.indexOf(pf) < 0; });
    if (!unclaimed.length) return null;   // every membership is claimed by a matching guest -> this ticket is a rider, not an interloper
    return { memberName: unclaimed.length === 1 ? proper(unclaimed[0]) : '', ticketName: proper(nm) };
  }
  // render a card as a name-mismatch (red overlay) while KEEPING the member photo behind it, if present
  function showMismatch(w, btn, icon, img, cardId, memberName, ticketName, tier) {
    if (img) { /* keep photo */ } else { var im = btn.querySelector('img.rcz-photo'); if (im) img = im; }
    if (icon && (img || btn.querySelector('img.rcz-photo'))) icon.style.display = 'none';
    // The big red NAME MIS-MATCH overlay is retired — the frosted FRAUD WARNING box below carries the message.
    clrMismatch(w);
    // frosted FRAUD box: a dismiss (X) + one "ADD A TICKET FOR <NAME>" button
    addMismatchBox(w, cardId, ticketName);
    clrAlert(w); clrCasual(w); clrVisiting(w); clrNote(w);
    if (tier) addBadge(w, tier, null); else clrBadge(w);
  }
  // ROLLER draws the member's own photo in the avatar button as <img> with a "/ticket/..." CDN src when
  // one is on file. Our membership API lookup occasionally returns no imageFileName even though ROLLER
  // has the photo — so treat this rendered photo as the source of truth for "photo on file".
  function nativePhotoImg(btn) {
    if (!btn) return null;
    var ims = btn.querySelectorAll('img:not(.rcz-photo)');
    for (var i = 0; i < ims.length; i++) { var s = ims[i].getAttribute('src') || ''; if (/\/ticket\//.test(s)) return ims[i]; }
    return null;
  }
  // ticket type (adult/child/infant/…) shown on the card for a given booking-item part id
  function ticketTypeOfPart(part) {
    var b = document.getElementById('booking-details-button-' + part); if (!b) return 'guest';
    var wr = b.closest('.summary__wrapper'); var e = wr && wr.querySelector('.summary-detail__item--emphasis');
    var t = e ? (e.textContent || '').trim().toLowerCase() : '';
    var m = t.match(/adult|child|infant|concession|senior|teen|student|junior/); return m ? m[0] : 'guest';
  }
  // pick the member's first name off their own card label
  function firstNameOnCard(w) {
    var t = ((w.querySelector('.summary-detail__item-holder-wrapper') || {}).textContent || '').trim();
    return proper((t.split(/person|current|expired/i)[0] || '').trim().split(/\s+/)[0] || '');
  }
  // add the family / close-match / mis-assigned note to a member photo card (shared by both photo paths)
  function memberNote(w, info, cardId) {
    var hasPhoto = !!w.querySelector('img.rcz-photo');
    if (info.family) { addActionReq(w, cardId, memberActions(w, info, cardId, hasPhoto)); clrNote(w); }
    else if (info.closematch) { addMismatchBox(w, cardId, info.ticketName); clrNote(w); }
    else if (info.paidMember) { addNote(w, 'paidmember', firstNameOnCard(w), ticketTypeOfPart(info.recipPart)); clrActionReq(w); }
    else { clrNote(w); clrActionReq(w); }
  }
  function addBadge(w, tier, href, visiting) {
    var gold = tier === 'gold';
    var b = w.querySelector('.rcz-badge');
    // badge is an <a> so it can carry an href; recreate if an older <div> badge is still on the card
    if (b && b.tagName !== 'A') { b.remove(); b = null; }
    if (!b) { b = document.createElement('a'); w.appendChild(b); }
    // Always styled as a link so the tag looks identical everywhere. Where a blue member-pill exists we
    // hand off to it; where it doesn't, the click falls back to the card's tile (ROLLER's built-in nav to
    // the same detail) — so it never looks like a dead link.
    var cls = 'rcz-badge ' + (gold ? 'rcz-badge--gold' : 'rcz-badge--wonder') + (CFG.LINK_MEMBERSHIP_BADGE ? ' rcz-badge--link' : '');
    if (b.className !== cls) b.className = cls;
    if (href) {
      if (b.getAttribute('href') !== href) b.setAttribute('href', href);
      if (CFG.MEM_LINK_NEWTAB) { b.setAttribute('target', '_blank'); b.setAttribute('rel', 'noopener'); }
      else { b.removeAttribute('target'); b.removeAttribute('rel'); }
    } else if (b.hasAttribute('href')) { b.removeAttribute('href'); b.removeAttribute('target'); b.removeAttribute('rel'); }
    // members visiting from another museum (pill shows an ID, not a name) get a magenta "Visiting" flag
    // beside "Member" — nested inside __lbl so it sits on the same line as the label.
    var lbl = 'Member' + (visiting ? ' <span class="rcz-badge__visit">Visiting</span>' : '');
    var html = '<span class="rcz-badge__tier">' + esc(gold ? CFG.TIER_GOLD : CFG.TIER_WONDER) + '</span><span class="rcz-badge__lbl">' + lbl + '</span>';
    if (b.getAttribute('data-h') !== html) { b.innerHTML = html; b.setAttribute('data-h', html); }
  }
  function clrBadge(w) { var b = w.querySelector('.rcz-badge'); if (b) b.remove(); }
  function addBirthday(w, m) {
    var el = w.querySelector('.rcz-bday');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-bday'; w.appendChild(el); }
    var conf = '';
    if (CFG.BIRTHDAY_ANIMATE) {
      // confetti pieces: [colour, dx, dy(down), rotate, delay] — position:absolute so they don't
      // disturb the pill's flex layout; each loops on a stagger.
      var P = [['#ff5da2', -58, 74, '-160deg', 0], ['#ffd23d', -30, 92, '120deg', 0.35], ['#4dd4ff', -74, 52, '-100deg', 0.7],
               ['#7bd67b', 8, 86, '170deg', 0.15], ['#b98bff', -46, 64, '70deg', 0.9], ['#ff9f4d', -18, 44, '-70deg', 0.5]];
      for (var i = 0; i < P.length; i++) { var p = P[i]; conf += '<i class="rcz-bday__c" style="background:' + p[0] + ';--dx:' + p[1] + 'px;--dy:' + p[2] + 'px;--r:' + p[3] + ';animation-delay:' + p[4] + 's"></i>'; }
    }
    var html = '<span class="rcz-bday__cake">🎂</span><span class="rcz-bday__m">' + esc(monthName(m).slice(0, 3).toUpperCase()) + '</span>' + conf;
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrBirthday(w) { var el = w.querySelector('.rcz-bday'); if (el) el.remove(); }
  // Where the cake's top edge goes. It's absolutely positioned top-right, so it has to be pushed clear of
  // whatever else is already up there — MEASURED, not guessed, because these things change height with
  // their content. Priority: a note banner (close-match / family) if present, else the status band, which
  // now carries the session time hard-right and is exactly what the cake was landing on top of.
  function bdayTop(w) {
    var nb = w.querySelector('.rcz-note');
    if (nb && nb.offsetHeight) return (nb.offsetHeight + 10) + 'px';
    var sb = w.querySelector('.rcz-status');
    if (sb && sb.offsetHeight) return (sb.offsetHeight + 8) + 'px';
    return '12px';
  }
  function addMeaning(w, text) {
    var label = w.querySelector('.summary-detail'); if (!label) return;
    var el = label.querySelector('.rcz-meaning');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-meaning'; label.appendChild(el); }
    var t = 'meaning: ' + text;
    if (el.textContent !== t) el.textContent = t;
  }
  function clrMeaning(w) { var el = w.querySelector('.rcz-meaning'); if (el) el.remove(); }
  // STATUS BAND — top-of-tile Name:/Photo: readout. warn=true paints the value red (needs action).
  // SESSION TIME — scraped off ROLLER's own card markup rather than recomputed, so it always matches what
  // ROLLER would have printed. Prefer its dedicated classes; if those are ever renamed, fall back to
  // reading the times straight out of the .summary-detail text. Returns {time, dur} — dur only when it
  // really looks like a duration, so we never mistake a resource name ("The Museum") for one.
  // Leaf-node text joined with SPACES. Plain textContent glues adjacent spans together ("11:30 am" + "2 hrs"
  // -> "11:30 am2 hrs"), which destroys the \b word boundaries the pattern below relies on. Same leaf-walk
  // membershipInfo() already uses. Our own status band is skipped so we can never read back the time we
  // just painted into it.
  function leafText(host) {
    if (!host) return '';
    var out = [];
    host.querySelectorAll('*').forEach(function (el) {
      if (el.children.length) return;                                   // leaves only
      if (el.closest && el.closest('.rcz-status')) return;              // never our own output
      var t = (el.textContent || '').trim(); if (t) out.push(t);
    });
    return out.join(' ').replace(/\s+/g, ' ');
  }
  // WHERE ROLLER ACTUALLY KEEPS THE START TIME — probed on the live POS, and it is not where the class
  // names suggest:
  //     div.summary-detail-time > p.summary-detail__item--emphasis.summary-detail-flex-end
  //                             > span.bip-dot-container          -> "11:30 am"
  // Two traps this walked into before: .summary-detail-session-start holds the DURATION ("2 hrs"), not the
  // start; and .summary-detail is a different block again ("MoPA: Free Play  Adult Sarah"), so searching it
  // finds no time at all. Read the time block, and only fall back to the whole card if it's ever renamed.
  function sessionTimeOf(w) {
    var TIME = /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i;
    var m = leafText(w.querySelector('.summary-detail-time')).match(TIME);
    if (!m) m = leafText(w).match(TIME);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }
  function statusTimeHtml(w) {
    if (!CFG.SHOW_SESSION_TIME) return '';
    var t = sessionTimeOf(w);
    return t ? '<div class="rcz-status__time"><b>' + esc(t) + '</b></div>' : '';
  }
  function paintStatus(w, nm, nmW, ph, phW) {
    var el = w.querySelector('.rcz-status');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-status'; w.appendChild(el); }
    function tk(v) { return (v === 'Matched' || v === 'Showing') ? '<span class="rcz-status__tick">✓</span>' : ''; }
    var html = '<div class="rcz-status__main">' +
               '<div class="rcz-status__row"><span class="rcz-status__lbl">Name:</span><span class="' + (nmW ? 'rcz-status__warn' : 'rcz-status__ok') + '">' + esc(nm) + '</span>' + tk(nm) + '</div>' +
               '<div class="rcz-status__row"><span class="rcz-status__lbl">Photo:</span><span class="' + (phW ? 'rcz-status__warn' : 'rcz-status__ok') + '">' + esc(ph) + '</span>' + tk(ph) + '</div>' +
               '</div>' + statusTimeHtml(w);
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrStatus(w) { var el = w.querySelector('.rcz-status'); if (el) el.remove(); }
  // BLANK status band — casual guests carry no Name:/Photo: readout, but we still draw the band (two empty
  // rows keep it the same height as a member's) so every tile shares the same top edge. Pure consistency.
  function paintStatusEmpty(w) {
    var el = w.querySelector('.rcz-status');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-status'; w.appendChild(el); }
    // Casual tiles carry no Name:/Photo: readout, but they DO get the session time — stock ROLLER shows it
    // against every ticket, member or not, and it's the one fact staff need on a casual tile.
    var html = '<div class="rcz-status__main"><div class="rcz-status__row">&nbsp;</div><div class="rcz-status__row">&nbsp;</div></div>' + statusTimeHtml(w);
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  // derive the Name:/Photo: status for a card from its detected scenario. Returns null while loading.
  function statusInfo(w, info) {
    if (!info || info.pending) return null;
    var hasPhoto = !!w.querySelector('img.rcz-photo');
    if (info.member === false && !info.misaligned) return null;  // casual guests: no top status band at all
    if (info.misaligned || info.paidMember)        return { nm: 'Mismatched (assignment error only)', nmW: true, ph: hasPhoto ? 'Showing' : 'No Match Required', phW: false };
    if (info.mismatch)                             return { nm: 'Not Matching', nmW: true, ph: hasPhoto ? 'Showing' : 'Required Today (Add)', phW: !hasPhoto };
    if (info.family)                               return { nm: 'Names Required', nmW: true, ph: hasPhoto ? 'Showing' : 'Required Today', phW: !hasPhoto };
    if (info.closematch)                           return { nm: 'Not Matching', nmW: true, ph: hasPhoto ? 'Showing' : 'Required Today', phW: !hasPhoto };
    if (info.member)                               return { nm: 'Matched', nmW: false, ph: hasPhoto ? 'Showing' : 'Required Today', phW: !hasPhoto };
    return null;
  }
  // Does this card need a staff action before check-in (so we lock the shield)? Fail-safe: false when unsure.
  function needsAction(w, info) {
    if (!info || info.pending) return false;
    var hasPhoto = !!w.querySelector('img.rcz-photo');
    if (info.mismatch || info.family || info.closematch) return true;               // name / names / close
    if (info.member && !info.misaligned && !info.paidMember && !hasPhoto) return true; // member, no photo
    return false;
  }
  // ACTION REQUIRED prompt — a frosted banner of tappable links. Each link unlocks this card's shield;
  // a link with href also forwards to that member's tab (add photo / add name) via ROLLER's blue pill.
  function addActionReq(w, cardId, actions, heading, sub, mm) {
    var el = w.querySelector('.rcz-actreq');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-actreq'; w.appendChild(el); }
    var cls = 'rcz-actreq' + (mm ? ' rcz-actreq--mm' : '');   // --mm: wrappable heading + "or"-joined links
    if (el.className !== cls) el.className = cls;
    var hd = heading == null ? CFG.WARN_HEADING : heading;
    var sb = sub == null ? CFG.WARN_SUB : sub;   // pass '' to drop the sub-line (e.g. the mismatch action box)
    var linkEls = actions.map(function (a) {
      return '<a href="#" data-rcz-unlock="' + esc(cardId) + '"' + (a.kind ? ' data-rcz-act="' + esc(a.kind) + '"' : '') + (a.href ? ' data-rcz-href="' + esc(a.href) + '"' : '') + (a.ticket ? ' data-rcz-ticket="1"' : '') + (a.photonav ? ' data-rcz-photonav="1"' : '') + '>' + esc(a.label) + '</a>';
    });
    // the mismatch box joins its two choices with a same-size "or": ADD TICKET or PASS NICKNAME
    var links = mm ? linkEls.join('<span class="rcz-actreq__or">or</span>') : linkEls.join('');
    var html = '<div class="rcz-actreq__hd">' + esc(hd) + '</div>' +
               (sb ? '<div class="rcz-actreq__sub">' + esc(sb) + '</div>' : '') +
               '<div class="rcz-actreq__links">' + links + '</div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrActionReq(w) { var el = w.querySelector('.rcz-actreq'); if (el) el.remove(); }
  // Name-comparison block for a name-mismatch tile — Booking: <ticket name> over Membership: <member name>,
  // so staff can see whether it's a nickname, a spelling slip, or a genuinely different person. Replaces the
  // ticket type + name at bottom-right (so the age type is intentionally dropped on these tiles).
  function mismatchNamesFor(w, info, cardId) {
    if (!info || info.pending) return null;
    if (info.mismatch || info.closematch) return { t: info.ticketName, m: info.memberName };
    if (info.member && !info.family && !info.misaligned && !info.paidMember && !info.visiting) {
      var pm = pillMismatchCheck(w, cardId);
      if (pm) return { t: pm.ticketName, m: pm.memberName };
    }
    return null;
  }
  function addMismatchNames(w, ticketName, memberName) {
    w.classList.add('rcz-mmnames-on');
    var el = w.querySelector('.rcz-mmnames');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-mmnames'; w.appendChild(el); }
    var html = '<div class="rcz-mmnames__row"><span class="rcz-mmnames__lbl">Booking:</span><span class="rcz-mmnames__val">' + esc(ticketName || '?') + '</span></div>' +
               '<div class="rcz-mmnames__row"><span class="rcz-mmnames__lbl">Membership:</span><span class="rcz-mmnames__val">' + esc(memberName || '?') + '</span></div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrMismatchNames(w) { w.classList.remove('rcz-mmnames-on'); var el = w.querySelector('.rcz-mmnames'); if (el) el.remove(); }
  // Fix #1: the NAME-action box (ACTION REQUIRED · ADD TICKET / PASS NICKNAME), a second frosted card stacked
  // above the ADD PHOTO box so a no-photo close/mismatch tile still surfaces the name issue. Links unlock the shield.
  // Inner HTML of a name-mismatch box: a dismiss X (top-right), the FRAUD heading, and ONE bordered
  // "ADD A TICKET FOR <NAME>" button. X carries data-rcz-act="nickname" (old PASS NICKNAME: dismiss + unlock);
  // the button carries data-rcz-act="addticket" (old ADD TICKET: fire Add items + dismiss + unlock). The
  // existing click handler drives both, so no behaviour changes — only the presentation.
  function mmBoxInner(cardId, ticketName, withSub) {
    var nm = String(ticketName || '').toUpperCase();
    return '<a href="#" class="rcz-mmx" data-rcz-unlock="' + esc(cardId) + '" data-rcz-act="nickname" title="Dismiss">×</a>' +
           '<div class="rcz-actreq__hd">' + esc(CFG.MISMATCH_ACTREQ_HD) + '</div>' +
           (withSub ? '<div class="rcz-actreq__sub">' + esc(CFG.MISMATCH_ACTREQ_SUB) + '</div>' : '') +
           '<div class="rcz-actreq__links"><a href="#" class="rcz-mmbtn" data-rcz-unlock="' + esc(cardId) + '" data-rcz-act="addticket">ADD A TICKET FOR ' + esc(nm) + '</a></div>';
  }
  // main name-mismatch box (photo tiles + no-photo hard mismatch): the frosted .rcz-actreq--mm
  function addMismatchBox(w, cardId, ticketName) {
    var el = w.querySelector('.rcz-actreq');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-actreq'; w.appendChild(el); }
    if (el.className !== 'rcz-actreq rcz-actreq--mm') el.className = 'rcz-actreq rcz-actreq--mm';
    var html = mmBoxInner(cardId, ticketName, true);   // hard-mismatch box gets the "check photo" sub-line
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  // stacked name-mismatch box for a no-photo close-match (sits above the ADD PHOTO box)
  function addNameAct(w, cardId, ticketName) {
    var el = w.querySelector('.rcz-nameact');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-nameact'; w.appendChild(el); }
    var html = mmBoxInner(cardId, ticketName);
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrNameAct(w) { var el = w.querySelector('.rcz-nameact'); if (el) el.remove(); }
  // red wash over the photo while a FRAUD name-mismatch box is showing on a photo tile
  function addMmVeil(w) { if (!w.querySelector('.rcz-mmveil')) { var v = document.createElement('div'); v.className = 'rcz-mmveil'; w.appendChild(v); } }
  function clrMmVeil(w) { var v = w.querySelector('.rcz-mmveil'); if (v) v.remove(); }
  // #2: snooze a card's prompts + shield for 2 minutes when staff acknowledge a name issue (ADD TICKET /
  // PASS NICKNAME) or clear the visiting-photo handoff. When it lapses, a re-render restores prompt + lock.
  function snoozedName(cardId) { return !!(state.snoozeName && state.snoozeName[cardId] > Date.now()); }
  function snoozedPhoto(cardId) { return !!(state.snoozePhoto && state.snoozePhoto[cardId] > Date.now()); }
  function snoozeName(cardId) { if (!cardId) return; if (!state.snoozeName) state.snoozeName = {}; state.snoozeName[cardId] = Date.now() + 120000; setTimeout(function () { try { render(); } catch (e) {} }, 120200); }
  function snoozePhoto(cardId) { if (!cardId) return; if (!state.snoozePhoto) state.snoozePhoto = {}; state.snoozePhoto[cardId] = Date.now() + 120000; setTimeout(function () { try { render(); } catch (e) {} }, 120200); }
  // the two INDEPENDENT gates a member tile can hold: a NAME issue (mismatch/close/family) and a PHOTO need.
  // Acknowledging one never satisfies the other — so PASS NICKNAME clears the name prompt but leaves ADD PHOTO.
  function nameGate(info) { return !!(info && !info.pending && (info.mismatch || info.family || info.closematch)); }
  function photoGate(w, info) { return !!(info && !info.pending && info.member && !info.misaligned && !info.paidMember && !w.querySelector('img.rcz-photo')); }
  // Fire ROLLER's own "Add items" control (same as clicking the Add items link in the booking panel).
  function clickAddItems() {
    var els = document.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').replace(/add_circle/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === 'add items') { els[i].click(); return true; }
    }
    return false;
  }
  // #4: full-screen blocking handoff prompt, shown once when staff return to the booking screen after adding
  // a photo for a visiting-from-another-museum member. Cleared only by the CONFIRMED, DONE! button.
  function showHandoffModal(id, cardId) {
    if (document.getElementById('rcz-handoff-modal')) return;
    if (!document.getElementById('rcz-handoff-css')) {
      var css = document.createElement('style'); css.id = 'rcz-handoff-css';
      css.textContent = [
        '.rcz-ho-scrim{position:fixed !important;inset:0 !important;z-index:2147483000 !important;background:rgba(16,19,27,.58) !important;-webkit-backdrop-filter:blur(3px) !important;backdrop-filter:blur(3px) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:24px !important;font-family:Roboto,Arial,sans-serif !important;}',
        '.rcz-ho-card{width:520px !important;max-width:100% !important;background:#fff !important;border-radius:20px !important;box-shadow:0 24px 70px rgba(0,0,0,.4) !important;padding:34px 34px 28px !important;text-align:center !important;position:relative !important;overflow:hidden !important;}',
        '.rcz-ho-card:before{content:"" !important;position:absolute !important;left:0 !important;right:0 !important;top:0 !important;height:5px !important;background:linear-gradient(90deg,#b4308f,#8a2470) !important;}',
        '.rcz-ho-eyebrow{font-size:20px !important;letter-spacing:.10em !important;text-transform:uppercase !important;color:#b4308f !important;font-weight:800 !important;margin:6px 0 14px !important;}',
        '.rcz-ho-h1{font-size:25px !important;line-height:1.15 !important;color:#1c222b !important;font-weight:800 !important;margin:0 0 12px !important;}',
        '.rcz-ho-body{font-size:16px !important;line-height:1.5 !important;color:#69727e !important;margin:0 auto 26px !important;max-width:40ch !important;}',
        '.rcz-ho-body b{color:#1c222b !important;font-weight:600 !important;}',
        '.rcz-ho-idbox{max-width:360px !important;margin:0 auto 26px !important;background:#f4f6f8 !important;border:1px solid #e2e6ec !important;border-radius:12px !important;padding:13px 16px !important;}',
        '.rcz-ho-lbl{font-size:10.5px !important;letter-spacing:.14em !important;text-transform:uppercase !important;color:#69727e !important;font-weight:700 !important;margin:0 0 5px !important;}',
        '.rcz-ho-val{font-family:ui-monospace,Menlo,Consolas,monospace !important;font-size:24px !important;font-weight:600 !important;color:#1c222b !important;line-height:1.2 !important;}',
        '.rcz-ho-btn{-webkit-appearance:none !important;appearance:none !important;border:none !important;cursor:pointer !important;width:100% !important;padding:15px 20px !important;border-radius:13px !important;background:#b4308f !important;color:#fff !important;font:800 16px/1 Roboto,Arial,sans-serif !important;box-shadow:0 4px 14px rgba(138,36,112,.34) !important;}',
        '.rcz-ho-btn:hover{filter:brightness(1.05) !important;}'
      ].join('');
      (document.head || document.documentElement).appendChild(css);
    }
    var scrim = document.createElement('div'); scrim.id = 'rcz-handoff-modal'; scrim.className = 'rcz-ho-scrim';
    scrim.setAttribute('role', 'dialog'); scrim.setAttribute('aria-modal', 'true');
    scrim.innerHTML = '<div class="rcz-ho-card">' +
      '<div class="rcz-ho-eyebrow">Visiting member · photo added</div>' +
      '<div class="rcz-ho-h1">One more step before you move on</div>' +
      '<div class="rcz-ho-body">Please <b>send a WhatsApp message the admin team quoting the below</b>, so that the photo you\'ve taken can be transferred to the member\'s profile.</div>' +
      '<div class="rcz-ho-idbox"><div class="rcz-ho-lbl">Quote this</div><div class="rcz-ho-val">MEMBER PHOTO ' + esc(id) + '</div></div>' +
      '<button type="button" class="rcz-ho-btn">CONFIRMED, DONE!</button>' +
      '</div>';
    document.body.appendChild(scrim);
    var b = scrim.querySelector('.rcz-ho-btn');
    if (b) b.addEventListener('click', function () { scrim.remove(); if (cardId) { snoozePhoto(cardId); try { render(); } catch (e) {} } });
  }
  // The two things a member card can require before check-in, as ACTION REQUIRED links (#6): ADD NAME (for a
  // family slot with no individual name) and/or ADD PHOTO (no photo on file). ADD NAME forwards to the Guest
  // tab (kind 'name'); ADD PHOTO opens ROLLER's native verification panel in place (kind 'photo', see #3).
  function memberActions(w, info, cardId, hasPhoto) {
    var acts = [];
    if (info.family) acts.push({ label: 'ADD NAME', kind: 'name', href: memHref(info, cardId) });
    if (!hasPhoto)   acts.push({ label: 'ADD PHOTO', kind: 'photo', href: memHref(info, cardId), ticket: !!info.visiting });
    return acts;
  }
  // Open ROLLER's own "Verify membership discount(s)" panel (the right-sliding photo-capture dialog) by
  // clicking the Verify button in its banner — reveals image capture in place, no navigation. Works for
  // visiting members too (booking-level, no pill needed). Returns true if the button was found + clicked.
  function openVerifyPanel() {
    var banner = document.getElementById('booking-membership-verification-banner');
    var btn = banner ? banner.querySelector('button') : null;
    if (!btn) {
      var all = document.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) { if ((all[i].textContent || '').trim() === 'Verify') { btn = all[i]; break; } }
    }
    if (btn) { btn.click(); return true; }
    return false;
  }
  // ---- membership card treatment (photo fill + "Membership Found" panel) ----
  function renderMembership(w, host) {
    var btn = w.querySelector('button[id^="booking-details-button-"]');
    if (btn) {
      // ROLLER's photo sits inside the button's label span (only ~240px). Grab its src, hide it, and
      // paint our own img as a DIRECT child of the button so width/height:100% fills the whole square.
      var roller = btn.querySelector('img:not(.rcz-photo)');
      var src = roller ? roller.getAttribute('src') : null;
      if (roller) roller.style.display = 'none';
      var icon = btn.querySelector('mat-icon'); if (icon) icon.style.display = 'none';
      if (src) {
        var img = btn.querySelector('img.rcz-photo');
        if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      }
    }
    clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w);
    // NB: do NOT clrActionReq here — that would destroy the ADD PHOTO box (and its <a>) on every
    // render (~7x/s), so a human finger-tap spanning a re-render gets its click cancelled. Let the
    // idempotent addActionReq below reuse the existing box; only clear it when a photo now exists.
    var info = membershipInfo(host);
    ensureBotBar(w);
    var mHasPhoto = !!w.querySelector('img.rcz-photo');
    paintStatus(w, 'Matched', false, mHasPhoto ? 'Showing' : 'Required Today', !mHasPhoto);
    addMemStrip(w, info.uses);                                       // dark "MEMBERSHIP: N USES" strip
    addBadge(w, membershipTier(host));
    // (Which membership tiles lose their check-in tick is decided by SECTION, not tier — see
    // tagProfileOnlyCards(): only tiles under the "MEMBERSHIP PROFILES ONLY" / OPEN ITEMS header, all tiers.)
    addMemName(w, info.type, info.first);
    // FRAUD WARNING / ADD PHOTO on a membership-search card that has no photo (same as the booking tiles)
    var _mpc = btn ? btn.id.replace('booking-details-button-', '') : null;
    if (!mHasPhoto && _mpc) addActionReq(w, _mpc, [{ label: 'ADD PHOTO', kind: 'photo', photonav: true }]);
    else clrActionReq(w);
    var oldPanel = w.querySelector('.rcz-mem-info'); if (oldPanel) oldPanel.remove();  // drop old Starts/Ends panel
    // Birthday flag — top-right, same as ticket cards
    var memCardId = btn ? btn.id.replace('booking-details-button-', '') : null;
    var mbm = memCardId ? state.birthdays[memCardId] : null;
    if (CFG.SHOW_BIRTHDAY && mbm && birthdayInWindow(mbm)) { addBirthday(w, mbm); var mbd = w.querySelector('.rcz-bday'); if (mbd) mbd.style.top = bdayTop(w); }
    else clrBirthday(w);
  }
  function addMemInfo(w, startStr, endStr, uses) {
    var el = w.querySelector('.rcz-mem-info');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-mem-info'; w.appendChild(el); }
    var html = '<div class="rcz-mem-info__hd">' + esc(CFG.MEM_TITLE) + (uses ? ' (' + esc(uses) + ')' : '') + '</div>' +
               '<div class="rcz-mem-info__row">Starts: <b>' + esc(startStr) + '</b></div>' +
               '<div class="rcz-mem-info__row">Ends: <b>' + esc(endStr) + '</b></div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function addMemName(w, type, first) {
    var el = w.querySelector('.rcz-mem-name');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-mem-name'; w.appendChild(el); }
    var html = '<div class="rcz-mem-name__cat">' + esc(type || 'Member') + '</div><div class="rcz-mem-name__nm">' + esc(first || '') + '</div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function addMemStrip(w, uses) {
    var el = w.querySelector('.rcz-memstrip');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-memstrip'; w.appendChild(el); }
    var html = 'MEMBERSHIP' + (uses ? ': ' + esc(String(uses).toUpperCase()) : '');
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }

  function render() {
    try {
      injectGlobalStyle();
      hideRedeemButtons();
      labelRedeemNoPhoto();    // "PHOTO REQUIRED" warning on the grey no-photo tile in the Redeem-membership dialog (any route)
      adjustGuestsBooked();    // manage.roller.app dashboard: show Guests booked net of New memberships
      ensureFileUploadBtn();   // "Choose a photo file" beside ROLLER's camera capture (runs on the member/item detail pages too, so it's before the activeRoute gate)
      tagSearchRows();         // badge search-result rows MEMBERSHIP vs TICKETS (search list isn't the activeRoute, so before the gate)
      // On a membership PROFILE detail (member profile via search, or a membership item detail) tag <body> so
      // the CSS hides ROLLER's header check-in tick. Only membership headers (product name contains
      // "Membership") — plain ticket item details keep their tick.
      if (CFG.HIDE_MEMBER_TICK) { var _mh = /^\/search\/(memberships\/\d+\/\d+|bookings\/\d+\/\d+)/.test(location.pathname) ? document.querySelector('.bip-summary-header') : null; document.body.classList.toggle('rcz-hidetick', !!(_mh && /membership/i.test(_mh.textContent || ''))); }
      if (membershipDetailRoute()) ensureBackButtons(); else removeBackButtons();
      if (!activeRoute()) {
        // not the booking check-in list -> strip our styling/overlays so ROLLER's native pages work
        var st = document.getElementById('rcz-style'); if (st) st.remove();
        document.querySelectorAll('.rcz-alert, .rcz-casual, .rcz-mismatch, .rcz-visiting, .rcz-badge, .rcz-note, .rcz-bday, .rcz-meaning, .rcz-status, .rcz-actreq, .rcz-nameact, .rcz-botbar, .rcz-mem-info, .rcz-mem-name, .rcz-mmnames, .rcz-mmveil, .rcz-memstrip, img.rcz-photo').forEach(function (e) { e.remove(); });
        document.querySelectorAll('.rcz-alert-on, .rcz-casual-on, .rcz-mismatch-on, .rcz-visiting-on, .rcz-mmnames-on, .rcz-locked').forEach(function (w) { w.classList.remove('rcz-alert-on', 'rcz-casual-on', 'rcz-mismatch-on', 'rcz-visiting-on', 'rcz-mmnames-on', 'rcz-locked'); });
        document.querySelectorAll('app-bip-summary.rcz-mem, app-bip-summary.rcz-skip').forEach(function (h) { h.classList.remove('rcz-mem', 'rcz-skip'); });
        document.querySelectorAll('app-bip-summary:not(.rcz-skip) button[id^="booking-details-button-"] mat-icon').forEach(function (ic) { ic.style.display = ''; });
        // A VISITING (other-museum) member's photo does NOT sync back to their home venue, so staff must ALWAYS
        // be reminded to send it to admin — not only when they used our ADD PHOTO link. Arm the handoff whenever
        // they're on such a member's photo tab by ANY route (ADD PHOTO, the "Choose a photo file" button, or
        // manual navigation). The promote-to-ready line + fire-on-return then show the reminder back on the
        // booking. state.byCard (keyed by bookingItemPartId) persists across the in-app nav from the booking.
        try {
          var _vm = location.pathname.match(/^\/search\/bookings\/(\d+)\/(\d+)/);
          if (_vm && document.querySelector('.image-capture')) {
            var _vc = state.byCard[_vm[2]], _mine = _vm[1] + ':' + _vm[2], _cur = sessionStorage.getItem('rcz-handoff') || '';
            if (_vc && _vc.visiting && _cur.indexOf(_mine) < 0) sessionStorage.setItem('rcz-handoff', 'armed:' + _mine);
          }
        } catch (e) {}
        // #4: we've left the booking screen (e.g. onto the photo tab) -> promote an armed handoff to "ready"
        try { var _hf = sessionStorage.getItem('rcz-handoff'); if (_hf && _hf.indexOf('armed:') === 0) sessionStorage.setItem('rcz-handoff', 'ready:' + _hf.slice(6)); } catch (e) {}
        return;
      }
      injectStyle();
      retextMissingPhotosBanner();   // reword ROLLER's native "Missing member photos" banner sub-line
      retextSectionPills();          // relabel ROLLER's grey section pills ("OPEN ITEMS", "TODAY")
      // #4: back on the booking screen with a "ready" handoff for THIS booking -> fire the modal once
      try { var _hv = sessionStorage.getItem('rcz-handoff'), _hb = (location.pathname.match(/\/bookings\/(\d+)/) || [])[1]; if (_hv && _hb && _hv.indexOf('ready:' + _hb + ':') === 0) { var _hc = _hv.slice(('ready:' + _hb + ':').length); sessionStorage.removeItem('rcz-handoff'); showHandoffModal(_hb, _hc); } } catch (e) {}
      markSkips();
      ensureShields();
      shorten();
      tagProfileOnlyCards();   // hide the check-in tick on membership tiles under "MEMBERSHIP PROFILES ONLY" (needs .rcz-mem from markSkips)
      toggleBulkCheckinBtn();  // hide the blue bulk "check (N)" button when a membership profile is selected
      state.memLinks = membershipLinkMap();  // member name -> detail URL, scraped from the discounts panel
      state.isParty = CFG.FLAG_PARTY_GUESTS && rczIsPartyBooking();  // party booking? -> tiles label admission guests "Party Guest"
      document.querySelectorAll('app-bip-summary:not(.rcz-skip) .summary__wrapper').forEach(function (w) {
        var memHost = w.closest('app-bip-summary');
        if (memHost && memHost.classList.contains('rcz-mem')) { renderMembership(w, memHost); return; }
        var btn = w.querySelector('button[id^="booking-details-button-"]'); if (!btn) return;
        var cardId = btn.id.replace('booking-details-button-', '');
        var info = state.byCard[cardId];
        // once staff have named this family slot (live pills), drop the "Add individual names" ask for it
        if (info && info.family && slotNamed(cardId)) info = Object.assign({}, info, { family: false });
        ensureBotBar(w);
        var icon = btn.querySelector('mat-icon');
        var img = btn.querySelector('img.rcz-photo');
        if (info && !info.pending && info.photo) {
          // member with a photo on file -> show the photo
          if (icon) icon.style.display = 'none';
          if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
          var url = CFG.CDN + info.photo;
          if (img.getAttribute('src') !== url) img.setAttribute('src', url);
          // guard: if the ticket-holder isn't a named member on the membership, flag it (keep the photo behind)
          var pm = (info.family || info.closematch || info.misaligned || info.paidMember) ? null : pillMismatchCheck(w, cardId);
          if (pm) {
            showMismatch(w, btn, icon, img, cardId, pm.memberName, pm.ticketName, info.tier);
          } else {
            addBadge(w, info.tier, memHref(info, cardId), info.visiting);
            clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w);
            // photo cards can carry a prompt: family -> "add name"; close name -> "confirm"; paid member ->
            // "discount mis-assigned, total still correct"
            memberNote(w, info, cardId);
          }
        } else if (info && info.misaligned) {
          // discount was mis-assigned to this non-member guest, but the booking total is correct. Don't
          // raise the alarming red NAME MIS-MATCH — present a normal casual booking tile, keeping the
          // reassurance banner up top to explain why they carry a member discount.
          if (img) img.remove();
          var xnm = holderNameFor(w, cardId);
          var xcat = ((w.querySelector('.summary-detail__item--emphasis') || {}).textContent || '').trim();
          addCasual(w, xnm, xcat); clrAlert(w); clrMismatch(w); clrVisiting(w); clrBadge(w); clrActionReq(w);
          addNote(w, 'misaligned');
        } else if (info && info.mismatch) {
          // member ticket whose name doesn't match its membership -> name-mismatch alert (dynamic note).
          // If we've fetched the membership holder's photo, show it BEHIND the text so staff can compare
          // the face to the person in front of them (e.g. is this "Teddy" actually the member "Theodore"?).
          if (info.photo) {
            if (icon) icon.style.display = 'none';
            if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
            var mmurl = CFG.CDN + info.photo;
            if (img.getAttribute('src') !== mmurl) img.setAttribute('src', mmurl);
          } else if (img) { img.remove(); }
          var mem = '<b>' + esc((info.memberName || 'another member').toUpperCase()) + '</b>';
          var tk = esc(info.ticketName || 'this guest');
          var note = esc(CFG.MISMATCH_NOTE_TMPL).split('{MEMBER}').join(mem).split('{TICKET}').join(tk);
          clrMismatch(w); addMismatchBox(w, cardId, info.ticketName); clrAlert(w); clrCasual(w); clrVisiting(w); clrNote(w); if (info.tier) addBadge(w, info.tier, memHref(info, cardId), info.visiting); else clrBadge(w);
        } else if (info && !info.pending && info.member) {
          // NOTE: visiting members (visiting from another museum) deliberately fall through to here rather
          // than having their own branch. They used to be handled above with hasPhoto hard-coded to false,
          // which meant no amount of photo-taking could ever satisfy the prompt: their membership lives at
          // another venue, so our /get-membership lookup returns no imageFileName, and the photo staff take
          // lands on the TICKET instead. The nativePhotoImg() check below is exactly the fix for that — it
          // reads the photo ROLLER itself is rendering. The old branch was character-for-character identical
          // to the no-photo path below, so nothing changes for a visiting member who genuinely has no photo.
          var np = nativePhotoImg(btn);
          if (np) {
            // our membership lookup returned no photo, but ROLLER is already showing a real photo for this
            // member -> treat as photo-on-file: fill the square with it + badge, and DON'T raise the alert.
            if (icon) icon.style.display = 'none';
            np.style.display = 'none';
            if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
            var nsrc = np.getAttribute('src');
            if (img.getAttribute('src') !== nsrc) img.setAttribute('src', nsrc);
            // ...and never name-check a VISITING member: their blue pill carries a membership ID, not a
            // name, so pillFirsts holds an ID that no ticket-holder can ever match — every visiting member
            // with a photo would be branded an interloper. Nothing to compare, so don't compare.
            var pmn = (info.family || info.closematch || info.misaligned || info.paidMember || info.visiting) ? null : pillMismatchCheck(w, cardId);
            if (pmn) {
              showMismatch(w, btn, icon, img, cardId, pmn.memberName, pmn.ticketName, info.tier);
            } else {
              addBadge(w, info.tier, memHref(info, cardId), info.visiting);
              clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w);
              memberNote(w, info, cardId);
            }
          } else {
            // matched member, genuinely no photo on file -> "requires photo" alert
            if (img) img.remove();
            clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); addActionReq(w, cardId, memberActions(w, info, cardId, false)); if (info.tier) addBadge(w, info.tier, memHref(info, cardId), info.visiting); else clrBadge(w);
          }
        } else if (info && !info.pending && info.member === false) {
          // casual (non-member) OR foster-care partner -> plain tile with a bottom-left tag. Foster guests
          // get the "Foster CARE Ticket" tag in place of "Casual Guest"; everything else is identical.
          // Edge case: a casual can still carry a photo (e.g. mid-upgrade to membership, where the captured
          // membership photo is attached to their guest profile). If so, show that photo full-bleed like a
          // member tile and drop the big age label (gated below) instead of painting the label over the photo.
          var cnp = nativePhotoImg(btn);
          if (cnp) {
            if (icon) icon.style.display = 'none';
            cnp.style.display = 'none';
            if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
            var csrc = cnp.getAttribute('src');
            if (img.getAttribute('src') !== csrc) img.setAttribute('src', csrc);
          } else if (img) { img.remove(); }
          var cnm = holderNameFor(w, cardId);
          var ccat = ((w.querySelector('.summary-detail__item--emphasis') || {}).textContent || '').trim();
          addCasual(w, cnm, ccat, info.fosterCare ? CFG.FOSTER_LABEL : ((CFG.FLAG_PARTY_GUESTS && state.isParty) ? CFG.PARTY_GUEST_LABEL : null)); clrAlert(w); clrMismatch(w); clrVisiting(w); clrNote(w); clrBadge(w); clrActionReq(w);
        } else {
          // still loading / unknown -> plain placeholder, no overlay
          if (img) img.remove();
          if (icon) icon.style.display = '';
          clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); clrBadge(w); clrActionReq(w);
        }
        // age-type icon on casual / foster tiles (#2), chosen by ticket type; cleared on member/other tiles
        if (info && !info.pending && info.member === false && !w.querySelector('img.rcz-photo')) {
          setAgeText(btn, ((w.querySelector('.summary-detail__item--emphasis') || {}).textContent || ''), holderNameFor(w, cardId));
        } else { clrAgeText(btn); }
        // #8/#9: when a member ticket recorded no name, surface the membership member's name at the bottom.
        // Only fill an empty holder label (or one we previously filled) — never overwrite a real name ROLLER
        // supplied; and clear our injected name if the card no longer carries one.
        var hw = w.querySelector('.summary-detail__item-holder-wrapper');
        if (hw) {
          if (info && info.displayName && (!hw.textContent.trim() || hw.hasAttribute('data-rcz-name'))) {
            if (hw.getAttribute('data-rcz-name') !== info.displayName) { hw.textContent = info.displayName; hw.setAttribute('data-rcz-name', info.displayName); }
          } else if (hw.hasAttribute('data-rcz-name') && (!info || !info.displayName)) {
            hw.textContent = ''; hw.removeAttribute('data-rcz-name');
          }
        }
        // #6: when a mismatch banner and an ACTION REQUIRED block coexist, lift the ACTION REQUIRED ~100px
        // so the two stack clearly instead of overlapping (position is easy to tweak later).
        var _mm = w.querySelector('.rcz-mismatch'), _ar = w.querySelector('.rcz-actreq');
        if (_ar) _ar.style.bottom = _mm ? '176px' : '';
        // Fix #1: no-photo close-match member -> stack the NAME-action box above the ADD PHOTO box (_ar)
        if (info && !info.pending && info.closematch && !w.querySelector('img.rcz-photo')) {
          addNameAct(w, cardId, info.ticketName);
          var _na = w.querySelector('.rcz-nameact');
          if (_na && _ar) _na.style.setProperty('bottom', ((_mm ? 176 : 76) + _ar.offsetHeight + 8) + 'px', 'important');
        } else { clrNameAct(w); }
        // --- status band + prototype extras, independent of the card state above ---
        var si = statusInfo(w, info);
        if (si) paintStatus(w, si.nm, si.nmW, si.ph, si.phW);
        else if (info && !info.pending && info.member === false && !info.misaligned) paintStatusEmpty(w); // casual/foster: blank band for tile consistency
        else clrStatus(w);
        if (!state.unlocked) state.unlocked = {};
        // #2: name-ack hides ONLY the name prompt (overlay + ACTION REQUIRED/name box) and keeps the photo
        // requirement; photo-ack (visiting handoff) hides ONLY the ADD PHOTO box. Each gate locks on its own.
        if (snoozedName(cardId)) { clrNameAct(w); clrMismatch(w); if (!photoGate(w, info)) clrActionReq(w); }
        if (snoozedPhoto(cardId)) clrActionReq(w);
        // A missing photo warns but no longer blocks (CFG.LOCK_ON_MISSING_PHOTO) — staff must be able to
        // check a member in and let the documented cancellation flag do its job. A NAME issue still locks.
        var _photoLock = CFG.LOCK_ON_MISSING_PHOTO && photoGate(w, info) && !snoozedPhoto(cardId);
        w.classList.toggle('rcz-locked', !state.unlocked[cardId] && ((nameGate(info) && !snoozedName(cardId)) || _photoLock));
        // name-mismatch tiles: replace the type+name at bottom-right with the Booking/Membership comparison
        var _mmn = mismatchNamesFor(w, info, cardId);
        if (_mmn) addMismatchNames(w, _mmn.t, _mmn.m); else clrMismatchNames(w);
        // red wash over the photo while a FRAUD name-mismatch box is showing on a photo tile
        if (w.querySelector('.rcz-actreq--mm') && w.querySelector('img.rcz-photo')) addMmVeil(w); else clrMmVeil(w);
        var bm = state.birthdays[cardId];
        if (CFG.SHOW_BIRTHDAY && bm && birthdayInWindow(bm)) {
          addBirthday(w, bm);
          var bd = w.querySelector('.rcz-bday');
          if (bd) bd.style.top = bdayTop(w);
        } else clrBirthday(w);
        if (CFG.SHOW_NAME_MEANING) {
          var lnm = ((w.querySelector('.summary-detail__item-holder-wrapper') || {}).textContent || '');
          var mng = nameMeaning(lnm);
          if (mng) addMeaning(w, mng); else clrMeaning(w);
        } else clrMeaning(w);
      });
    } catch (e) {}
  }

  /* ======================================================================
     BOOT
     ====================================================================== */
  // A plain <a href> we inject does a FULL page load. ROLLER's own blue discount pill is a routerLink,
  // so it navigates in-app (fast, no reload). To match that, intercept a normal left-click on our tier
  // link and forward it to the matching blue pill — reusing ROLLER's router for a soft SPA navigation.
  // Modifier/middle clicks and new-tab mode are left alone so "open in new tab" still works.
  // forward a click to ROLLER's own blue member-pill for that href (soft in-app nav). returns true if done.
  function forwardToPill(href) {
    if (!href) return false;
    var pills = document.querySelectorAll('a[id^="membership-discount-link-"]');
    for (var i = 0; i < pills.length; i++) { if (pills[i].getAttribute('href') === href) { pills[i].click(); return true; } }
    return false;
  }
  // After we forward to a membership because a photo is REQUIRED, land staff straight on the "Guest" tab
  // (that's where the "Click to take a photo" control lives) instead of the default "Membership" tab. The
  // membership detail renders async after the soft nav, so poll for ROLLER's Guest tab (a stable id) and
  // click it once it's present + wired. Stop as soon as it's selected (so we never fight a manual switch),
  // or after a short timeout if it never appears. Tabs: Guest = bip-detail-tab-customer, Membership = ...-ticket.
  /* ---------------------------------------------------------------------
     TAB-FLICKER RECORDER
     Built around what was actually measured on the live POS (2026-07-31):
     our loop clicks Guest ONCE and stops, and ROLLER then flips the tab 100+
     times with nobody clicking — while the SAME single click with this script
     disabled is stable at any timing. So the number that matters is how many
     transitions land AFTER our loop has stopped: that separates "we're
     hammering the tab" from "we poked it once and it went unstable by itself".

     Deliberately NOT another MutationObserver — an extra observer is more of
     exactly what we suspect provokes Angular's change detection. This samples
     on a timer, only while a switch is in progress, and then stops.
     --------------------------------------------------------------------- */
  var TAB_TRACE_KEY = 'rcz-tabtrace';
  var SCRIPT_VERSION = (function () { try { return GM_info.script.version; } catch (e) { return 'unknown'; } })();
  function selectedTabName() {
    var g = document.getElementById('bip-detail-tab-customer');
    if (g && g.getAttribute('aria-selected') === 'true') return 'Guest';
    var m = document.getElementById('bip-detail-tab-ticket');
    if (m && m.getAttribute('aria-selected') === 'true') return 'Membership';
    return null;
  }
  function newTabTrace(withCamera) {
    return { version: SCRIPT_VERSION, at: new Date().toISOString(), path: location.pathname,
             withCamera: !!withCamera, clicks: 0, flips: [], flipCount: 0, flipsAfterStop: 0, stoppedAt: null };
  }
  function watchTabFlicker(trace) {
    if (!CFG.TAB_TRACE) return;
    var t0 = Date.now(), last = selectedTabName();
    var iv = setInterval(function () {
      try {
        var ms = Date.now() - t0, cur = selectedTabName();
        if (cur !== last) {
          last = cur; trace.flipCount++;
          if (trace.stoppedAt != null) trace.flipsAfterStop++;
          if (trace.flips.length < 60) {
            trace.flips.push(ms + 'ms -> ' + (cur || 'none') + (trace.stoppedAt != null ? '  [after our loop stopped]' : ''));
          }
        }
        if (ms > 12000) { clearInterval(iv); saveTabTrace(trace); }
      } catch (e) { clearInterval(iv); }
    }, 150);
  }
  function saveTabTrace(trace) {
    if (trace.flipCount < 12) return;                 // a healthy switch is 1-3 transitions; ignore those
    trace.verdict = trace.flipsAfterStop > 6
      ? 'ROLLER kept flipping AFTER our loop stopped -> trigger is our presence, not our clicking'
      : 'flips happened while our loop was still running -> we may be hammering the tab';
    try { localStorage.setItem(TAB_TRACE_KEY, JSON.stringify(trace)); } catch (e) {}
    try { console.warn('[rcz] Guest-tab flicker captured — run rczTabTrace() to print it'); } catch (e) {}
  }
  // Console accessor, so a venue can hand us the capture from any later session with one command.
  try {
    window.rczTabTrace = function () {
      var raw = null; try { raw = localStorage.getItem(TAB_TRACE_KEY); } catch (e) {}
      if (!raw) { console.log('[rcz] no flicker captured yet'); return null; }
      var t = JSON.parse(raw);
      console.log('[rcz] Guest-tab flicker capture\n' + [
        'script version   : ' + t.version,
        'when             : ' + t.at,
        'path             : ' + t.path,
        'withCamera       : ' + t.withCamera,
        'clicks WE issued : ' + t.clicks,
        'tab changes      : ' + t.flipCount + '   (after our loop stopped: ' + t.flipsAfterStop + ')',
        'our loop stopped : ' + (t.stoppedAt == null ? 'never — ran to its cap' : t.stoppedAt + 'ms in'),
        'verdict          : ' + t.verdict, '', t.flips.join('\n')].join('\n'));
      return t;
    };
  } catch (e) {}

  var _guestTabIv = null;     // module-level so two link-throughs can never run overlapping switch loops
  var _guestTabRun = 0;       // generation counter — only the CURRENT run may stop the loop or drop the cover
  var _guestTabOnUser = null; // the live run's pointerdown listener, so a new run can unhook the old one
  // Full-screen "Opening camera…" cover. ROLLER re-asserts its default Membership tab several times in the
  // first ~3s of load, so getting to the Guest tab + camera involves visible tab flip-flop ("glitchy"). We
  // hide that whole journey behind this cover and only lift it once the live camera is actually up.
  function photoCover(on) {
    var m = document.getElementById('rcz-photocover');
    if (on) {
      if (!m && document.body) {
        m = document.createElement('div'); m.id = 'rcz-photocover';
        m.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:#f4f5f7;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font:600 17px/1.3 Roboto,Arial,sans-serif;color:#6b7280;');
        m.innerHTML = '<div style="width:34px;height:34px;border:3px solid #d1d5db;border-top-color:#6b7280;border-radius:50%;animation:rczspin 0.8s linear infinite;"></div><div>Opening camera…</div><style>@keyframes rczspin{to{transform:rotate(360deg)}}</style>';
        document.body.appendChild(m);
      }
    } else if (m) { m.remove(); }
  }
  // Get staff onto the member's Guest (photo) tab after an ADD PHOTO / link-through, holding it through
  // ROLLER's tab resets. With withCamera, once Guest is stable a beat we pre-click ROLLER's "Click to take a
  // photo" tile so staff land straight on the live camera — the whole flippy journey hidden behind the cover.
  function openGuestTabSoon(withCamera) {
    if (!CFG.AUTO_GUEST_TAB) return;   // stopped fighting ROLLER's tabs: no tab-push, no auto-camera, no cover — staff pick the Guest tab + Capture themselves
    if (_guestTabIv) { clearInterval(_guestTabIv); _guestTabIv = null; }  // never run two overlapping loops
    // Unhook the PREVIOUS run's pointerdown listener. Clearing the interval above never removed it, so it
    // stayed attached for the rest of the session. On the next member a leftover listener still fires, judges
    // the page by ITS OWN (stale) withCamera mode, and calls ITS stop() — which clears _guestTabIv, by then
    // the CURRENT run's interval, and lifts the CURRENT run's cover. Leftovers accumulate one per ADD PHOTO,
    // which is why later members on the same booking behaved worse than the first.
    if (_guestTabOnUser) { document.removeEventListener('pointerdown', _guestTabOnUser, true); _guestTabOnUser = null; }
    var myRun = ++_guestTabRun;
    var start = Date.now(), lastClick = 0, guestSince = 0, camDone = false;
    var trace = newTabTrace(withCamera);
    watchTabFlicker(trace);
    if (withCamera) photoCover(true);
    // Belt and braces on the same hazard: a superseded run must never tear down a newer one's state.
    function stop() {
      if (myRun !== _guestTabRun) return;                                  // superseded — not ours to stop
      if (trace.stoppedAt == null) trace.stoppedAt = Date.now() - start;   // recorder: everything after this is ROLLER's doing
      if (_guestTabIv) { clearInterval(_guestTabIv); _guestTabIv = null; }
      document.removeEventListener('pointerdown', onUser, true);
      if (_guestTabOnUser === onUser) _guestTabOnUser = null;
      photoCover(false);
    }
    // No camera to open (member already has a photo, or ROLLER never rendered the capture) -> drop staff on
    // ROLLER's normal Membership view (the regular path) rather than holding an empty Guest tab.
    function toMembershipAndStop() { var mem = document.getElementById('bip-detail-tab-ticket'); if (mem && mem.getAttribute('aria-selected') !== 'true') mem.click(); stop(); }
    // Non-camera nav: back off once staff engage the OPEN Guest tab. Camera flow is covered, so there staff
    // can't tap anything until the camera is up — only then does a tap (on Capture/Cancel) hand control back.
    function onUser() {
      if (withCamera) { if (document.querySelector('video')) stop(); }
      else { var g0 = document.getElementById('bip-detail-tab-customer'); if (g0 && g0.getAttribute('aria-selected') === 'true') stop(); }
    }
    document.addEventListener('pointerdown', onUser, true);
    _guestTabOnUser = onUser;
    var iv = setInterval(function () {
      if (myRun !== _guestTabRun) { clearInterval(iv); return; }            // a newer run took over
      try {
        var g = document.getElementById('bip-detail-tab-customer');
        if (g) {
          if (g.getAttribute('aria-selected') !== 'true') {
            // Not on Guest (initial load, or ROLLER flipped us back). Re-select it — rate-limited to ~450ms
            // so we never hammer (each click re-triggers ROLLER's async tab load, which is the flicker).
            guestSince = 0;
            if (Date.now() - lastClick > 450) { g.click(); trace.clicks++; lastClick = Date.now(); }
          } else if (!withCamera) {
            stop(); return;                                   // plain nav: on Guest, done
          } else {
            // On Guest and holding. The live camera being up is the finish line — lift the cover and stop.
            if (document.querySelector('video')) { stop(); return; }
            if (!guestSince) guestSince = Date.now();
            var stableFor = Date.now() - guestSince;
            if (stableFor > 700) {
              var cam = document.querySelector('button.image-capture__action-button');
              // open the capture (retry if a late ROLLER reset closed it); rate-limited
              if (cam) { if (Date.now() - lastClick > 450) { cam.click(); trace.clicks++; lastClick = Date.now(); camDone = true; } }
              // stable a good while with no camera control at all (e.g. member already has a photo) -> nothing
              // to capture; reveal what's there rather than sit behind the cover.
              else if (stableFor > 2200) { toMembershipAndStop(); return; }
            }
          }
        }
        // hard cap; cover always lifts on stop. If the camera never came up, send staff to the normal
        // Membership view rather than leaving them on a blank Guest tab.
        if (Date.now() - start > (withCamera ? 7000 : 4000)) { if (withCamera && !document.querySelector('video')) toMembershipAndStop(); else stop(); }
      } catch (e) { stop(); }
    }, 100);
    _guestTabIv = iv;
  }
  // After ROLLER's "Done" saves and pushes the parent account page (the child path minus its last /id),
  // step back past it AND the child edit page (history.go(-2)) so staff land back where they came from
  // (e.g. the booking check-in) instead of the parent membership page.
  function scheduleDoneReturn(childPath) {
    if (!/^\/search\/memberships\/\d+\/\d+/.test(childPath)) return;
    var parent = childPath.replace(/\/\d+\/?$/, '');
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (location.pathname === parent) { clearInterval(iv); backOutOfMemberships(0); }
      else if (tries > 30) clearInterval(iv);  // ~3s: Done was cancelled or navigated elsewhere
    }, 100);
  }
  // Keep stepping browser-back while we're still on any /search/memberships/ page, so we exit the whole
  // membership area (the parent account page Done pushes AND the child edit page) and land back on wherever
  // the user actually was before (e.g. the booking check-in) — robust to how many membership pages are
  // stacked in history and to whether the child was reached from a booking or from the parent page.
  function backOutOfMemberships(steps) {
    if (steps >= 6) return;                                          // safety cap
    if (!/^\/search\/memberships\//.test(location.pathname)) return; // escaped the membership area -> done
    var before = location.pathname;
    try { history.back(); } catch (e) { return; }
    setTimeout(function () { if (location.pathname !== before) backOutOfMemberships(steps + 1); }, 320);
  }

  /* ======================================================================
     UNDO CHECK-IN — tapping a shield that's already ticked
     ----------------------------------------------------------------------
     How ROLLER's own undo works (read out of the POS bundle at
     pos.roller.app, July 2026):

       • It is gated on a DEVICE setting, "Allow users to undo check-ins":
             canUndoCheckIn(bip) = deviceSettings.allowUndoCheckins
                                   && bip.allowsCheckingIn && bip.isUsed
         With that setting off there is no undo anywhere in the product.

       • The explicit control is a MULTI-SELECT action, not a per-ticket one:
         tick a ticket's checkbox -> the list header grows a "more actions"
         dropdown (#dropdown-more-actions) -> "Undo check-in (N)"
         (#dropdown-option-undo, rendered only when EVERY selected ticket can
         be undone) -> confirm modal "Undo check-in? / Yes, undo" ->
         bookingService.logAttendance(bips, false).

       • The per-ticket check button is a toggle, but only sometimes:
             checkIn() { n = (session && pass && pass.maxUses !== 1)
                               ? true            // <- always a CHECK-IN
                               : !isCheckedIn;   // <- toggles, so undoes
                         booking().setCheckedIn(n, [bip]); }
         On an ordinary ticket the second tap undoes. On a MULTI-USE PASS —
         which is every membership — n is forced true, so a second tap
         re-checks them in and logs a SECOND attendance. That's the trap our
         green shield was sitting on, and it would quietly inflate member
         check-in counts.

     So a ticked shield drives ROLLER's multi-select undo: same code path,
     same permission gate, same confirm modal — just started from one tap
     instead of checkbox + menu (our skin hides the checkbox). We do it for
     every ticket type rather than only members: one path is easier to reason
     about, and it removes any chance of the toggle firing a duplicate
     check-in on a pass we failed to recognise as one.

     If the native machinery can't be found we stop and say so — we never
     fall through to the raw button, because on a membership that silently
     double-counts the visit instead of undoing it.
     ====================================================================== */
  var undoBusy = false;   // one undo flow at a time; a second tap mid-flow is ignored

  // Transient message, bottom-centre. Only used when an undo CAN'T be completed — staff must never be
  // left with a tap that appears to do nothing.
  function undoToast(msg, ms) {
    var old = document.getElementById('rcz-toast'); if (old) old.remove();
    var t = document.createElement('div'); t.id = 'rcz-toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;' +
      'max-width:min(620px,92vw);background:#1c222b;color:#fff;font:600 15px/1.45 Roboto,Arial,sans-serif;' +
      'padding:15px 22px;border-radius:13px;box-shadow:0 10px 34px rgba(0,0,0,.42);text-align:center;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, ms || 7000);
  }
  // Poll for something ROLLER renders asynchronously; get() stays falsy until it's there.
  function pollFor(get, timeoutMs, done) {
    var start = Date.now();
    var iv = setInterval(function () {
      var v = null; try { v = get(); } catch (e) {}
      if (v) { clearInterval(iv); done(v); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); done(null); }
    }, 80);
  }
  // ROLLER renders the actions dropdown more than once (wide / narrow layouts) under the same id, so
  // getElementById isn't enough — take the copy actually on screen.
  function firstVisible(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null || nodes[i].getClientRects().length) return nodes[i];
    }
    return nodes[0] || null;
  }
  function clickTarget(el) { return !el ? null : (el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el)); }
  // Material puts the bound id on the mat-checkbox host and "<id>-input" on the control it wraps.
  function inputOf(el) { return !el ? null : (el.tagName === 'INPUT' ? el : el.querySelector('input[type="checkbox"]')); }
  function bipCheckboxInput(cardId) {
    var base = 'booking-details-checkbox-' + cardId;
    return inputOf(document.getElementById(base)) || inputOf(document.getElementById(base + '-input'));
  }
  // Our CSS hides these checkboxes, but a hidden input still toggles and fires (change) on .click().
  function setBipSelected(cardId, want) {
    var input = bipCheckboxInput(cardId); if (!input) return false;
    if (!!input.checked !== !!want) input.click();
    return !!input.checked === !!want;
  }
  // Undo acts on the WHOLE selection, so start from an empty one. ROLLER's "select all" checkbox sits in
  // the list header and our skin leaves it visible — without this, one stray tap on it would turn a single
  // shield tap into "undo every ticket on the booking".
  function clearBipSelection(exceptCardId) {
    var all = inputOf(document.getElementById('select-all-checkbox'));
    if (all && all.checked) all.click();
    var keep = exceptCardId ? bipCheckboxInput(exceptCardId) : null, seen = [];
    document.querySelectorAll('[id^="booking-details-checkbox-"]').forEach(function (el) {
      var i = inputOf(el);                              // host and "-input" both match the prefix
      if (!i || i === keep || seen.indexOf(i) >= 0) return;
      seen.push(i);
      if (i.checked) i.click();
    });
  }
  function closeAnyMenu() {
    var bd = document.querySelector('.cdk-overlay-backdrop');
    if (bd) { bd.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  function startUndoCheckIn(cardId) {
    if (undoBusy) return;
    undoBusy = true;
    document.body.classList.add('rcz-undoing');   // keep the menu we're about to drive off screen

    function stop(msg) {
      document.body.classList.remove('rcz-undoing');
      try { closeAnyMenu(); } catch (e) {}
      try { setBipSelected(cardId, false); } catch (e) {}
      undoBusy = false;
      if (msg) undoToast(msg, 10000);
    }

    clearBipSelection(cardId);
    if (!setBipSelected(cardId, true)) {
      stop('Couldn’t undo this check-in — ROLLER’s ticket selector isn’t on this screen. Reload the page and try again.');
      return;
    }
    // ROLLER only grows the actions dropdown once our selection reaches its header component.
    pollFor(function () { return firstVisible(document.querySelectorAll('[id="dropdown-more-actions"]')); }, 2500, function (trigger) {
      if (!trigger) {
        stop('Couldn’t undo this check-in — ROLLER’s actions menu didn’t appear. Undo it from ROLLER’s own ticket list instead.');
        return;
      }
      clickTarget(trigger).click();
      pollFor(function () { return document.getElementById('dropdown-option-undo'); }, 2500, function (opt) {
        if (!opt) {
          // The option is hidden unless canUndoCheckIn() passes, and the one thing that can block it here
          // is the device setting — the ticket itself is checked in, or we wouldn't have intercepted.
          stop('Undo check-in is switched off for this device. A manager can turn it on in ROLLER: Settings → Device → “Allow users to undo check-ins”.');
          return;
        }
        opt.click();                                    // -> ROLLER's own "Undo check-in?" confirm modal
        document.body.classList.remove('rcz-undoing');  // the modal is ROLLER's, and staff must see it
        waitOutUndoDialog(cardId);
      });
    });
  }
  // ROLLER's confirm modal owns the rest. Watch until it's gone (confirmed or cancelled), then drop the
  // selection we made so the header returns to normal. Bounded, so a modal someone walks away from can't
  // wedge the flow shut forever.
  function waitOutUndoDialog(cardId) {
    var start = Date.now(), sawDialog = false;
    var iv = setInterval(function () {
      var open = !!document.querySelector('app-dialog-confirm');
      if (open) sawDialog = true;
      var settled = (sawDialog && !open) ||                          // staff answered it
                    (!sawDialog && Date.now() - start > 4000) ||     // it never came (nothing to undo)
                    (Date.now() - start > 120000);                   // hard stop
      if (!settled) return;
      clearInterval(iv);
      try { setBipSelected(cardId, false); } catch (e) {}
      undoBusy = false;
      try { render(); } catch (e) {}
    }, 250);
  }
  // ROLLER's own class on the button carries the state: theme--success = checked in, theme--secondary = not.
  function shieldIsTicked(btn) {
    if (btn.classList.contains('theme--success')) return true;
    var wrap = btn.closest ? btn.closest('app-icon-button') : null;
    return !!(wrap && wrap.classList.contains('theme--success'));
  }
  function installUndoCheckIn() {
    if (!CFG.UNDO_CHECKIN || window.__rczUndoNav) return; window.__rczUndoNav = true;
    document.addEventListener('click', function (ev) {
      try {
        if (!activeRoute()) return;
        if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var btn = ev.target && ev.target.closest ? ev.target.closest('button[id^="check-in-button-"]') : null;
        if (!btn) return;
        var cardId = btn.id.slice('check-in-button-'.length);
        if (!cardId || cardId === 'wallet') return;                    // the cashless-wallet button shares the prefix
        var host = btn.closest('app-bip-summary');
        if (host && host.classList.contains('rcz-skip')) return;       // membership / non-ticket card: leave ROLLER alone
        if (!shieldIsTicked(btn)) return;                              // not checked in -> ROLLER's normal check-in runs
        // Capture phase, so this lands before ROLLER's own (click) — which on a multi-use pass would
        // re-check-in rather than undo.
        ev.preventDefault(); ev.stopImmediatePropagation();
        startUndoCheckIn(cardId);
      } catch (e) {}
    }, true);
  }

  function installBadgeLinkNav() {
    if (window.__rczBadgeNav) return; window.__rczBadgeNav = true;
    document.addEventListener('click', function (ev) {
      try {
        if (ev.defaultPrevented) return;
        if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // let new-tab etc. through
        // "Done" on a child member page: let ROLLER save, then step back past the parent account page it
        // pushes (and the child edit page) to where the user actually came from. No preventDefault — the
        // save + native navigation must run; we only correct the destination afterwards.
        if (CFG.DONE_STEP_BACK && ev.target && ev.target.closest && ev.target.closest('#bip-guest-details-save-changes') && membershipDetailRoute()) {
          scheduleDoneReturn(location.pathname);
          return;
        }
        // ACTION-REQUIRED / "Add" links: unlock this card's shield (and, if the link carries an href,
        // forward to the member's tab so staff can add the photo/name) — nothing else.
        var unl = ev.target && ev.target.closest ? ev.target.closest('[data-rcz-unlock]') : null;
        if (unl) {
          ev.preventDefault(); ev.stopImmediatePropagation();
          var uid = unl.getAttribute('data-rcz-unlock');
          if (!state.unlocked) state.unlocked = {};
          var _act = unl.getAttribute('data-rcz-act');
          // #2: ADD TICKET / PASS NICKNAME -> temporary 2-min snooze (hide the prompt + unlock the shield),
          // not a permanent unlock. ADD TICKET also fires ROLLER's own "Add items" flow.
          if (_act === 'addticket' || _act === 'nickname') {
            if (_act === 'addticket') clickAddItems();
            if (uid) snoozeName(uid);
            render();
            return;
          }
          if (uid) state.unlocked[uid] = true;
          var uhost = unl.closest ? unl.closest('.summary__wrapper') : null;
          if (uhost) uhost.classList.remove('rcz-locked');
          // #3/#4: a visiting-from-another-museum ADD PHOTO goes to the ticket's OWN Guest tab (not the
          // membership), and arms the "text the admin team" handoff modal for when staff return here.
          if (unl.getAttribute('data-rcz-ticket')) {
            var _bid = (location.pathname.match(/\/bookings\/(\d+)/) || [])[1];
            if (_bid) { try { sessionStorage.setItem('rcz-handoff', 'armed:' + _bid + ':' + uid); } catch (e) {} }
            var _th = unl.closest ? unl.closest('app-bip-summary') : null;
            var _tt = _th ? _th.querySelector('button[id^="booking-details-button-"]') : null;
            if (_tt) { _tt.click(); openGuestTabSoon(true); }   // ADD PHOTO -> land on the live camera
            return;
          }
          // membership-search ADD PHOTO: open THIS card's own Guest tab (no visiting-handoff modal)
          if (unl.getAttribute('data-rcz-photonav')) {
            var _ph = unl.closest ? unl.closest('app-bip-summary') : null;
            var _pt = _ph ? _ph.querySelector('button[id^="booking-details-button-"]') : null;
            // This card's own item detail is the target — NOT a pill for an existing membership the same
            // person happens to hold. Flag the synthetic click so Section B lets ROLLER's native nav run
            // (-> /bookings/{id}/{part}) instead of forwarding to that existing membership.
            if (_pt) { window.__rczItemNav = 1; _pt.click(); openGuestTabSoon(true); }   // ADD PHOTO -> live camera
            return;
          }
          var uhref = unl.getAttribute('data-rcz-href');
          // ADD PHOTO -> land staff on the live camera; ADD NAME -> just the Guest tab (no camera).
          if (uhref && forwardToPill(uhref)) openGuestTabSoon(_act === 'photo');
          return;
        }
        // A) the tier badge link -> membership detail, else fall back to the card's tile
        var badge = ev.target && ev.target.closest ? ev.target.closest('a.rcz-badge--link') : null;
        if (badge) {
          if (badge.getAttribute('target') === '_blank') return;
          var href = badge.getAttribute('href');
          // The tier badge always lands staff on the member's Guest tab (never ROLLER's default ticket tab),
          // whether we hand off to the blue pill or fall back to opening the card's own tile.
          if (href && forwardToPill(href)) { ev.preventDefault(); openGuestTabSoon(); return; }
          var host = badge.closest ? badge.closest('app-bip-summary') : null;
          var tile = host ? host.querySelector('button[id^="booking-details-button-"]') : null;
          if (tile) { ev.preventDefault(); tile.click(); openGuestTabSoon(); } // fallback nav -> Guest tab too
          return;
        }
        // B) clicking the photo/tile of ANY member card goes to THAT member's own profile (their specific
        //    membership slot) on the Guest tab — NOT ROLLER's ticket-holder page. Works for every member
        //    variation (matched photo, add-photo, mismatch, family, …); casual tiles have no membership so
        //    they fall through to ROLLER's native nav. preventDefault alone won't cancel ROLLER's own (click)
        //    handler, so we stopImmediatePropagation in this capture phase to kill the native nav first.
        var tileBtn = ev.target && ev.target.closest ? ev.target.closest('button[id^="booking-details-button-"]') : null;
        if (tileBtn) {
          // photonav (ADD PHOTO on a membership card) already wants THIS item's detail page —
          // don't forward it to a pill for an existing membership the person may also hold.
          if (window.__rczItemNav) { window.__rczItemNav = 0; return; }
          var tcid = tileBtn.id.replace('booking-details-button-', '');
          var tinfo = state.byCard[tcid];
          var thref = tinfo ? memHref(tinfo, tcid) : null;
          if (thref && forwardToPill(thref)) { ev.preventDefault(); ev.stopImmediatePropagation(); openGuestTabSoon(); return; }
          // fallback: a card still carrying the legacy alert data-rcz-href
          var ahost = tileBtn.closest('app-bip-summary');
          var alertEl = ahost ? ahost.querySelector('.rcz-alert[data-rcz-href]') : null;
          if (alertEl) {
            var ah = alertEl.getAttribute('data-rcz-href');
            if (ah && forwardToPill(ah)) { ev.preventDefault(); ev.stopImmediatePropagation(); openGuestTabSoon(); return; }
          }
        }
      } catch (e) {}
    }, true);
  }
  // Always-on style (not gated to the check-in route) — used to hide ROLLER's "Redeem membership" button
  // everywhere it appears (per request). The :has() rule also drops its now-empty wrapper.
  function injectGlobalStyle() {
    if (document.getElementById('rcz-global') || !document.head) return;
    var rules = [
      // Staff never want these ROLLER controls — hide on every screen: the Select all / Hide checked-in
      // checkboxes, and the "verify membership discount" banner. NB: hide only .bip-list-header__checkboxes,
      // NOT the whole app-bip-list-header — its sibling .bip-list-header__actions holds the bulk-actions menu
      // (#dropdown-more-actions) that the Undo check-in flow drives, so hiding the header would break undo.
      '.bip-list-header__checkboxes{display:none !important;}',
      '#booking-membership-verification-banner{display:none !important;}'
    ];
    if (CFG.HIDE_REDEEM) rules.push('#redeem-membership-button,app-generic-button:has(#redeem-membership-button){display:none !important;}');
    if (CFG.LABEL_REDEEM_NOPHOTO) rules.push(
      // Warn on the grey no-photo placeholder in the Redeem-membership dialog. Scoped to that dialog, and the
      // placeholder only renders when the member has NO photo, so the warning shows exactly when it should.
      // Sized in cqw (container = the placeholder) so the text fills the small square whatever its size.
      'app-dialog-redeem-membership .membership-card__image-placeholder{position:relative !important;container-type:inline-size !important;overflow:hidden !important;}',
      '.rcz-nophoto-warn{position:absolute !important;inset:0 !important;display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;text-align:center !important;background:rgba(255,255,255,.68) !important;z-index:5 !important;pointer-events:none !important;padding:2px !important;box-sizing:border-box !important;}',
      '.rcz-nophoto-warn__hd{font-family:Roboto,Arial,sans-serif !important;font-weight:800 !important;color:#e5231b !important;font-size:16cqw !important;line-height:1 !important;letter-spacing:.01em !important;}',
      '.rcz-nophoto-warn__sub{font-family:Roboto,Arial,sans-serif !important;font-weight:800 !important;color:#e5231b !important;font-size:18cqw !important;line-height:1 !important;letter-spacing:-.01em !important;margin-top:6px !important;}'
    );
    if (CFG.TAG_SEARCH_TYPES) rules.push(
      // MEMBERSHIP (purple) vs TICKETS (blue) badge on each booking-search row. Distinct from the green VALID pill.
      '.rcz-searchtype{margin-left:6px !important;font-size:11px !important;font-weight:700 !important;letter-spacing:.02em !important;padding:2px 8px !important;border-radius:999px !important;line-height:1.5 !important;color:#fff !important;white-space:nowrap !important;}',
      '.rcz-searchtype.rcz-st-mem{background:#7b3fa0 !important;}',
      '.rcz-searchtype.rcz-st-tkt{background:#2f6fb0 !important;}',
      '.rcz-searchtype.rcz-st-gift{background:#c2560c !important;}',
      '.rcz-searchtype.rcz-st-other{background:#5b6470 !important;}'
    );
    if (CFG.HIDE_MEMBER_TICK) rules.push(
      'body.rcz-hidetick .bip-summary-header app-icon-button:has(button[id^="check-in-button"]){display:none !important;}',
      'body.rcz-hidetick .bip-summary-header button[id^="check-in-button"]{display:none !important;}'
    );
    if (CFG.PHOTO_FILE_UPLOAD) rules.push(
      '.rcz-filewrap{display:flex !important;justify-content:center !important;margin:10px 0 4px !important;}',
      '.rcz-filebtn{display:flex !important;flex-direction:column !important;align-items:center !important;gap:2px !important;width:100% !important;max-width:220px !important;padding:10px 16px !important;border:1.5px dashed #9aa3af !important;border-radius:10px !important;background:#fff !important;cursor:pointer !important;text-align:center !important;}',
      '.rcz-filebtn:hover{border-color:#2f6fed !important;background:#f5f8ff !important;}',
      '.rcz-filebtn--over{border-color:#2f6fed !important;background:#eaf1ff !important;}',
      '.rcz-filebtn__hd{font:600 14px/1.2 Roboto,Arial,sans-serif !important;color:#2f6fed !important;}',
      '.rcz-filebtn__sub{font:400 11px/1.2 Roboto,Arial,sans-serif !important;color:#6b7280 !important;}'
    );
    var s = document.createElement('style'); s.id = 'rcz-global';
    s.textContent = rules.join('');
    document.head.appendChild(s);
  }
  // The CSS above catches the Redeem button when it carries its id; on some membership states ROLLER renders
  // it WITHOUT the id (so CSS can't match it — you can't select by text). Hide any button reading exactly
  // "Redeem membership" here, and its app-generic-button wrapper.
  function hideRedeemButtons() {
    if (!CFG.HIDE_REDEEM) return;
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/^\s*redeem membership\s*$/i.test(btns[i].textContent || '')) {
        var wrap = (btns[i].closest && btns[i].closest('app-generic-button')) || btns[i];
        if (wrap.style.display !== 'none') wrap.style.display = 'none';
      }
    }
  }
  // Overlay a "PHOTO REQUIRED" warning on the grey no-photo placeholder in ROLLER's Redeem-membership dialog,
  // so staff attaching a member to a booking are warned that member has no photo on file. ROLLER renders the
  // placeholder only for photo-less members (a member WITH a photo gets an <img>), so this shows exactly then.
  function labelRedeemNoPhoto() {
    if (!CFG.LABEL_REDEEM_NOPHOTO) return;
    document.querySelectorAll('app-dialog-redeem-membership .membership-card__image-placeholder').forEach(function (ph) {
      if (ph.querySelector('.rcz-nophoto-warn')) return;
      var o = document.createElement('div'); o.className = 'rcz-nophoto-warn';
      o.innerHTML = '<div class="rcz-nophoto-warn__hd">' + esc(CFG.REDEEM_NOPHOTO_HD) + '</div><div class="rcz-nophoto-warn__sub">' + esc(CFG.REDEEM_NOPHOTO_SUB) + '</div>';
      ph.appendChild(o);
    });
  }
  // manage.roller.app dashboard: ROLLER's "Guests booked" figure counts new membership sign-ups too. Show it net
  // of them (Guests booked − New memberships). Both numbers are Angular ng-bindings that only rewrite the DOM when
  // their value actually changes, so our net value persists between changes; we recompute whenever either moves.
  // The dashboard renders inside a same-origin iframe, so we operate on this frame's document AND any same-origin
  // child iframe (covers running whether the script is injected into the iframe or the top frame). Idempotent via
  // data-rcz-orig/adj markers so a re-run never double-subtracts.
  function adjustGuestsBooked() {   // dispatcher for all manage.roller.app dashboard tweaks (kept name; called from render + interval)
    if (!CFG.DASHBOARD_GUESTS_MINUS_MEMBERSHIPS && !CFG.DASHBOARD_HIDE_FINANCIALS) return;
    var docs = [document];
    try { document.querySelectorAll('iframe').forEach(function (f) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }); } catch (e) {}
    for (var i = 0; i < docs.length; i++) {
      if (CFG.DASHBOARD_GUESTS_MINUS_MEMBERSHIPS) { try { adjustGuestsBookedIn(docs[i]); } catch (e) {} }
      if (CFG.DASHBOARD_HIDE_FINANCIALS) { try { hideDashboardFinancialsIn(docs[i]); } catch (e) {} }
    }
  }
  // Dashboard: remove the "Funds received" + "Revenue" summary tiles, and the "Funds received ($)" column of the
  // "Accumulated product sales" grid (a DevExtreme datagrid — header & body are separate tables aligned by
  // aria-colindex, so hide every cell at that colindex + zero the matching colgroup <col> so the table reflows).
  // Idempotent (each style set only when needed); re-applied by render + the interval as the grid re-renders.
  function hideDashboardFinancialsIn(doc) {
    ['Funds received', 'Revenue'].forEach(function (name) {
      var h = doc.querySelector('[qa-id="dashboard-info-' + name + '"]');
      if (h && h.parentElement && h.parentElement.style.display !== 'none') h.parentElement.style.display = 'none';
    });
    var grid = null;
    doc.querySelectorAll('.dx-datagrid').forEach(function (g) { var hr = g.querySelector('.dx-header-row'); if (hr && /funds received/i.test(hr.textContent || '')) grid = g; });
    if (!grid) return;
    var hr = grid.querySelector('.dx-header-row'), col = null;
    Array.prototype.forEach.call(hr.children, function (td) { if (/funds received/i.test(td.textContent || '')) col = td.getAttribute('aria-colindex'); });
    if (!col) return;
    grid.querySelectorAll('[aria-colindex="' + col + '"]').forEach(function (c) { if (c.style.display !== 'none') c.style.display = 'none'; });
    var ci = parseInt(col, 10) - 1;
    grid.querySelectorAll('colgroup').forEach(function (cg) { if (cg.children[ci] && cg.children[ci].style.width !== '0px') cg.children[ci].style.width = '0px'; });
  }
  function adjustGuestsBookedIn(doc) {
    var lbl = doc.querySelector('h3[qa-id="dashboard-info-Guests booked"]'); if (!lbl) return;
    var tile = lbl.parentElement, countP = tile && tile.querySelector('p.dashboard-info__count'); if (!countP) return;
    var tn = countP.firstChild; if (!tn || tn.nodeType !== 3) return;   // the number is the first (text) child node
    // "New memberships" value = the <p> immediately after the "New memberships" label <p>
    var nm = null, ps = doc.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      if (/^\s*New memberships\s*$/i.test(ps[i].textContent || '')) {
        var v = ps[i].nextElementSibling;
        if (v) { var x = parseInt(String(v.textContent || '').replace(/[^0-9-]/g, ''), 10); if (!isNaN(x)) nm = x; }
        break;
      }
    }
    if (nm == null) return;   // couldn't read memberships -> leave the number untouched rather than show a wrong net
    var cur = String(tn.nodeValue || '').trim(), curNum = parseInt(cur.replace(/[^0-9-]/g, ''), 10); if (isNaN(curNum)) return;
    var adjPrev = countP.getAttribute('data-rcz-adj');
    // if the text is still the value WE wrote, the true original is the one we stored; otherwise Angular has just
    // written a fresh real number, so take it as the new original.
    var orig = (adjPrev !== null && cur === adjPrev) ? parseInt(countP.getAttribute('data-rcz-orig') || '', 10) : curNum;
    if (isNaN(orig)) orig = curNum;
    var adj = String(orig - nm);
    if (cur !== adj) tn.nodeValue = adj;
    countP.setAttribute('data-rcz-orig', String(orig));
    countP.setAttribute('data-rcz-adj', adj);
  }

  // ---- Photo-from-file: an alternative to ROLLER's camera capture ----------------------------------------
  // ROLLER's capture reads the frame from the camera TRACK (not the <video> element), so swapping the video's
  // preview doesn't feed Capture. Instead we intercept getUserMedia: when staff pick/drop a file, the "camera"
  // ROLLER opens IS a canvas painting that file. ROLLER's own Capture then grabs our image — whether it reads
  // the track or the video — and saves it through its normal pipeline. No direct API calls; correct member/auth.
  function paintCover(ctx, img, w, h) {                 // cover-fit the image into w x h, centred
    var s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  // Patch getUserMedia once: pass through to the real camera, EXCEPT when we've armed a file stream (one-shot).
  function installCameraOverride() {
    try {
      var md = navigator.mediaDevices;
      if (!md || !md.getUserMedia || md.__rczPatched) return;
      var orig = md.getUserMedia.bind(md);
      md.getUserMedia = function (constraints) {
        if (window.__rczPhotoStream) { var s = window.__rczPhotoStream; window.__rczPhotoStream = null; return Promise.resolve(s); }
        return orig(constraints);
      };
      md.__rczPatched = true;
    } catch (e) {}
  }
  // A live MediaStream whose single video track is a canvas painting the chosen image (kept refreshed so the
  // track never goes stale before ROLLER captures it).
  function makeFileStream(img) {
    var w = 960, h = 720;                                 // 4:3, matching a typical webcam capture
    var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    paintCover(ctx, img, w, h);
    var stream = canvas.captureStream(15);
    var start = Date.now();
    var iv = setInterval(function () {
      if (!stream.active || Date.now() - start > 180000) { clearInterval(iv); return; }
      paintCover(ctx, img, w, h);
    }, 200);
    return stream;
  }
  // Close ROLLER's currently-open capture (so it will re-request the camera and pick up our armed stream).
  // The capture area has the unique "Capture" button; its sibling "Cancel" discards without saving.
  function closeCapture() {
    var capBtn = Array.from(document.querySelectorAll('button')).filter(function (b) { return /^\s*capture\s*$/i.test(b.textContent || ''); })[0];
    if (!capBtn) return;
    var scope = capBtn.parentElement;
    for (var d = 0; d < 3 && scope; d++) {
      var cancel = Array.from(scope.querySelectorAll('button')).filter(function (b) { return /^\s*cancel\s*$/i.test(b.textContent || ''); })[0];
      if (cancel) { cancel.click(); return; }
      scope = scope.parentElement;
    }
  }
  function useFilePhoto(cap, file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      installCameraOverride();
      window.__rczPhotoStream = makeFileStream(img);      // arm the one-shot override
      if (document.querySelector('video')) closeCapture(); // if the real camera is open, close it so it reopens with our stream
      var start = Date.now();
      var poll = setInterval(function () {
        // empty state has __action-button ("Click to take a photo"); a member who ALREADY has a photo has
        // __edit-button (the "add_a_photo" pencil to replace it). Either one (re)opens the camera.
        var ab = cap.querySelector('button.image-capture__action-button, button.image-capture__edit-button');
        var vid = document.querySelector('video');
        if (ab && !vid) ab.click();                        // (re)open -> getUserMedia -> our armed stream
        // Camera now showing OUR stream with a real frame -> auto-press ROLLER's Capture so staff land on the
        // grabbed still (our photo) and only have to hit Done. Without this they'd hit Done on the LIVE preview
        // with nothing captured, and ROLLER discards it (reloads / "forgets" the photo).
        if (vid && vid.videoWidth > 0 && !window.__rczPhotoStream) {
          var capBtn = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) { return /^\s*capture\s*$/i.test(b.textContent || ''); })[0];
          if (capBtn) { capBtn.click(); clearInterval(poll); return; }
        }
        if (Date.now() - start > 8000) { clearInterval(poll); window.__rczPhotoStream = null; }  // give up; never leave the override armed
      }, 150);
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  }
  function addFileBtn(cap) {
    if (cap.parentNode && cap.parentNode.querySelector(':scope > .rcz-filewrap')) return;   // already added next to this capture
    var wrap = document.createElement('div'); wrap.className = 'rcz-filewrap';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'rcz-filebtn';
    btn.innerHTML = '<span class="rcz-filebtn__hd">Choose a photo file</span><span class="rcz-filebtn__sub">or drag &amp; drop one here</span>';
    var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
    wrap.appendChild(btn); wrap.appendChild(input);
    cap.insertAdjacentElement('afterend', wrap);          // sibling AFTER the capture tile so Angular's own re-renders don't wipe it
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); input.click(); });
    input.addEventListener('change', function () { if (input.files && input.files[0]) useFilePhoto(cap, input.files[0]); input.value = ''; });
    ['dragover', 'dragenter'].forEach(function (t) { btn.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); btn.classList.add('rcz-filebtn--over'); }); });
    ['dragleave', 'dragend'].forEach(function (t) { btn.addEventListener(t, function (e) { e.preventDefault(); btn.classList.remove('rcz-filebtn--over'); }); });
    btn.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); btn.classList.remove('rcz-filebtn--over'); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) useFilePhoto(cap, f); });
  }
  function ensureFileUploadBtn() {
    if (!CFG.PHOTO_FILE_UPLOAD) return;
    document.querySelectorAll('.image-capture').forEach(function (cap) { addFileBtn(cap); });
  }

  // Reword ROLLER's native "Missing member photos" banner sub-line. Its <p class="rds-banner__message">
  // reads "Add missing photos to help staff verify members quickly." — we swap it for a cancellation warning.
  // Matched by the distinctive native text (not an id), and re-applied on every render since ROLLER re-renders
  // the banner. Once swapped the old text no longer matches, so it never fights itself.
  function retextMissingPhotosBanner() {
    var ps = document.querySelectorAll('p.rds-banner__message');
    for (var i = 0; i < ps.length; i++) {
      if (/add missing photos to help staff verify members/i.test(ps[i].textContent || '') && ps[i].textContent !== CFG.MISSING_PHOTOS_MSG) {
        ps[i].textContent = CFG.MISSING_PHOTOS_MSG;
      }
    }
  }
  // Relabel ROLLER's grey section-header pills (e.g. "OPEN ITEMS" -> "MEMBERSHIP PROFILES ONLY", "TODAY" ->
  // "TICKETS BOOKED FOR TODAY"). Matched by the native text on the pill span, re-applied on render since ROLLER
  // re-renders them; the pill's own CSS uppercases the result. The "TODAY" swap is scoped to the grey
  // (color--neutral) section pill so the green "Today" status badge next to VALID is left alone.
  function retextSectionPills() {
    var els = document.querySelectorAll('span.ui-pill__text');
    for (var i = 0; i < els.length; i++) {
      var s = els[i], t = s.textContent || '', pill = s.parentElement;
      // NB: the "OPEN ITEMS" -> "Membership profiles below" relabel is NOT done here — it must only apply when the
      // section actually holds membership profiles (an OPEN ITEMS section can be gift-cards/add-ons only). That
      // decision needs .rcz-mem (set later by markSkips), so it lives in tagProfileOnlyCards via setOpenItemsLabel().
      if (CFG.TODAY_LABEL && /^\s*today\s*$/i.test(t) && t !== CFG.TODAY_LABEL && pill && /color--neutral/.test(pill.className || '')) s.textContent = CFG.TODAY_LABEL;
      // Date section header (e.g. "11 May 2026") -> "TICKETS BOOKED FOR 11 May 2026". Grey neutral pill not in a
      // card; idempotent (skip if already prefixed). CSS uppercases it for display.
      if (CFG.DATE_PREFIX && pill && /color--neutral/.test(pill.className || '') && !(s.closest && s.closest('app-bip-summary')) && /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(t.trim()) && t.indexOf(CFG.DATE_PREFIX) !== 0) s.textContent = CFG.DATE_PREFIX + t.trim();
      // Enlarge the grey SECTION-HEADER pills (neutral, not inside a card): "MEMBERSHIP PROFILES ONLY",
      // "TICKETS BOOKED FOR TODAY", date headers. Skip in-card status pills ("Current") — those stay small.
      if (CFG.BIG_SECTION_PILLS && pill && /color--neutral/.test(pill.className || '') && !(s.closest && s.closest('app-bip-summary'))) {
        pill.classList.add('rcz-sectionpill');
      }
    }
  }
  // Hide the check-in tick on membership tiles that sit under the "MEMBERSHIP PROFILES ONLY" (ROLLER's OPEN
  // ITEMS) section — those are membership PROFILES, not a dated admission, so staff shouldn't check them in
  // there. Tiles under a DATE section (a real session booking) keep their tick. All member types. We walk the
  // list in document order tracking the current SECTION header — a ui-pill NOT inside a card (each card has
  // its own "Current" status pill, which we must ignore) — and tag membership cards under the profiles section
  // with .rcz-nocheckin (the CSS then hides their shield/tick).
  // Set the "OPEN ITEMS" section header to our two-part "Membership profiles below" label (idempotent).
  function setOpenItemsLabel(span) {
    if (!span || !CFG.OPEN_ITEMS_LABEL || span.querySelector('.rcz-pill-sub')) return;   // already relabeled
    while (span.firstChild) span.removeChild(span.firstChild);
    span.appendChild(document.createTextNode(CFG.OPEN_ITEMS_LABEL));
    if (CFG.OPEN_ITEMS_SUB) {
      var sub = document.createElement('span');
      sub.className = 'rcz-pill-sub';
      sub.textContent = CFG.OPEN_ITEMS_SUB;
      span.appendChild(sub);
    }
  }
  // Restore ROLLER's original "OPEN ITEMS" text (used when the section turns out to hold no membership profiles,
  // e.g. a gift-card-only booking — it must not be mislabelled "Membership profiles below").
  function clearOpenItemsLabel(span) {
    if (!span || !span.querySelector('.rcz-pill-sub')) return;
    span.textContent = 'OPEN ITEMS';
  }
  // Walk the list in document order tracking the current SECTION header (a ui-pill NOT inside a card — each card
  // has its own "Current" status pill, which we ignore). For the OPEN ITEMS section: only relabel it "Membership
  // profiles below" and hide the check-in tick when it actually contains membership profiles (.rcz-mem, set by
  // markSkips). A gift-card / add-on OPEN ITEMS section keeps ROLLER's heading and its normal tick. Tiles under a
  // DATE section (a real dated booking) are always checkable.
  function tagProfileOnlyCards() {
    if (!CFG.BLOCK_PROFILE_CHECKIN) return;
    var main = document.querySelector('.panel__main-inner'); if (!main) return;
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT, null), node;
    var openPill = null, openCards = [], openHasMember = false;   // current OPEN ITEMS section state
    function finalize() {
      if (!openPill) return;
      if (openHasMember) setOpenItemsLabel(openPill); else clearOpenItemsLabel(openPill);
      openCards.forEach(function (c) { c.classList.toggle('rcz-nocheckin', c.classList.contains('rcz-mem')); });
      openPill = null; openCards = []; openHasMember = false;
    }
    while ((node = walker.nextNode())) {
      if (node.matches('span.ui-pill__text') && !(node.closest && node.closest('app-bip-summary'))) {
        finalize();   // a new section header closes the previous one
        var raw = (node.textContent || '').trim();
        var isOpen = /open items/i.test(raw) || (CFG.OPEN_ITEMS_LABEL && raw.indexOf(CFG.OPEN_ITEMS_LABEL) === 0) || !!(node.querySelector && node.querySelector('.rcz-pill-sub'));
        openPill = isOpen ? node : null;
      } else if (node.tagName === 'APP-BIP-SUMMARY') {
        if (openPill) { openCards.push(node); if (node.classList.contains('rcz-mem')) openHasMember = true; }
        else node.classList.remove('rcz-nocheckin');   // a dated-section card is always checkable
      }
    }
    finalize();
  }
  // Membership PROFILES must not be bulk-checked-in either: when any profile tile (.rcz-nocheckin) is selected
  // via its top-left checkbox, hide ROLLER's blue bulk "check (N)" button in the header — the "..." more-actions
  // menu stays (that's what the Undo flow drives). Selecting only real/dated tickets leaves the button available.
  function toggleBulkCheckinBtn() {
    if (!CFG.BLOCK_PROFILE_CHECKIN) return;
    var anyProfileSelected = false;
    document.querySelectorAll('app-bip-summary.rcz-nocheckin').forEach(function (c) {
      var cb = c.querySelector('input[type="checkbox"]');
      if (cb && cb.checked) anyProfileSelected = true;
    });
    document.body.classList.toggle('rcz-hidecheckinbtn', anyProfileSelected);
  }
  // Badge each booking-search row as a MEMBERSHIP purchase vs an attendance TICKET, using the productName we
  // captured from the keyword-search response (state.searchTypes, keyed by the # / receiptNumber shown on the row).
  // Lets staff tell them apart in the results list without opening each one.
  function tagSearchRows() {
    if (!CFG.TAG_SEARCH_TYPES) return;
    var rows = document.querySelectorAll('app-booking-search-result');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var a = row.querySelector('a[id^="booking-search-result-"]');
      var receipt = a ? a.id.replace('booking-search-result-', '') : null;
      if (!receipt) { var idEl = row.querySelector('#booking-search-id .selectable'); receipt = idEl ? (idEl.textContent || '').trim() : null; }
      if (!receipt) continue;
      var info = state.searchTypes[receipt];
      if (!info) continue;                          // unknown until the search response is indexed
      var type = info.type || (info.membership ? 'membership' : 'tickets');   // tolerate older shape
      var badge = row.querySelector('.rcz-searchtype');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ui-pill rcz-searchtype';
        var pills = row.querySelectorAll('.ui-pill:not(.rcz-searchtype)');
        var anchor = pills.length ? pills[pills.length - 1] : null;   // sit just after the VALID/EXPIRED status pill
        if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(badge, anchor.nextSibling);
        else (row.querySelector('.booking-search-result__data') || row).appendChild(badge);
      }
      badge.classList.toggle('rcz-st-mem', type === 'membership');
      badge.classList.toggle('rcz-st-gift', type === 'giftcard');
      badge.classList.toggle('rcz-st-tkt', type === 'tickets');
      badge.classList.toggle('rcz-st-other', type === 'other');
      badge.textContent = type === 'membership' ? CFG.SEARCH_MEM_LABEL
                        : type === 'giftcard' ? CFG.SEARCH_GIFT_LABEL
                        : type === 'other' ? CFG.SEARCH_OTHER_LABEL
                        : CFG.SEARCH_TKT_LABEL;
    }
  }

  /* ======================================================================
     WATCHDOG — silent health telemetry across all deployments
     Runs the checks below in the background. When a structural anchor a tweak
     depends on is MISSING on a page where it should exist (i.e. ROLLER changed
     something), it reports once-per-issue-per-day-per-machine to CFG.WATCHDOG_URL
     (a webhook you own that emails you). No guest data leaves — only: check id,
     the recorded reason, script version, a random machine id, a digit-stripped
     path, and the date. Console tools: rczDiag() shows all checks for the CURRENT
     page now; rczHealth() prints this machine's local log.
     ====================================================================== */
  function rczMachineId() {
    try { var k = 'rcz-machine-id', v = localStorage.getItem(k); if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(k, v); } return v; } catch (e) { return 'unknown'; }
  }
  function rczDocs() { var ds = [document]; try { document.querySelectorAll('iframe').forEach(function (f) { try { if (f.contentDocument) ds.push(f.contentDocument); } catch (e) {} }); } catch (e) {} return ds; }
  function rczAny(sel) { var ds = rczDocs(); for (var i = 0; i < ds.length; i++) { try { if (ds[i].querySelector(sel)) return true; } catch (e) {} } return false; }
  function rczAnyText(sel, re) { var ds = rczDocs(); for (var i = 0; i < ds.length; i++) { try { var e = ds[i].querySelectorAll(sel); for (var j = 0; j < e.length; j++) { if (re.test(e[j].textContent || '')) return true; } } catch (x) {} } return false; }
  function rczDashGridOk() { var ds = rczDocs(); for (var i = 0; i < ds.length; i++) { try { var gs = ds[i].querySelectorAll('.dx-datagrid'); for (var j = 0; j < gs.length; j++) { var hr = gs[j].querySelector('.dx-header-row'); if (hr && /funds received/i.test(hr.textContent || '')) return true; } } catch (e) {} } return false; }
  // "Are we on the manage dashboard?" — keyed off the URL, INDEPENDENT of the qa-id/class anchors the checks
  // verify, so that a rename of those anchors surfaces as BROKEN rather than silently going n/a.
  function rczOnDashboard() { return location.hostname === 'manage.roller.app' && /(^|\/)dashboard(\/|$)/.test(location.pathname); }
  // Each check: applies() = are we on a page where this SHOULD be verifiable? ok() = is the anchor present?
  var WD_CHECKS = [
    { id: 'pos-tiles',           why: 'Full-frame photo tiles hook <app-bip-summary>; renamed = no tiles render.',                     applies: function () { return activeRoute(); },                                                ok: function () { return !!document.querySelector('app-bip-summary'); } },
    { id: 'pos-checkin-btn',     why: 'Shield styling, tick-hiding and the Undo flow target button[id^="check-in-button"].',           applies: function () { return activeRoute() && !!document.querySelector('app-bip-summary'); },        ok: function () { return !!document.querySelector('button[id^="check-in-button"]'); } },
    { id: 'pos-details-btn',     why: 'Photo / age / casual overlays target button[id^="booking-details-button-"].',                  applies: function () { return activeRoute() && !!document.querySelector('app-bip-summary'); },        ok: function () { return !!document.querySelector('button[id^="booking-details-button-"]'); } },
    { id: 'pos-section-pills',   why: 'Section relabels + enlargement target span.ui-pill__text.',                                     applies: function () { return activeRoute(); },                                                ok: function () { return !!document.querySelector('span.ui-pill__text'); } },
    { id: 'search-rows',         why: 'Search MEMBERSHIP/TICKETS/OTHER badges read the receipt from a[id^="booking-search-result-"].', applies: function () { return !!document.querySelector('app-booking-search-result'); },                ok: function () { return !!document.querySelector('a[id^="booking-search-result-"]'); } },
    { id: 'redeem-photo-card',   why: 'The "PHOTO REQUIRED" warning targets .membership-card in app-dialog-redeem-membership.',       applies: function () { return !!document.querySelector('app-dialog-redeem-membership'); },             ok: function () { return !!document.querySelector('app-dialog-redeem-membership app-membership-card, app-dialog-redeem-membership .membership-card__image-placeholder'); } },
    { id: 'dash-guests',         why: 'Guests-booked net + Funds/Revenue tile removal rely on h3[qa-id="dashboard-info-*"] + p.dashboard-info__count.', applies: rczOnDashboard, ok: function () { return rczAny('h3[qa-id="dashboard-info-Guests booked"]') && rczAny('p.dashboard-info__count'); } },
    { id: 'dash-newmemberships', why: 'The Guests-booked net subtracts the "New memberships" value found by that label.',              applies: rczOnDashboard, ok: function () { return rczAnyText('p', /^\s*New memberships\s*$/i); } },
    { id: 'dash-product-grid',   why: 'Funds-received column removal targets the .dx-datagrid header row containing "Funds received".', applies: rczOnDashboard, ok: function () { return rczDashGridOk(); } },
    // CANARY: a deliberate always-broken check that only "applies" when you set localStorage rcz-selftest=1.
    // With it set, the normal watchdog timer detects it broken and emails you within ~3 min (streak) — a genuine
    // end-to-end test of the auto-detect -> email chain. Remove the key to stop.
    { id: 'self-test',           why: 'Watchdog SELF-TEST (localStorage rcz-selftest=1) — deliberate, not a real problem. Remove the key to stop.', applies: function () { try { return localStorage.getItem('rcz-selftest') === '1'; } catch (e) { return false; } }, ok: function () { return false; } }
  ];
  function rczRunChecks() {
    var res = [];
    for (var i = 0; i < WD_CHECKS.length; i++) {
      var c = WD_CHECKS[i], applies = false, ok = false;
      try { applies = !!c.applies(); } catch (e) {}
      if (applies) { try { ok = !!c.ok(); } catch (e) { ok = false; } }
      res.push({ id: c.id, status: !applies ? 'n/a' : (ok ? 'ok' : 'BROKEN'), why: c.why });
    }
    return res;
  }
  function rczLogHealth(entry) {
    try { var k = 'rcz-health-log', log = JSON.parse(localStorage.getItem(k) || '[]'); log.unshift(entry); if (log.length > 50) log = log.slice(0, 50); localStorage.setItem(k, JSON.stringify(log)); } catch (e) {}
  }
  function rczReport(check) {
    var key = 'rcz-wd:' + check.id + ':' + SCRIPT_VERSION, last = 0;   // dedup key includes version, so a new deploy re-alerts if still broken
    try { last = parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch (e) {}
    if (Date.now() - last < CFG.WATCHDOG_MIN_HOURS * 3600000) return;
    var payload = { check: check.id, why: check.why, version: SCRIPT_VERSION, machine: rczMachineId(), path: String(location.pathname || '').replace(/\d+/g, '#'), date: new Date().toISOString() };
    rczLogHealth(payload);
    if (CFG.WATCHDOG_URL) {
      var body = JSON.stringify(payload), sent = false;
      try { sent = navigator.sendBeacon(CFG.WATCHDOG_URL, body); } catch (e) {}
      if (!sent) { try { fetch(CFG.WATCHDOG_URL, { method: 'POST', mode: 'no-cors', keepalive: true, body: body }); } catch (e) {} }
    }
    try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
  }
  var rczStreak = {};
  function runWatchdog() {
    if (!CFG.WATCHDOG) return;
    try {
      for (var i = 0; i < WD_CHECKS.length; i++) {
        var c = WD_CHECKS[i], applies = false;
        try { applies = !!c.applies(); } catch (e) {}
        if (!applies) { rczStreak[c.id] = 0; continue; }
        var ok = false; try { ok = !!c.ok(); } catch (e) { ok = false; }
        if (ok) rczStreak[c.id] = 0;
        else { rczStreak[c.id] = (rczStreak[c.id] || 0) + 1; if (rczStreak[c.id] >= CFG.WATCHDOG_STREAK) rczReport(c); }  // only report persistent breakage, not a load transient
      }
    } catch (e) {}
  }
  try {
    window.rczVersion = SCRIPT_VERSION;
    window.rczDiag = function () { var r = rczRunChecks(); try { console.table(r); } catch (e) { console.log(JSON.stringify(r, null, 1)); } return r; };
    window.rczHealth = function () { var log = []; try { log = JSON.parse(localStorage.getItem('rcz-health-log') || '[]'); } catch (e) {} console.log('[rcz] health log — ' + log.length + ' entr' + (log.length === 1 ? 'y' : 'ies') + ' (machine ' + rczMachineId() + '):'); log.forEach(function (e) { console.log(e.date + '  ' + e.check + '  v' + e.version + '  ' + e.path); }); return log; };
    // Fire a REAL alert now, through the exact report path a genuine bug uses (dedup cleared so it's repeatable).
    window.rczTestAlert = function () {
      try { localStorage.removeItem('rcz-wd:self-test:' + SCRIPT_VERSION); } catch (e) {}
      rczReport({ id: 'self-test', why: 'Manual watchdog self-test — confirms detection→email works. Not a real problem.' });
      console.log('[rcz] test alert fired' + (CFG.WATCHDOG_URL ? ' to the watchdog endpoint — check the admin inbox shortly.' : ' (no WATCHDOG_URL set — logged locally only; see rczHealth()).'));
      return true;
    };
  } catch (e) {}

  function boot() {
    injectGlobalStyle();
    injectStyle();
    if (CFG.PHOTO_FILE_UPLOAD) installCameraOverride();   // patch getUserMedia early (pass-through until a file is armed)
    installBadgeLinkNav();
    installUndoCheckIn();
    render();
    var obs = new MutationObserver(function () {
      // Off the booking route (e.g. the membership photo page), strip our stylesheet IMMEDIATELY — a busy
      // page's continuous mutations can otherwise keep pushing back the debounced render() so its teardown
      // never fires, leaving #rcz-style applied and reformatting ROLLER's native card. (Fixes the ~20% bug.)
      if (!activeRoute()) { var _st = document.getElementById('rcz-style'); if (_st) _st.remove(); }
      clearTimeout(window.__rczT);
      window.__rczT = setTimeout(render, 60);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // manage.roller.app dashboard refreshes its figures on its own timer inside a same-origin iframe; a periodic
    // re-apply guarantees the "Guests booked" net stays correct even if a mutation isn't observed in this frame.
    if ((CFG.DASHBOARD_GUESTS_MINUS_MEMBERSHIPS || CFG.DASHBOARD_HIDE_FINANCIALS) && location.hostname === 'manage.roller.app') setInterval(adjustGuestsBooked, 1500);
    // Watchdog: run the health checks on a timer (first run delayed so page-load transients settle).
    if (CFG.WATCHDOG) setInterval(runWatchdog, CFG.WATCHDOG_EVERY_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
