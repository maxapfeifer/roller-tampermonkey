// ==UserScript==
// @name         Venue — ROLLER Check-in Cards + Member Photos
// @namespace    venue.roller.checkin-cards
// @version      5.53
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
    MIN_COLUMN_PX:     400,  // smaller = more (and smaller) cards per row; larger = fewer, bigger photos
    GAP_PX:            12,   // gutter between cards
    CARD_RADIUS_PX:    18,
    PLACEHOLDER_ICON_PX: 150,// size of the grey person icon when there's no photo
    CDN:              'https://cdn.rollerdigital.com/ticket/',
    GET_MEMBERSHIP:   'https://doorlist.roller.app/api/customers/get-membership',
    ALERT_LINES:      ['ADD PHOTO NOW!', 'WARNING: ANY CHECK-IN WITHOUT PHOTO WILL CAUSE CANCELLATION'],
    // Casual (non-member) card: big NAME, then the ticket TYPE, then a small sub-line.
    // Solo tickets show the type upper-cased (ADULT/CHILD/…); "Book for 6 @ $…" package tickets
    // show "Group of 6". {N} filled at render time.
    CASUAL_SUB:        'CASUAL BOOKING (NO PHOTO REQUIRED)',
    CASUAL_GROUP_TYPE: 'Group of {N}',
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
    // ---- membership search results ----
    SHOW_MEMBERSHIP:   true,  // format membership results (photo + "Membership Found" panel). false = leave as ROLLER draws them
    MEM_TITLE:         'Membership Found',
    MEM_VALID_DAYS:    364,   // membership validity; Ends = purchase date + this many days
    // ---- membership tag → link-through ----
    LINK_MEMBERSHIP_BADGE: true,  // make the "Membership / <tier>" tag a link to that member's detail page
    MEM_LINK_NEWTAB:   false, // false = navigate in the same tab (mirrors ROLLER's blue discount link); true = new tab
    FORMS_URL:        'https://doorlist.roller.app/api/bookings/forms?formResponseId='
  };

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
    formsSeen:    {}    // rollerFormResponseId -> true (so we fetch each form's answers only once)
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
      }
    } catch (e) {}
  }

  var X = XMLHttpRequest.prototype;
  var oOpen = X.open, oSet = X.setRequestHeader, oSend = X.send;
  X.open = function (m, u) { this.__rczUrl = u; this.__rczHdr = {}; return oOpen.apply(this, arguments); };
  X.setRequestHeader = function (k, v) { try { (this.__rczHdr = this.__rczHdr || {})[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
  X.send = function () {
    var xhr = this, u = String(xhr.__rczUrl || '');
    if (u.indexOf('/api/') > -1) stashAuth(u, xhr.__rczHdr);
    if (/\/api\/bookings\/\d+(\?|$)/.test(u) || u.indexOf('get-membership') > -1) {
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
      try { var u = (res && res.url) || url; if (/\/api\/bookings\/\d+(\?|$)/.test(String(u)) || String(u).indexOf('get-membership') > -1) res.clone().text().then(function (t) { onResponse(u, t); }).catch(function () {}); } catch (e) {}
      return res;
    });
  };

  /* ======================================================================
     CORE LOGIC
     ====================================================================== */
  function firstName(s) { return String(s || '').trim().toLowerCase().split(/\s+/)[0]; }
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
        return { raw: d.memberName, name: firstName(d.memberName), amount: d.amount, pct: d.percentageOff, r: d.memberReceiptNumber, b: d.memberBookingItemPartId, used: false };
      });
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
      var next = {}, toFetch = [];
      state.discountIndex = {};
      // A ticket is a MEMBER check-in when it carries a membership discount (bookingItemDiscount != 0).
      var memberTickets = bip.filter(function (p) { return p.bookingItemDiscount; });
      var assign = {}; // cardId -> discount
      // Pass 1: match the ticket-holder's name to a membership name.
      memberTickets.forEach(function (p) {
        var d = discs.find(function (x) { return !x.used && x.name && x.name === firstName(p.name); });
        if (d) { d.used = true; assign[p.bookingItemPartId] = d; }
      });
      // Pass 2: for the rest, match by the discount's dollar amount (the reliable ROLLER link).
      memberTickets.forEach(function (p) {
        if (assign[p.bookingItemPartId]) return;
        var d = discs.find(function (x) { return !x.used && x.amount != null && Number(x.amount) === Number(p.bookingItemDiscount); });
        if (!d) d = discs.find(function (x) { return !x.used; }); // last resort
        if (d) { d.used = true; assign[p.bookingItemPartId] = d; }
      });
      bip.forEach(function (p) {
        var cardId = p.bookingItemPartId;
        if (!p.bookingItemDiscount) { next[cardId] = { member: false, pending: false, photo: null }; return; } // casual
        var d = assign[cardId];
        if (!d) {
          // Member discount on this ticket, but every discount record was already mapped to another ticket
          // (e.g. Bronte's membership code discounted a second adult on the booking). Attribute it to the
          // membership whose amount matches — so we can NAME the real member (Bronte) rather than say
          // "another member" — and still flag it, because the discount is being used by someone else.
          var src = discs.find(function (x) { return x.name && x.amount != null && Number(x.amount) === Number(p.bookingItemDiscount); }) || discs.find(function (x) { return x.name; });
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
        var exact = fnM && fnM === fnT;
        var close = !exact && closeName(fnM, fnT);
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
        } else if (exact) {
          // name matches a genuinely-named membership slot -> just the photo, no prompt.
          next[cardId] = { member: true, pending: true, photo: null, tier: tier };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else if (close) {
          // similar/variant name (Jax vs Jaxson) -> show photo, prompt to confirm/override the name
          next[cardId] = { member: true, pending: true, photo: null, closematch: true, memberName: proper(fnM), ticketName: proper(fnT), tier: tier };
          toFetch.push({ cardId: cardId, r: d.r, b: d.b });
        } else if (!fnT) {
          // ticket has NO holder name (e.g. a walk-up / door sale where the attendee's name was never
          // captured). With no name to compare we can't assert a mismatch — show the member's photo
          // best-effort as a clean member card. (If a name later turns up and doesn't match the membership,
          // the pill-name guard at render still flags it.)
          next[cardId] = { member: true, pending: true, photo: null, tier: tier };
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
          host.querySelectorAll('.rcz-alert,.rcz-casual,.rcz-mismatch,.rcz-visiting,.rcz-badge,.rcz-note,.rcz-bday,.rcz-meaning,.rcz-status,.rcz-actreq,.rcz-botbar,.rcz-memstrip,.rcz-mem-info,.rcz-mem-name,img.rcz-photo').forEach(function (e) { e.remove(); });
          host.querySelectorAll('.rcz-alert-on,.rcz-casual-on,.rcz-mismatch-on,.rcz-visiting-on').forEach(function (w) { w.classList.remove('rcz-alert-on', 'rcz-casual-on', 'rcz-mismatch-on', 'rcz-visiting-on'); });
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
      el.innerHTML = '<span class="rcz-shieldtxt__id">' + esc(CFG.SHIELD_LABEL) + '</span><span class="rcz-shieldtxt__sub">' + esc(CFG.SHIELD_SUB) + '</span>';
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
      'app-bip-summary:not(.rcz-skip) .summary__wrapper mat-checkbox.align-top--checkbox{display:none !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper .summary-detail{position:absolute !important;right:76px !important;left:auto !important;bottom:12px !important;flex:none !important;width:auto !important;max-width:44% !important;background:none !important;border:none !important;border-radius:0 !important;padding:0 !important;box-shadow:none !important;z-index:6 !important;text-align:right !important;}',
      'app-bip-summary:not(.rcz-skip) .summary-detail p.summary-detail__item:not(.summary-detail__item--emphasis){display:none !important;}',
      /* category ("Adult") smaller & muted; name ("Erin") larger, dark, bold */
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__item--emphasis{font-size:18px !important;font-weight:600 !important;color:#7b828c !important;margin:0 !important;line-height:1.32 !important;}',
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__item-holder-wrapper{display:block !important;font-size:18px !important;font-weight:800 !important;color:#1f2933 !important;margin-top:0 !important;line-height:1.32 !important;}',
      /* kill the empty modifiers row\'s 4px margin so the type + name lines sit flush (align with the tier) */
      'app-bip-summary:not(.rcz-skip) .summary-detail .summary-detail__modifiers{margin:0 !important;}',
      /* compress the "Select all / Hide checked in" header — trim the top gap and pull the */
      /* bottom in to ~32px (tight, but enough that ROLLER\'s verify banner clears the row) */
      '.panel__header:has(.bip-list-header){padding-top:6px !important;padding-bottom:32px !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper .summary-detail-time{display:none !important;}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper app-icon-button.align-top:has(button[id^="check-in-button"]){position:absolute !important;right:18px !important;bottom:12px !important;margin:0 !important;z-index:6 !important;}',
      /* check-in button: 66px square sized to the name-label height; glyph scaled to match. Full box
         stays clickable; the shield (when on) is drawn as ::before so the whole square still taps. */
      'app-bip-summary:not(.rcz-skip) .summary__wrapper app-icon-button.align-top:has(button[id^="check-in-button"]) button{width:48px !important;height:48px !important;min-width:48px !important;min-height:48px !important;padding:0 !important;position:relative !important;overflow:visible !important;' + (CFG.SHOW_SHIELD ? 'background:transparent !important;border:none !important;box-shadow:none !important;border-radius:0 !important;' : 'border-radius:12px !important;box-shadow:0 2px 8px rgba(0,0,0,.35) !important;') + '}',
      'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"] mat-icon{font-size:26px !important;width:26px !important;height:26px !important;line-height:26px !important;position:relative !important;z-index:1 !important;}',
      /* SHIELD — reacts to ROLLER\'s own state class: theme--secondary = NOT checked in (amber "I.D."),
         theme--success = checked in (green tick). Pure CSS, so it flips the instant staff check someone in. */
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"]::before{content:"" !important;position:absolute !important;inset:0 !important;z-index:0 !important;clip-path:path("M24 2 L44 9 L44 24 C44 36 35 43 24 47 C13 43 4 36 4 24 L4 9 Z") !important;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4)) !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--secondary::before{background:#e0a316 !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--success::before{background:#16a34a !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) .summary__wrapper button[id^="check-in-button"].theme--secondary mat-icon{display:none !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt{position:absolute !important;inset:0 !important;z-index:1 !important;display:none;flex-direction:column !important;align-items:center !important;justify-content:center !important;padding-bottom:6px !important;color:#fff !important;pointer-events:none !important;text-align:center !important;}' : ''),
      (CFG.SHOW_SHIELD ? 'app-bip-summary:not(.rcz-skip) button[id^="check-in-button"].theme--secondary .rcz-shieldtxt{display:flex !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt__id{font:400 9px/1 Roboto,Arial,sans-serif !important;letter-spacing:.02em !important;}' : ''),
      (CFG.SHOW_SHIELD ? '.rcz-shieldtxt__sub{font:400 16px/1 Roboto,Arial,sans-serif !important;letter-spacing:0 !important;margin-top:1px !important;}' : ''),
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
      '.rcz-mem-name__cat{font:600 18px/1.32 Roboto,Arial,sans-serif !important;color:#7b828c !important;}',
      '.rcz-mem-name__nm{font:800 18px/1.32 Roboto,Arial,sans-serif !important;color:#1f2933 !important;margin-top:0 !important;}',
      '.rcz-memstrip{position:absolute !important;left:0 !important;right:0 !important;bottom:70px !important;z-index:5 !important;pointer-events:none !important;background:#1f2429 !important;color:#fff !important;font:800 12px/1 Roboto,Arial,sans-serif !important;letter-spacing:.06em !important;text-align:center !important;padding:7px 8px !important;}',
      /* STATUS BAND — Name:/Photo: readout across the top of the tile (grey = fine, red = needs action) */
      '.rcz-status{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;z-index:6 !important;pointer-events:none !important;background:rgba(255,255,255,.55) !important;-webkit-backdrop-filter:blur(6px) !important;backdrop-filter:blur(6px) !important;border-bottom:1px solid rgba(0,0,0,.07) !important;padding:8px 11px 5px 11px !important;font:400 12.5px/1.3 Roboto,Arial,sans-serif !important;color:#1f2933 !important;}',
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
      /* ACTION REQUIRED prompt — frosted banner with tappable links */
      '.rcz-actreq{position:absolute !important;left:50% !important;right:auto !important;transform:translateX(-50%) !important;max-width:calc(100% - 24px) !important;bottom:76px !important;z-index:6 !important;pointer-events:none !important;background:rgba(255,255,255,.86) !important;-webkit-backdrop-filter:blur(4px) !important;backdrop-filter:blur(4px) !important;border-radius:11px !important;padding:9px 16px 10px !important;box-shadow:0 2px 9px rgba(0,0,0,.17) !important;text-align:center !important;}',
      '.rcz-actreq__hd{font:800 13px/1.1 Roboto,Arial,sans-serif !important;letter-spacing:.05em !important;color:#e5231b !important;}',
      '.rcz-actreq__links{display:flex !important;gap:16px !important;justify-content:center !important;margin-top:5px !important;flex-wrap:wrap !important;}',
      '.rcz-actreq a,.rcz-addlink{color:#2f6fed !important;text-decoration:underline !important;text-underline-offset:2px !important;pointer-events:auto !important;cursor:pointer !important;font:700 12px/1 Roboto,Arial,sans-serif !important;}',
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
  function addCasual(w, name, category) {
    // New design: casual tiles carry no centre text — the person-icon placeholder, the "No Match Required"
    // status band, and the name in the bottom bar already say everything. We keep a small "Casual Guest"
    // tag in the bottom-left (styled via .rcz-casual) in place of a membership tier badge.
    w.classList.add('rcz-casual-on');
    var c = w.querySelector('.rcz-casual');
    if (!c) { c = document.createElement('div'); c.className = 'rcz-casual'; w.appendChild(c); }
    var html = '<span class="rcz-casual__tag">Casual Guest</span>';
    if (c.getAttribute('data-h') !== html) { c.innerHTML = html; c.setAttribute('data-h', html); }
  }
  function clrCasual(w) { w.classList.remove('rcz-casual-on'); var c = w.querySelector('.rcz-casual'); if (c) c.remove(); }
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
    for (var i = 0; i < pillFirsts.length; i++) if (closeName(pillFirsts[i], nm)) return null; // close variant -> handled elsewhere
    // genuine interloper. Find the single membership name not claimed by any ticket, so we can name it.
    var ticketFirsts = [];
    document.querySelectorAll('app-bip-summary:not(.rcz-skip) .summary__wrapper').forEach(function (w2) {
      var b2 = w2.querySelector('button[id^="booking-details-button-"]'); if (!b2) return;
      var c2 = b2.id.replace('booking-details-button-', ''); var i2 = state.byCard[c2];
      if (i2 && i2.member) { var n2 = firstName(holderNameFor(w2, c2)); if (n2) ticketFirsts.push(n2); }
    });
    var unclaimed = pillFirsts.filter(function (pf) { return ticketFirsts.indexOf(pf) < 0; });
    return { memberName: unclaimed.length === 1 ? proper(unclaimed[0]) : '', ticketName: proper(nm) };
  }
  // render a card as a name-mismatch (red overlay) while KEEPING the member photo behind it, if present
  function showMismatch(w, btn, icon, img, cardId, memberName, ticketName, tier) {
    if (img) { /* keep photo */ } else { var im = btn.querySelector('img.rcz-photo'); if (im) img = im; }
    if (icon && (img || btn.querySelector('img.rcz-photo'))) icon.style.display = 'none';
    var mem = '<b>' + esc((memberName || 'another member').toUpperCase()) + '</b>';
    var tk = esc(ticketName || 'this guest');
    var note = esc(CFG.MISMATCH_NOTE_TMPL).split('{MEMBER}').join(mem).split('{TICKET}').join(tk);
    var onPhoto = !!(w.querySelector('img.rcz-photo') || btn.querySelector('img.rcz-photo'));
    addMismatch(w, note, onPhoto); clrAlert(w); clrCasual(w); clrVisiting(w); clrNote(w);
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
    if (info.family) { addActionReq(w, cardId, [{ label: 'Add individual names', href: memHref(info, cardId) }]); clrNote(w); }
    else if (info.closematch) { addActionReq(w, cardId, [{ label: 'Add a ticket' }, { label: 'Pass nickname' }]); clrNote(w); }
    else if (info.paidMember) { addNote(w, 'paidmember', firstNameOnCard(w), ticketTypeOfPart(info.recipPart)); clrActionReq(w); }
    else { clrNote(w); clrActionReq(w); }
  }
  function addBadge(w, tier, href) {
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
    var html = '<span class="rcz-badge__tier">' + esc(gold ? CFG.TIER_GOLD : CFG.TIER_WONDER) + '</span><span class="rcz-badge__lbl">Member</span>';
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
  function addMeaning(w, text) {
    var label = w.querySelector('.summary-detail'); if (!label) return;
    var el = label.querySelector('.rcz-meaning');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-meaning'; label.appendChild(el); }
    var t = 'meaning: ' + text;
    if (el.textContent !== t) el.textContent = t;
  }
  function clrMeaning(w) { var el = w.querySelector('.rcz-meaning'); if (el) el.remove(); }
  // STATUS BAND — top-of-tile Name:/Photo: readout. warn=true paints the value red (needs action).
  function paintStatus(w, nm, nmW, ph, phW) {
    var el = w.querySelector('.rcz-status');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-status'; w.appendChild(el); }
    function tk(v) { return (v === 'Matched' || v === 'Showing') ? '<span class="rcz-status__tick">✓</span>' : ''; }
    var html = '<div class="rcz-status__row"><span class="rcz-status__lbl">Name:</span><span class="' + (nmW ? 'rcz-status__warn' : 'rcz-status__ok') + '">' + esc(nm) + '</span>' + tk(nm) + '</div>' +
               '<div class="rcz-status__row"><span class="rcz-status__lbl">Photo:</span><span class="' + (phW ? 'rcz-status__warn' : 'rcz-status__ok') + '">' + esc(ph) + '</span>' + tk(ph) + '</div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrStatus(w) { var el = w.querySelector('.rcz-status'); if (el) el.remove(); }
  // derive the Name:/Photo: status for a card from its detected scenario. Returns null while loading.
  function statusInfo(w, info) {
    if (!info || info.pending) return null;
    var hasPhoto = !!w.querySelector('img.rcz-photo');
    if (info.member === false && !info.misaligned) return null;  // casual guests: no top status band at all
    if (info.misaligned || info.paidMember)        return { nm: 'Mismatched (assignment error only)', nmW: true, ph: hasPhoto ? 'Showing' : 'No Match Required', phW: false };
    if (info.mismatch)                             return { nm: 'Not Matching', nmW: true, ph: hasPhoto ? 'Yes, see below' : 'Required Today (Add)', phW: !hasPhoto };
    if (info.family)                               return { nm: 'Names Required', nmW: true, ph: hasPhoto ? 'Showing' : 'Required Today', phW: !hasPhoto };
    if (info.closematch)                           return { nm: 'Not Matching', nmW: true, ph: hasPhoto ? 'Yes, see below' : 'Required Today', phW: !hasPhoto };
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
  function addActionReq(w, cardId, actions) {
    var el = w.querySelector('.rcz-actreq');
    if (!el) { el = document.createElement('div'); el.className = 'rcz-actreq'; w.appendChild(el); }
    var links = actions.map(function (a) {
      return '<a href="#" data-rcz-unlock="' + cardId + '"' + (a.href ? ' data-rcz-href="' + esc(a.href) + '"' : '') + '>' + esc(a.label) + '</a>';
    }).join('');
    var html = '<div class="rcz-actreq__hd">ACTION REQUIRED:</div><div class="rcz-actreq__links">' + links + '</div>';
    if (el.getAttribute('data-h') !== html) { el.innerHTML = html; el.setAttribute('data-h', html); }
  }
  function clrActionReq(w) { var el = w.querySelector('.rcz-actreq'); if (el) el.remove(); }
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
    clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); clrActionReq(w);
    var info = membershipInfo(host);
    ensureBotBar(w);
    var mHasPhoto = !!w.querySelector('img.rcz-photo');
    paintStatus(w, 'Matched', false, mHasPhoto ? 'Showing' : 'Required Today', !mHasPhoto);
    addMemStrip(w, info.uses);                                       // dark "MEMBERSHIP: N USES" strip
    addBadge(w, membershipTier(host));
    addMemName(w, info.type, info.first);
    var oldPanel = w.querySelector('.rcz-mem-info'); if (oldPanel) oldPanel.remove();  // drop old Starts/Ends panel
    // Birthday flag — top-right, same as ticket cards
    var memCardId = btn ? btn.id.replace('booking-details-button-', '') : null;
    var mbm = memCardId ? state.birthdays[memCardId] : null;
    if (CFG.SHOW_BIRTHDAY && mbm && birthdayInWindow(mbm)) { addBirthday(w, mbm); var mbd = w.querySelector('.rcz-bday'); if (mbd) mbd.style.top = '12px'; }
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
      if (!activeRoute()) {
        // not the booking check-in list -> strip our styling/overlays so ROLLER's native pages work
        var st = document.getElementById('rcz-style'); if (st) st.remove();
        document.querySelectorAll('.rcz-alert, .rcz-casual, .rcz-mismatch, .rcz-visiting, .rcz-badge, .rcz-note, .rcz-bday, .rcz-meaning, .rcz-status, .rcz-actreq, .rcz-botbar, .rcz-mem-info, .rcz-mem-name, .rcz-memstrip, img.rcz-photo').forEach(function (e) { e.remove(); });
        document.querySelectorAll('.rcz-alert-on, .rcz-casual-on, .rcz-mismatch-on, .rcz-visiting-on, .rcz-locked').forEach(function (w) { w.classList.remove('rcz-alert-on', 'rcz-casual-on', 'rcz-mismatch-on', 'rcz-visiting-on', 'rcz-locked'); });
        document.querySelectorAll('app-bip-summary.rcz-mem, app-bip-summary.rcz-skip').forEach(function (h) { h.classList.remove('rcz-mem', 'rcz-skip'); });
        document.querySelectorAll('app-bip-summary:not(.rcz-skip) button[id^="booking-details-button-"] mat-icon').forEach(function (ic) { ic.style.display = ''; });
        return;
      }
      injectStyle();
      markSkips();
      ensureShields();
      shorten();
      state.memLinks = membershipLinkMap();  // member name -> detail URL, scraped from the discounts panel
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
          var pm = (info.family || info.closematch) ? null : pillMismatchCheck(w, cardId);
          if (pm) {
            showMismatch(w, btn, icon, img, cardId, pm.memberName, pm.ticketName, info.tier);
          } else {
            addBadge(w, info.tier, memHref(info, cardId));
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
          clrMismatch(w); addActionReq(w, cardId, [{ label: 'Add a ticket' }, { label: 'Pass nickname' }]); clrAlert(w); clrCasual(w); clrVisiting(w); clrNote(w); if (info.tier) addBadge(w, info.tier, memHref(info, cardId)); else clrBadge(w);
        } else if (info && !info.pending && info.visiting) {
          // visiting overlay dropped from the redesign — a visiting member with no photo is treated
          // like any other no-photo member (standard "requires photo" alert), no "visiting" banner.
          if (img) img.remove();
          addAlert(w, memHref(info, cardId), cardId); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); if (info.family) addActionReq(w, cardId, [{ label: 'Add individual names', href: memHref(info, cardId) }]); else clrActionReq(w); if (info.tier) addBadge(w, info.tier, memHref(info, cardId)); else clrBadge(w);
        } else if (info && !info.pending && info.member) {
          var np = nativePhotoImg(btn);
          if (np) {
            // our membership lookup returned no photo, but ROLLER is already showing a real photo for this
            // member -> treat as photo-on-file: fill the square with it + badge, and DON'T raise the alert.
            if (icon) icon.style.display = 'none';
            np.style.display = 'none';
            if (!img) { img = document.createElement('img'); img.className = 'rcz-photo'; img.alt = ''; btn.appendChild(img); }
            var nsrc = np.getAttribute('src');
            if (img.getAttribute('src') !== nsrc) img.setAttribute('src', nsrc);
            var pmn = (info.family || info.closematch) ? null : pillMismatchCheck(w, cardId);
            if (pmn) {
              showMismatch(w, btn, icon, img, cardId, pmn.memberName, pmn.ticketName, info.tier);
            } else {
              addBadge(w, info.tier, memHref(info, cardId));
              clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w);
              memberNote(w, info, cardId);
            }
          } else {
            // matched member, genuinely no photo on file -> "requires photo" alert
            if (img) img.remove();
            addAlert(w, memHref(info, cardId), cardId); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); if (info.family) addActionReq(w, cardId, [{ label: 'Add individual names', href: memHref(info, cardId) }]); else clrActionReq(w); if (info.tier) addBadge(w, info.tier, memHref(info, cardId)); else clrBadge(w);
          }
        } else if (info && !info.pending && info.member === false) {
          // casual (non-member) -> big guest name heading + "Casual <type> Booking" + sub-line
          if (img) img.remove();
          var cnm = holderNameFor(w, cardId);
          var ccat = ((w.querySelector('.summary-detail__item--emphasis') || {}).textContent || '').trim();
          addCasual(w, cnm, ccat); clrAlert(w); clrMismatch(w); clrVisiting(w); clrNote(w); clrBadge(w); clrActionReq(w);
        } else {
          // still loading / unknown -> plain placeholder, no overlay
          if (img) img.remove();
          if (icon) icon.style.display = '';
          clrAlert(w); clrCasual(w); clrMismatch(w); clrVisiting(w); clrNote(w); clrBadge(w); clrActionReq(w);
        }
        // --- status band + prototype extras, independent of the card state above ---
        var si = statusInfo(w, info);
        if (si) paintStatus(w, si.nm, si.nmW, si.ph, si.phW); else clrStatus(w);
        if (!state.unlocked) state.unlocked = {};
        w.classList.toggle('rcz-locked', needsAction(w, info) && !state.unlocked[cardId]);
        var bm = state.birthdays[cardId];
        if (CFG.SHOW_BIRTHDAY && bm && birthdayInWindow(bm)) {
          addBirthday(w, bm);
          // keep it top-right, but if a top note banner (close-match / family) is present, drop the
          // cake to just below the banner so the two never overlap.
          var bd = w.querySelector('.rcz-bday'), nb = w.querySelector('.rcz-note');
          if (bd) bd.style.top = (nb && nb.offsetHeight) ? (nb.offsetHeight + 10) + 'px' : '12px';
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
  function openGuestTabSoon() {
    var start = Date.now();
    var iv = setInterval(function () {
      try {
        var g = document.getElementById('bip-detail-tab-customer');
        if (g) {
          if (g.getAttribute('aria-selected') === 'true') { clearInterval(iv); return; } // done
          g.click();
        }
        if (Date.now() - start > 5000) clearInterval(iv); // give up after ~5s
      } catch (e) { clearInterval(iv); }
    }, 120);
  }
  function installBadgeLinkNav() {
    if (window.__rczBadgeNav) return; window.__rczBadgeNav = true;
    document.addEventListener('click', function (ev) {
      try {
        if (ev.defaultPrevented) return;
        if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // let new-tab etc. through
        // ACTION-REQUIRED / "Add" links: unlock this card's shield (and, if the link carries an href,
        // forward to the member's tab so staff can add the photo/name) — nothing else.
        var unl = ev.target && ev.target.closest ? ev.target.closest('[data-rcz-unlock]') : null;
        if (unl) {
          ev.preventDefault(); ev.stopImmediatePropagation();
          var uid = unl.getAttribute('data-rcz-unlock');
          if (!state.unlocked) state.unlocked = {};
          if (uid) state.unlocked[uid] = true;
          var uhost = unl.closest ? unl.closest('.summary__wrapper') : null;
          if (uhost) uhost.classList.remove('rcz-locked');
          var uhref = unl.getAttribute('data-rcz-href');
          if (uhref && forwardToPill(uhref)) openGuestTabSoon();  // land on the Guest tab (add photo/name there)
          return;
        }
        // A) the tier badge link -> membership detail, else fall back to the card's tile
        var badge = ev.target && ev.target.closest ? ev.target.closest('a.rcz-badge--link') : null;
        if (badge) {
          if (badge.getAttribute('target') === '_blank') return;
          var href = badge.getAttribute('href');
          // if this card is currently in the "photo required" state, land on the Guest (photo) tab too —
          // but NOT for members who already have a photo (no alert), where the Membership tab is expected.
          var bhost = badge.closest ? badge.closest('app-bip-summary') : null;
          var bAlert = bhost ? bhost.querySelector('.rcz-alert[data-rcz-href]') : null;
          if (href && forwardToPill(href)) { ev.preventDefault(); openGuestTabSoon(); return; }
          var host = badge.closest ? badge.closest('app-bip-summary') : null;
          var tile = host ? host.querySelector('button[id^="booking-details-button-"]') : null;
          if (tile) { ev.preventDefault(); tile.click(); }
          return;
        }
        // B) clicking the photo/tile of ANY member card goes to THAT member's own profile (their specific
        //    membership slot) on the Guest tab — NOT ROLLER's ticket-holder page. Works for every member
        //    variation (matched photo, add-photo, mismatch, family, …); casual tiles have no membership so
        //    they fall through to ROLLER's native nav. preventDefault alone won't cancel ROLLER's own (click)
        //    handler, so we stopImmediatePropagation in this capture phase to kill the native nav first.
        var tileBtn = ev.target && ev.target.closest ? ev.target.closest('button[id^="booking-details-button-"]') : null;
        if (tileBtn) {
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
  function boot() {
    injectStyle();
    installBadgeLinkNav();
    render();
    var obs = new MutationObserver(function () {
      clearTimeout(window.__rczT);
      window.__rczT = setTimeout(render, 60);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
