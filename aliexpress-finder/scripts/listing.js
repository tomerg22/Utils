/* AliExpress DETAIL-PAGE reader — expands, then returns text AND images together.
 *
 * Pass the WHOLE contents of this file as the `text` argument of
 * mcp__Claude_Browser__javascript_tool. It installs `window.__aeListing`.
 *
 *   __aeListing.read()            // expand everything, return text + images + specs
 *   __aeListing.read().gallery    // big image URLs, ready for labels.sh
 *   __aeListing.changed(fp)       // did the page change since fingerprint fp?
 *
 * WHY THIS EXISTS (three measured failures, 2026-08-21, Tapo C222 session)
 *
 * 1. THE SPEC WAS IN THE PHOTO, NOT THE TEXT.
 *    A RUIHONG RH-15W listing never states its output current in any text
 *    field: the variant selector offers voltage only (labelled "Color"), and
 *    the spec table reads certification "NONE" and capacity ">1000VA" (junk
 *    for a 59 g part). The real rating — "OUTPUT: 9V1.6A" — is silkscreened
 *    on the case and legible in gallery image 1. Scraping text and reasoning
 *    from a customer review produced "~5W, ~0.55A", wrong by about 3x, and
 *    that wrong number was used to steer a recommendation.
 *    => read() ALWAYS returns `gallery` alongside the text. For hardware the
 *       label in the photo is the manufacturer's own spec and outranks every
 *       text field on the page.
 *
 * 2. THE PAGE WAS MUTATED AND NEVER RE-READ.
 *    The size "גודל: 8 ס"מ x 3.7 ס"מ x 2 ס"מ" (80x37x20 mm) lives in the
 *    COLLAPSED description. An early get_page_text legitimately missed it.
 *    Then "show more" was clicked 3x — page grew 6,567 -> 11,172 px — and only
 *    an IMAGE scan was run on the newly revealed content. The text was never
 *    re-read, and the answer was declared "not published anywhere" while
 *    sitting on screen.
 *    => read() expands FIRST and returns both channels in ONE call, so there
 *       is no window in which you can have expanded but only looked at images.
 *       changed(fp) proves whether a re-read is owed.
 *
 * 3. THE IMAGES WERE INVISIBLE TO document.querySelectorAll.
 *    On the detail page `document.querySelectorAll('img')` returns exactly ONE
 *    image (a 240x240 icon) while the page displays dozens. `_dida_config_.
 *    _init_data_` is EMPTY on detail pages (length 2) — it only carries data on
 *    SEARCH pages. The gallery lives behind a shadow root. A shadow-DOM walk
 *    found 74 images on the same page.
 *    => every collector here walks shadowRoot recursively. Never use a bare
 *       document.querySelectorAll for images on a detail page.
 *
 * NO setTimeout / NO async pacing. A hidden Browser pane throttles timers; a
 * waiting loop here times out the whole 30s tool call. Everything is
 * synchronous. Scroll nudges are fire-and-forget.
 */
(() => {
  const BIDI_RE = new RegExp('[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');
  const clean = (s) => (s || '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();

/* @shared:wallVerdict:start */
/* Decide how far to trust a page read: 'clear', 'blocked', or 'suspect'.
 *
 * WHY 'suspect' EXISTS (measured 2026-08-25, the jump-starter session)
 * The old check was a boolean over two LOUD markers: a punish URL, or
 * `nc_1_nocaptcha` / `Captcha Interception` in the text. A real wall arrived
 * in a quieter form and walked straight through it. Detail pages returned
 * 279,005 bytes of HTML with 957 bytes of rendered body text and ZERO
 * JSON-LD nodes. No marker matched that shape. The operator read the empty
 * body, reported "Not a wall — a rendering fault", and then built a whole
 * product comparison on top of that false negative, including telling the
 * user a review count was "not obtainable" when the page in fact held 1,633.
 *
 * Three rules come out of it, and all three are encoded below.
 *
 * 1. CONTENT IS THE ONLY PROOF OF NO-WALL. A wall's defining property is
 *    that it withholds content. So if data actually came back, say clear and
 *    stop worrying. If NOTHING came back, you do not get to assume why.
 *    This ordering is what keeps the check quiet: it cannot fire on a page
 *    that served you.
 *
 * 2. A QUIET MARKER IS NEVER DISMISSIBLE. In that session `punish` appeared
 *    in the HTML, the operator invented a reason it did not count ("standard
 *    anti-bot SDK, ships on normal pages") and never ran one command to
 *    check that. Constructing the explanation IS the failure mode. Here it
 *    returns 'suspect' and there is no argument that clears it except a
 *    check.
 *
 * 3. TEXT CANNOT SETTLE THIS — ONLY LOOKING CAN. A stalled render and an
 *    interstitial are identical from the text channel. Scraping harder will
 *    never separate them. That is why `note` mandates a screenshot: one call
 *    ends the ambiguity. This is the skill's own "one channel drew a blank
 *    and the blank was treated as a finding" defect, applied at last to
 *    block detection instead of only to product specs.
 *
 * signals:
 *   url        final URL after redirects
 *   text       rendered body text (document.body.innerText), or fetched body
 *   html       document.documentElement.outerHTML, or the fetched HTML, or ''
 *   dataNodes  count of usable data carriers found (JSON-LD scripts, an
 *              init-data anchor, parsed items). 0 means "nothing usable".
 *
 * NOT-A-WALL is still returned for a page that plainly is not an interstitial
 * — a short malformed response with no wall markers is a parse error, and
 * naming it that is more useful than crying wolf. 'suspect' fires only on
 * POSITIVE evidence, so it stays rare enough to be worth acting on.
 */
function wallVerdict(sig) {
  var url = (sig && sig.url) || '';
  var text = (sig && sig.text) || '';
  var html = (sig && sig.html) || '';
  var dataNodes = (sig && sig.dataNodes) || 0;
  var loud = [];

  if (/_____tmd_____|x5secdata/.test(url)) loud.push('punish-url');
  if (/nc_1_nocaptcha|Captcha Interception/i.test(text) ||
      /nc_1_nocaptcha|Captcha Interception/i.test(html)) loud.push('nocaptcha');
  if (/slide to verify|unusual traffic|please slide|יש להחליק|נא להחליק/i.test(text)) {
    loud.push('slider-text');
  }
  if (loud.length) {
    return {
      state: 'blocked', markers: loud,
      note: 'CONFIRMED anti-bot wall. STOP and tell the user THIS TURN, as the ' +
            'headline (SKILL.md step 2). Ask them to clear it. Do NOT navigate ' +
            'again while waiting — a fresh request re-arms the token.',
    };
  }

  /* Rule 1: content came back, so nothing withheld it. */
  if (dataNodes > 0) return { state: 'clear', markers: [], note: '' };

  /* No data. Every remaining branch is "I got nothing and must not guess why". */
  var quiet = [];
  if (/_____tmd_____|punish|x5secdata/.test(html)) quiet.push('punish-string-in-html');
  if (html.length > 50000 && text.length < 2000) quiet.push('big-html-no-content');
  if (!quiet.length) return { state: 'clear', markers: [], note: '' };

  return {
    state: 'suspect', markers: quiet,
    note: 'SUSPECTED wall — no usable data came back. Settle it with a SCREENSHOT ' +
          'before concluding anything: computer{action:"screenshot"} is ONE call and ' +
          'ends the ambiguity. Text alone CANNOT tell a wall from a stalled render. ' +
          'Until you have LOOKED, do NOT report "not blocked", and do NOT report the ' +
          'data as unavailable or the product as non-existent.',
  };
}
/* @shared:wallVerdict:end */

  /* Recursive walk THROUGH shadow roots. See failure 3 above. */
  function walk(root, fn) {
    let els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (const e of els) {
      fn(e);
      if (e.shadowRoot) walk(e.shadowRoot, fn);
    }
  }

  const SHOW_MORE = /^(להציג יותר|הצג עוד|show more|see more|view more|לפרטים נוספים)$/i;

  /* Size lines. The Hebrew storefront writes ס"מ / סמ / מ"מ; sellers also use
   * cm/mm/inch. Both "8 x 3.7 x 2" and "80*37*20mm" forms occur. */
  const SIZE_RE = new RegExp(
    '(?:גודל|מידות|מימדים|size|dimension[s]?)\\s*[:：]?\\s*' +
    '[^\\n]{0,80}?\\d+(?:\\.\\d+)?\\s*(?:ס"מ|ס״מ|סמ|מ"מ|מ״מ|cm|mm|inch|אינץ\'?)?' +
    '\\s*[x×*]\\s*[^\\n]{0,80}', 'i');
  const TRIPLE_RE = /\d+(?:\.\d+)?\s*(?:ס"מ|ס״מ|סמ|מ"מ|מ״מ|cm|mm)?\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:ס"מ|ס״מ|סמ|מ"מ|מ״מ|cm|mm)?\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:ס"מ|ס״מ|סמ|מ"מ|מ״מ|cm|mm)?/i;

  /* Electrical ratings: "OUTPUT:9V1.6A", "9V 0.6A 5W", "DC 12V/2A", "600mA". */
  const RATING_RE = /(?:output|input|פלט|כניסה)?\s*:?\s*\d+(?:\.\d+)?\s*V\s*[\/,]?\s*\d+(?:\.\d+)?\s*(?:A|mA)/i;
  const WATT_RE = /\d+(?:\.\d+)?\s*W\b/i;

  /* A "package" size is the shipping box, not the product. Callers must not
   * confuse the two — this cost a wrong report once already. */
  const PACKAGE_RE = /(חבילה|אריזה|package|packing|shipping)/i;

  const L = {
    /* Click every "show more" so collapsed description text is in the DOM.
     * Returns how many were clicked. Safe to call repeatedly. */
    expand(limit) {
      let clicked = 0;
      const cap = limit == null ? 8 : limit;
      walk(document, (e) => {
        if (clicked >= cap) return;
        if (e.children.length !== 0) return;
        const t = clean(e.textContent);
        if (!t || t.length > 24 || !SHOW_MORE.test(t)) return;
        const target = e.closest && (e.closest('button,[role="button"],a,div') || e);
        try { target.click(); clicked++; } catch (err) { /* not clickable */ }
      });
      return clicked;
    },

    /* Cheap content fingerprint. Compare before/after any mutation (expanding,
     * selecting a variant) to prove whether a re-read is owed — failure 2. */
    fingerprint() {
      let imgs = 0, leaves = 0;
      walk(document, (e) => {
        if (e.tagName === 'IMG') imgs++;
        if (e.children.length === 0) leaves++;
      });
      return {
        height: document.body ? document.body.scrollHeight : 0,
        textLen: (document.body && document.body.innerText || '').length,
        imgs, leaves,
      };
    },

    changed(fp) {
      if (!fp) return true;
      const now = this.fingerprint();
      return now.height !== fp.height || now.textLen !== fp.textLen ||
             now.imgs !== fp.imgs || now.leaves !== fp.leaves;
    },

    /* opts:
     *   expand      default true  — click "show more" before reading
     *   minNatural  default 400   — smallest naturalWidth counted as a real
     *                               product image (icons are 27x27 / 30x30)
     *   maxText     default 20000
     */
    read(opts) {
      opts = opts || {};
      const url = location.href;
      const bodyText = (document.body && document.body.innerText) || '';
      let pageHtml = '', ldCount = 0;
      try { pageHtml = (document.documentElement && document.documentElement.outerHTML) || ''; } catch (e) {}
      try { ldCount = document.querySelectorAll('script[type="application/ld+json"]').length; } catch (e) {}
      const verdict = wallVerdict({
        url: url, text: bodyText, html: pageHtml,
        dataNodes: ldCount || (bodyText.length > 2000 ? 1 : 0),
      });
      if (verdict.state !== 'clear') {
        return { blocked: verdict.state === 'blocked',
                 suspectedWall: verdict.state === 'suspect',
                 wall: verdict, url: url.slice(0, 120), note: verdict.note };
      }

      const before = this.fingerprint();
      const expanded = opts.expand === false ? 0 : this.expand();
      // Fire-and-forget scroll nudges so lazy content mounts. No timers.
      const h = document.body ? document.body.scrollHeight : 0;
      for (let y = 0; y <= h; y += Math.max(250, Math.floor(h / 24) || 250)) window.scrollTo(0, y);
      window.scrollTo(0, 0);
      const after = this.fingerprint();

      // ---- text channel -----------------------------------------------
      /* Leaf text is captured WITH its parent's text as context. Measured: the
       * carton size renders as a bare leaf "12x7x4 סמ" while the qualifier
       * "גודל החבילה" ("package size") sits in a SIBLING node. Testing the leaf
       * alone marks the shipping box as if it were the product. */
      const leaves = [];
      const seenLeaf = new Set();
      walk(document, (e) => {
        if (e.children.length !== 0) return;
        const t = clean(e.textContent);
        if (!t || t.length > 300 || seenLeaf.has(t)) return;
        seenLeaf.add(t);
        let ctx = '';
        try {
          const p = e.parentElement || (e.parentNode && e.parentNode.nodeType === 1 ? e.parentNode : null);
          ctx = p ? clean(p.textContent).slice(0, 240) : '';
        } catch (err) { ctx = ''; }
        leaves.push({ text: t, context: ctx });
      });

      const sizeLines = leaves
        .filter((l) => SIZE_RE.test(l.text) || TRIPLE_RE.test(l.text))
        .map((l) => ({
          text: l.text,
          // The qualifier may live in the leaf OR in its parent — check both.
          isPackage: PACKAGE_RE.test(l.text) || PACKAGE_RE.test(l.context),
          context: l.context && l.context !== l.text ? l.context.slice(0, 120) : undefined,
        }));
      const ratingLines = leaves
        .filter((l) => RATING_RE.test(l.text) || WATT_RE.test(l.text))
        .map((l) => l.text);

      // ---- image channel ----------------------------------------------
      const minNat = opts.minNatural == null ? 400 : opts.minNatural;
      const imgs = [];
      walk(document, (e) => {
        if (e.tagName !== 'IMG') return;
        const u = e.currentSrc || e.src;
        if (!u || !/aliexpress-media|alicdn/.test(u)) return;
        imgs.push({ u, nw: e.naturalWidth || 0, nh: e.naturalHeight || 0 });
      });
      const seen = new Set();
      const gallery = imgs
        .filter((i) => i.nw >= minNat)
        .sort((a, b) => b.nw * b.nh - a.nw * a.nh)
        .filter((i) => {
          // Dedupe by the CDN filename stem — the same asset appears at many
          // sizes (`....jpg`, `..._960x960.png_.avif`) and must count once.
          const k = (i.u.split('/').pop() || '').slice(0, 24);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

      // ---- variant selector --------------------------------------------
      const variants = [];
      walk(document, (e) => {
        const cls = (e.className && e.className.toString ? e.className.toString() : '');
        if (!/sku/i.test(cls)) return;
        const t = e.getAttribute && (e.getAttribute('title') || e.getAttribute('alt'));
        const v = clean(t || (e.children.length === 0 ? e.textContent : ''));
        if (v && v.length <= 40) variants.push(v);
      });

      return {
        blocked: false,
        url: url.slice(0, 140),
        expandedClicks: expanded,
        fingerprintBefore: before,
        fingerprint: after,
        pageGrew: after.height !== before.height || after.textLen !== before.textLen,
        variants: [...new Set(variants)].slice(0, 40),
        // Each entry: { text, isPackage, context? }. A `isPackage: true` line is
        // the SHIPPING CARTON, not the product — never report it as the size.
        sizeLines: sizeLines.slice(0, 25),
        productSizeLines: sizeLines.filter((s) => !s.isPackage).map((s) => s.text).slice(0, 10),
        packageSizeLines: sizeLines.filter((s) => s.isPackage).map((s) => s.text).slice(0, 10),
        ratingLines: ratingLines.slice(0, 40),
        galleryCount: gallery.length,
        gallery: gallery.slice(0, 20).map((i) => i.u),
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, opts.maxText || 20000),
        // Loud, because both halves were skipped in the failure this file exists for.
        reminder: 'Specs printed on the product PHOTO outrank every text field. ' +
                  'Download `gallery` with labels.sh and READ the label before quoting any rating. ' +
                  'A size line matching sizeLinesArePackage is the SHIPPING BOX, not the product.',
      };
    },
  };

  window.__aeListing = L;
  return 'aeListing ready — __aeListing.read() returns text AND images together';
})()
