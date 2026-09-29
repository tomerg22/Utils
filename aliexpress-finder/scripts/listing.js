/* AliExpress DETAIL-PAGE reader — expands, then returns text AND images together.
 *
 * Pass the WHOLE contents of this file as the `text` argument of
 * javascript_tool (in-app browser or Chrome connector). It installs
 * `window.__aeListing`. read() is ASYNC: drive it with a top-level await.
 *
 *   const r = await __aeListing.read()  // expand, read text + images + specs
 *   r.gallery                 // the product's OWN photos, full size, slider order
 *   r.descriptionImages       // images inside the description (drawings, spec tables)
 *   r.description.source      // 'rendered' | 'fetched' | 'missing' | 'fetch-failed' | 'blocked'
 *   r.reviews                 // { own, ownRating, header, pooledNote }
 *   r.variants                // the option selector only; selectedVariant too
 *   r.warnings, r.visibility  // read these first
 *   __aeListing.last          // the latest result, stored BEFORE the description
 *                             // fetch: if read() timed out, read this next call
 *   await __aeListing.read({ description: false })  // never fetch
 *   __aeListing.changed(fp)   // did the page change since fingerprint fp?
 *
 * The Chrome connector cuts a result at 1,000 characters, so there keep the
 * result on window (`window.__r = await __aeListing.read()`) and return the
 * fields you need in small pieces.
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
 * 4. THE GALLERY WAS OTHER PRODUCTS (measured 2026-09-29).
 *    "Every image of 400 px or more" returned 15 images for one listing and 8
 *    of them were not the product: related items (slick-slide carousel), the
 *    footer business-licence badge, and category menu icons. On a second
 *    listing it kept 1 of 9 product photos and dropped the other 8, because the
 *    slider serves them at 220 px. The product's photos all sit under the
 *    main-image--wrap container.
 *    => images are sorted by the page zone they sit in; `gallery` is the
 *       product zone only, restored to full size. Other products are counted
 *       in `excludedImages`, never returned as the product.
 *
 * 5. THE DESCRIPTION NEVER REACHED `text` (measured 2026-09-29).
 *    The description renders inside a SHADOW ROOT under #nav-description.
 *    `text` came from document.body.innerText, which never includes shadow
 *    content: "Weight: about 750 g" was on screen and absent from `text`.
 *    (The iframe under #nav-description held 3 empty elements whether the tab
 *    was visible or hidden; it is not the description.) In a HIDDEN tab the
 *    shadow content is not rendered at all, although the page did request
 *    the description document; fetching that same URL returned 200 with the
 *    text and 17 images.
 *    => the rendered description is read from its shadow tree (textOf), and
 *       read() fetches the document when the page has not rendered it. It is
 *       appended to `text` after [DESCRIPTION]. `description.source` says
 *       which happened; 'missing' means unknown, never "not stated".
 *
 * NO setTimeout / NO async pacing. A hidden tab delays timers (measured: a
 * 100 ms timer fired after 958 ms, a 2,500 ms one had not fired after 45 s),
 * so any wait inside the page can outlive the tool call. The only await is
 * the description fetch, which is a network call, not a timer. Scroll
 * nudges are fire-and-forget. In a hidden tab screenshots, zoom and
 * get_page_text also hang until the tool times out; read() reports
 * `visibility` and warns.
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

  /* @shared:reviewBlock:start */
  /* Read a detail page's review counts from its rendered text.
   *
   * WHY (measured 2026-09-25, 17 listings in two searches): the JSON-LD
   * reviewCount, the header "N Reviews" and the "Reviews (N)" tab are one and
   * the same number, and on most listings it is POOLED across similar items
   * from other sellers. The page says so: "Reviews displayed are from various
   * sellers for similar items on AliExpress". The review block carries a
   * second, smaller figure, "4.9 1090 ratings", which is the listing's own
   * count. Header vs own: 5,479 vs 1,090; 9,460 vs 1,914; 4,779 vs 488. On
   * the one listing without that note the two were equal (37 vs 37). Ranking
   * on the header ranked the pool, not the listing. "own" is inferred from the
   * page; no AliExpress documentation was found.
   *
   * own is null when the block is not found (the Hebrew wording has not been
   * observed). Null means UNKNOWN: never fall back to the pooled number.
   */
  function parseReviewBlock(text) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const num = (s) => Number(String(s).replace(/[.,](?=\d{3}(?:\D|$))/g, ''));
    const blk = t.match(/(\d\.\d)\s+(\d[\d,.]*)\s+ratings?\b(?=\s*All from verified)/i) ||
                t.match(/(\d\.\d)\s+(\d[\d,.]*)\s+ratings?\b/i);
    const head = t.match(/Reviews\s*\((\d[\d,.]*)\)/i) || t.match(/(\d[\d,.]*)\s+Reviews\b/i);
    const own = blk ? num(blk[2]) : null;
    const header = head ? num(head[1]) : null;
    return {
      own: Number.isFinite(own) ? own : null,
      ownRating: blk ? Number(blk[1]) : null,
      header: Number.isFinite(header) ? header : null,
      pooledNote: /from various sellers for similar items/i.test(t),
    };
  }
  /* @shared:reviewBlock:end */

  /* Recursive walk THROUGH shadow roots. See failure 3 above. */
  function walk(root, fn) {
    let els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (const e of els) {
      fn(e);
      if (e.shadowRoot) walk(e.shadowRoot, fn);
    }
  }

  /* The next node up, crossing a shadow root to its host, so an image inside
   * the description's shadow tree still finds #nav-description above it. */
  function up(n) {
    if (n.parentElement) return n.parentElement;
    try {
      const r = n.getRootNode && n.getRootNode();
      if (r && r.host) return r.host;
    } catch (e) {}
    return null;
  }

  /* Visible text under a root, shadow trees included, IN TREE ORDER.
   * innerText cannot do this job: it never includes shadow content
   * (failure 5). A walk that takes each element's own text nodes in
   * querySelectorAll order is not enough either: for
   * "<li><b>Weight:</b> about 680 g</li>" it yields "about 680 g Weight:",
   * because the <li> comes before the <b>. So this recurses through
   * childNodes. A host's shadow tree is read first, since that is what
   * renders. <style> and <script> are skipped: the description's shadow
   * root carries a <style>, and CSS is not product text. Block elements
   * add a space so "<li>A</li><li>B</li>" does not read "AB". */
  const SKIP_TEXT = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/;
  const BLOCK = /^(P|DIV|LI|UL|OL|BR|TR|TD|TH|TABLE|H[1-6]|SECTION|ARTICLE|DL|DT|DD)$/;
  function textOf(root) {
    const parts = [];
    const visit = (node, depth) => {
      if (!node || depth > 200) return;
      if (node.shadowRoot) visit(node.shadowRoot, depth + 1);
      for (const c of (node.childNodes || [])) {
        if (c.nodeType === 3) { parts.push(c.nodeValue); continue; }
        if (c.nodeType !== 1 || SKIP_TEXT.test(c.tagName || '')) continue;
        const block = BLOCK.test(c.tagName || '');
        if (block) parts.push(' ');
        visit(c, depth + 1);
        if (block) parts.push(' ');
      }
    };
    visit(root, 0);
    return clean(parts.join(''));
  }

  /* Which part of the page an image sits in. Class names are the live ones
   * (measured 2026-09-29 on two listings); the hash suffix after "--" varies,
   * so only the stem is matched. The NEAREST matching ancestor wins.
   *   product      main-image--wrap: the slider and the magnifier
   *   description  #nav-description / description--wrap (and its shadow tree)
   *   carousel     slick-slide/-track/-list, "recommend": other products
   *   footer       footer-copywrite: the business-licence badge
   *   menu         Categoey--: the category menu icons */
  function zone(e) {
    let n = e, d = 0;
    while (n && d < 60) {
      const c = typeof n.className === 'string' ? n.className : '';
      const id = typeof n.id === 'string' ? n.id : '';
      if (/(^|\s)main-image--/.test(c)) return 'product';
      if (id === 'nav-description' || /(^|\s)description--wrap/.test(c)) return 'description';
      if (/(^|\s)slick-(slide|track|list)\b|recommend/i.test(c)) return 'carousel';
      if (/(^|\s)footer/i.test(c)) return 'footer';
      if (/(^|\s)Categoey--|(^|\s)category/i.test(c)) return 'menu';
      n = up(n); d++;
    }
    return 'other';
  }

  /* The full-size asset behind a displayed image. The slider shows
   * "S…jpg_220x220q75.jpg_.avif"; the original is "S…jpg". The query string
   * is dropped too, because the Chrome connector blocks any result that
   * carries one. */
  function fullSize(u) {
    let s = String(u || '').split('?')[0];
    if (s.startsWith('//')) s = 'https:' + s;
    return s.replace(/(\.(?:jpe?g|png|webp|gif))_[^/]*$/i, '$1');
  }
  const stem = (u) => (String(u).split('/').pop() || '').slice(0, 24);
  const uniqByStem = (list) => {
    const seen = new Set();
    return list.filter((u) => { const k = stem(u); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  /* 'visible', 'hidden' or 'unknown'. See the hidden-tab note in the header. */
  function visibility() {
    try {
      return typeof document.visibilityState === 'string' ? document.visibilityState : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  /* Leaves of a DOM tree with their parent's text as context. Measured: the
   * carton size renders as a bare leaf "12x7x4 סמ" while the qualifier
   * "גודל החבילה" ("package size") sits in a SIBLING node. Testing the leaf
   * alone marks the shipping box as if it were the product. */
  function leavesOf(root, seenLeaf, out) {
    walk(root, (e) => {
      if (e.children.length !== 0) return;
      const t = clean(e.textContent);
      if (!t || t.length > 300 || seenLeaf.has(t)) return;
      seenLeaf.add(t);
      let ctx = '';
      try {
        const p = e.parentElement || (e.parentNode && e.parentNode.nodeType === 1 ? e.parentNode : null);
        ctx = p ? clean(p.textContent).slice(0, 240) : '';
      } catch (err) { ctx = ''; }
      out.push({ text: t, context: ctx });
    });
    return out;
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

  /* The description's own URL, from the requests the page already made.
   * Measured 2026-09-29: pdp.aliexpress-media.com/product/description/pc/v2/
   * <locale>/desc.htm, with productId/key/token/sellerId/v in the query. The
   * page requested it even in a hidden tab, but never rendered it there. */
  function descriptionUrl() {
    try {
      const perf = window.performance;
      const names = perf && perf.getEntriesByType ? perf.getEntriesByType('resource').map((x) => x.name) : [];
      return names.find((n) => /\/product\/description\/pc\//.test(n)) || null;
    } catch (e) { return null; }
  }

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

    /* The product description: rendered text if the page drew it, otherwise
     * the same document fetched from the URL the page already requested.
     *   source  'rendered' | 'fetched' | 'missing' | 'fetch-failed'
     *           | 'blocked' | 'suspect-wall'
     *           (read() adds 'pending' before the fetch settles and
     *           'skipped' for read({ description: false }))
     * Everything except 'rendered' and 'fetched' means UNKNOWN, never "the
     * listing states nothing": the text may hold the size, weight and
     * package contents. */
    async description() {
      let box = null;
      walk(document, (e) => {
        if (box) return;
        const c = typeof e.className === 'string' ? e.className : '';
        if (e.id === 'nav-description' || /(^|\s)description--wrap/.test(c)) box = e;
      });
      if (box) {
        // Rendered: its leaves and images are already in the page walk.
        const text = textOf(box);
        if (text.length >= 50) return { source: 'rendered', text, leaves: [], images: [] };
      }
      const u = descriptionUrl();
      if (!u) return { source: 'missing', text: '', leaves: [], images: [] };
      try {
        const res = await window.fetch(u);
        const html = await res.text();
        const Parser = window.DOMParser;
        const doc = new Parser().parseFromString(html, 'text/html');
        const text = textOf(doc.body || doc);
        const images = [];
        walk(doc, (e) => {
          if (e.tagName !== 'IMG') return;
          const s = (e.getAttribute && (e.getAttribute('src') || e.getAttribute('data-src'))) || '';
          if (/aliexpress-media|alicdn/.test(s)) images.push(fullSize(s));
        });
        /* Seller copy can contain a wall phrase ("please slide the drum
         * in"), so the TEXT markers count only when the fetch returned
         * nothing usable. The URL (a redirect to the punish page) and the
         * HTML (the captcha widget) are always checked. A wall here is a
         * real wall: read() raises it to its own top-level `blocked`. */
        const usable = text.length >= 50 || images.length > 0;
        const v = wallVerdict({ url: res.url || '', text: usable ? '' : text, html, dataNodes: usable ? 1 : 0 });
        if (v.state !== 'clear') {
          return { source: v.state === 'blocked' ? 'blocked' : 'suspect-wall',
                   text: '', leaves: [], images: [], wall: v };
        }
        const leaves = leavesOf(doc, new Set(), []);
        return { source: 'fetched', text, leaves, images };
      } catch (e) {
        return { source: 'fetch-failed', text: '', leaves: [], images: [], error: String(e).slice(0, 120) };
      }
    },

    /* The latest read() result. read() stores a complete result here BEFORE
     * it awaits the description fetch (description.source 'pending'), and
     * replaces it when the fetch settles. If read() times out (a stalled
     * fetch in a hidden tab), return fields from `__aeListing.last` in the
     * next call instead of losing the whole read. */
    last: null,

    /* async: `await __aeListing.read()`. It fetches the description when the
     * page has not rendered it (a hidden tab never does).
     * opts:
     *   expand       default true  — click "show more" before reading
     *   description  default true  — false skips the fetch (source 'skipped')
     *   minNatural   default 400   — smallest naturalWidth counted when the
     *                                product-image container is NOT found and
     *                                the gallery falls back to every big image
     *   maxText      default 20000
     */
    async read(opts) {
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
      // Path only in every result: a punish URL carries x5secdata=... and the
      // Chrome connector blocks any result holding a query string. The path
      // (/_____tmd_____/punish) still names the wall.
      const pageUrl = (location.origin || '') + (location.pathname || '');
      const vis = visibility();
      if (verdict.state !== 'clear') {
        this.last = { blocked: verdict.state === 'blocked',
                      suspectedWall: verdict.state === 'suspect',
                      wall: verdict, url: pageUrl.slice(0, 120), note: verdict.note, visibility: vis };
        return this.last;
      }

      const before = this.fingerprint();
      const expanded = opts.expand === false ? 0 : this.expand();
      // Fire-and-forget scroll nudges so lazy content mounts. No timers.
      const h = document.body ? document.body.scrollHeight : 0;
      for (let y = 0; y <= h; y += Math.max(250, Math.floor(h / 24) || 250)) window.scrollTo(0, y);
      window.scrollTo(0, 0);
      const after = this.fingerprint();

      // ---- text channel (page part) ------------------------------------
      const pageLeaves = leavesOf(document, new Set(), []);

      // ---- image channel ----------------------------------------------
      /* Images are sorted by WHERE they sit (failure 4). Measured 2026-09-29:
       * the old "every image of 400 px or more" returned 15 images for one
       * listing, and 8 were not the product (related items, the footer
       * licence badge, category menu icons); on another listing it kept one
       * product photo and dropped the other 8, because the slider serves
       * them at 220 px. Product photos now come from their container at any
       * size and are returned at full size, in slider order. */
      const minNat = opts.minNatural == null ? 400 : opts.minNatural;
      const own = [], descImgs = [], big = [];
      const excluded = {};
      walk(document, (e) => {
        if (e.tagName !== 'IMG') return;
        const raw = e.currentSrc || e.src || (e.getAttribute && e.getAttribute('data-src')) || '';
        if (!raw || !/aliexpress-media|alicdn/.test(raw)) return;
        const nw = e.naturalWidth || 0, nh = e.naturalHeight || 0;
        const z = zone(e);
        if (nw >= minNat) big.push({ u: fullSize(raw), area: nw * nh });
        // A loaded image under 100 px is a play button or an icon; 0 means
        // not loaded yet, which lazy slider images often are — keep those.
        if (nw > 0 && nw < 100) return;
        if (z === 'product') own.push(fullSize(raw));
        else if (z === 'description') descImgs.push(fullSize(raw));
        else if (nw >= minNat) excluded[z] = (excluded[z] || 0) + 1;
      });
      let gallery = uniqByStem(own);
      let galleryScope = 'product';
      if (!gallery.length) {
        // Layout changed or the slider did not mount: fall back LOUDLY.
        galleryScope = 'unscoped';
        gallery = uniqByStem(big.sort((a, b) => b.area - a.area).map((i) => i.u));
      }

      // ---- variant selector --------------------------------------------
      /* Options come ONLY from the option selector. This used to take any
       * element whose class mentioned "sku", and on 2026-09-25 that returned
       * the variant lines of REVIEWS, many of them other sellers' items
       * ("Color:9 Key no light Ships From: China"), instead of the listing's
       * own options (White / Black / 1Pcs Random Color / 3Pcs Random Color).
       * The default option's price is the one JSON-LD reports, so which option
       * is selected matters: a $2.14 "keychain" was the 1-key one, not the
       * 9-key pad in the title. Live class names: sku-item--image--<hash>,
       * sku-item--text--<hash>, sku-item--selected--<hash> on the same node. */
      const variants = [];
      let selectedVariant = null;
      walk(document, (e) => {
        const cls = (e.className && e.className.toString ? e.className.toString() : '');
        if (!/sku-item--(image|text)|sku-property-item/.test(cls)) return;
        const img = e.querySelector ? e.querySelector('img') : null;
        const v = clean((img && img.getAttribute && (img.getAttribute('alt') || img.getAttribute('title'))) ||
                        (e.getAttribute && e.getAttribute('title')) || e.textContent);
        if (!v || v.length > 60) return;
        variants.push(v);
        if (!selectedVariant && /sku-item--selected|\bselected\b|\bactive\b/i.test(cls)) selectedVariant = v;
      });

      // Review counts, read AFTER expanding: the review block renders lazily.
      const reviews = parseReviewBlock((document.body && document.body.innerText) || '');
      const pageText = (document.body.innerText || '').replace(/\s+/g, ' ');

      // Everything that depends on the description, built twice: once with
      // a 'pending' description (stored in `last` before the fetch), once
      // with the real one.
      const build = (desc) => {
        const seen = new Set(pageLeaves.map((l) => l.text));
        const leaves = pageLeaves.slice();
        for (const l of desc.leaves) {
          if (!seen.has(l.text)) { seen.add(l.text); leaves.push(l); }
        }
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
        const descriptionImages = uniqByStem([...descImgs, ...desc.images]);

        const warnings = [];
        let top = { blocked: false };
        if (galleryScope === 'unscoped') {
          warnings.push('gallery-unscoped: no product-image container was found, so `gallery` holds ' +
                        'every big image on the page, including other products. Check each one.');
        }
        if (desc.wall) {
          // A wall answered the description fetch: the same STOP as a page wall.
          top = { blocked: desc.wall.state === 'blocked', suspectedWall: desc.wall.state === 'suspect',
                  wall: desc.wall, note: 'description fetch: ' + desc.wall.note };
          warnings.push('description-' + desc.source + ': a wall answered the description fetch. ' +
                        (desc.wall.state === 'blocked' ? 'STOP and tell the user this turn (SKILL.md step 2).'
                                                       : 'Take a screenshot before concluding anything.'));
        } else if (desc.source === 'pending') {
          warnings.push('description-pending: the description fetch has not finished. If read() timed out, ' +
                        'return fields from __aeListing.last in the next call; its description.source ' +
                        'changes when the fetch settles.');
        } else if (desc.source !== 'rendered' && desc.source !== 'fetched') {
          warnings.push('description-' + desc.source + ': the description was not read. Its text often ' +
                        'holds the size, weight and package contents. Do NOT report those as absent.');
        }
        if (vis === 'hidden') {
          warnings.push('tab-hidden: screenshots, zoom and get_page_text hang until the tool times out, ' +
                        'and page timers are delayed. Ask the user to bring the browser window to the ' +
                        'front before any screenshot. javascript_tool keeps working.');
        }

        return Object.assign(top, {
          url: pageUrl.slice(0, 140),
          visibility: vis,
          warnings,
          expandedClicks: expanded,
          fingerprintBefore: before,
          fingerprint: after,
          pageGrew: after.height !== before.height || after.textLen !== before.textLen,
          variants: [...new Set(variants)].slice(0, 40),
          selectedVariant,
          // { own, ownRating, header, pooledNote }. `own` is the listing's own
          // rating count; `header` equals JSON-LD reviewCount and is usually
          // pooled across other sellers. Rank on `own`; null means unknown.
          reviews,
          // Each entry: { text, isPackage, context? }. A `isPackage: true` line is
          // the SHIPPING CARTON, not the product — never report it as the size.
          sizeLines: sizeLines.slice(0, 25),
          productSizeLines: sizeLines.filter((s) => !s.isPackage).map((s) => s.text).slice(0, 10),
          packageSizeLines: sizeLines.filter((s) => s.isPackage).map((s) => s.text).slice(0, 10),
          ratingLines: ratingLines.slice(0, 40),
          // The product's own photos, full size, slider order. `galleryScope`
          // 'unscoped' means the fallback ran: see `warnings`.
          galleryScope,
          galleryCount: gallery.length,
          gallery: gallery.slice(0, 20),
          // Images inside the description: dimension drawings and spec tables
          // usually live here, not in the gallery.
          descriptionImages: descriptionImages.slice(0, 30),
          // Big images that are NOT this product, counted by where they sat.
          excludedImages: excluded,
          description: { source: desc.source, textLen: desc.text.length, imageCount: descriptionImages.length },
          text: (pageText + (desc.text ? ' [DESCRIPTION] ' + desc.text : '')).slice(0, opts.maxText || 20000),
          // Loud, because both halves were skipped in the failure this file exists for.
          reminder: 'Specs printed on the product PHOTO outrank every text field. ' +
                    'Download `gallery` AND `descriptionImages` with labels.sh and READ the label before quoting any rating. ' +
                    'A size line with isPackage: true is the SHIPPING BOX, not the product.',
        });
      };

      const none = (source) => ({ source, text: '', leaves: [], images: [] });
      if (opts.description === false) {
        this.last = build(none('skipped'));
        return this.last;
      }
      this.last = build(none('pending'));
      const desc = await this.description();
      this.last = build(desc);
      return this.last;
    },
  };

  window.__aeListing = L;
  return 'aeListing ready — await __aeListing.read() returns text AND images together';
})()
