# aliexpress-finder

A [Claude Code](https://claude.com/claude-code) skill that finds the best
AliExpress listings for a described product and returns the top 4 with evidence.

## Why it exists

AliExpress ranking signals are easy to misread:

- **Raw rating is not comparable.** 5.0 from 3 reviews is weaker evidence than
  4.8 from 5,000. Ratings are shrunk toward the pool mean, weighted by evidence.
- **Sold counts are bucketed** and saturate at `10,000+`, so the top of any
  category ties. The tie-break is the exact review count, read from JSON-LD on
  the detail page.
- **A real brand name does not mean a real product.** Listings are checked for
  price/spec plausibility, so a counterfeit wearing a strong brand is demoted
  rather than promoted.

## Install

```bash
git clone https://github.com/tomerg22/Utils.git
cp -r Utils/aliexpress-finder ~/.claude/skills/
```

Then invoke it in Claude Code:

```
/aliexpress-finder cordless drill with one battery
```

Requires the in-app browser tools (`mcp__Claude_Browser__*`), so it runs in local
Claude Code only — not in cloud sessions or scheduled routines.

## Layout

| File | Role |
|------|------|
| `SKILL.md` | The skill: 8-step workflow plus gotchas verified against the live site |
| `scripts/extract.js` | Browser-side extractor. Reads the page's embedded `_dida_config_._init_data_` payload (~60 records), falls back to DOM scraping, and flags captcha interstitials |
| `scripts/rank.mjs` | Scoring: shrunk quality + log-scaled volume + optional brand score |
| `scripts/lib.mjs` | Pure helpers shared by the ranker and the tests |
| `scripts/test.mjs` | Test suite — 52 assertions |

## Tests

```bash
node scripts/test.mjs
```

Covers the scoring guarantees and carries regression guards for three defects
found during live runs: `.`-as-thousands-separator sold counts (`4.000+`) parsing
as `4`, DOM extraction capping at 13 of 60 records, and a missing brand score
being treated as `0` — which let a counterfeit outrank a legitimately
brandless listing.

`extract.js` runs in the browser and cannot import `lib.mjs`, so it inlines
`parseSold` between `@shared:parseSold` markers. The test suite asserts the two
copies agree on every fixture, so they cannot silently drift.

## Note on scale

Fine for occasional personal shopping. AliExpress's Terms of Use prohibit
systematic retrieval of site content to build a collection or database — don't
turn this into a bulk harvester.
