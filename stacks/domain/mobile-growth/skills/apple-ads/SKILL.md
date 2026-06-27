---
name: apple-ads
description: "Understand Apple Ads and App Store acquisition mechanics. Use when evaluating Apple Search Ads / Apple Ads placements, campaign structure, keyword strategy, custom product pages, customer type targeting, attribution via AdServices or AdAttributionKit, App Store creative alignment, or Apple app-growth cost planning such as CPT, CPA, ROAS, and budget scenarios."
---

# Apple Ads

Use this skill when reasoning about paid growth in the App Store ecosystem.
It is for **Apple Ads** strategy and operations, not StoreKit billing or app
review.

## When to Use This Skill

- The user asks about Apple Search Ads / Apple Ads.
- You need to explain App Store ad placements or campaign structure.
- You need to compare Apple acquisition costs, CPT, CPA, CPI, or ROAS.
- You need to reason about custom product pages, ad variations, or keyword
  strategy.
- You need to refresh Apple Ads guidance from official docs or recent
  benchmark sources.

## What Exists in the Apple Ads Ecosystem

As of 2025-2026, the practical Apple app-growth stack is:

- **Search Results ads**: the highest-intent App Store placement; users have
  already typed a query.
- **Search Tab ads**: discovery before the user searches; broader reach,
  lower intent.
- **Today Tab ads**: premium awareness placement on the App Store front page;
  best for launches, tentpole moments, or large bursts.
- **Product Pages ads**: contextual reach in the "You Might Also Like" area
  on app product pages.
- **Custom Product Pages (CPPs)**: App Store landing pages tailored to
  keyword themes, feature themes, geographies, or campaigns.
- **Ad variations**: connect different campaign themes to different CPPs.
- **AdServices attribution API**: the main deterministic measurement API for
  Apple Ads itself.
- **AdAttributionKit**: privacy-preserving attribution for broader ad
  measurement and postback handling outside the older SKAdNetwork mindset.

## How Apple Ads Works Operationally

### Placement Strategy

- Treat **Search Results** as the core direct-response channel.
- Treat **Search Tab** and **Today Tab** as upper-funnel or launch support,
  then judge them by downstream quality, not raw volume.
- Treat **Product Pages** as contextual conquesting and adjacent-category
  discovery.

### Campaign Structure

Apple's best-practice structure is still the right default:

1. **Brand**: your app name, company name, and close brand variants.
2. **Category**: high-intent non-brand keywords describing the job your app
   does.
3. **Competitor**: competitor app names and adjacent alternatives.
4. **Discovery**: Search Match plus broad match to mine new terms.

Keep these separated so you can:

- see what you are actually buying,
- protect brand cheaply,
- prevent competitor and discovery traffic from muddying performance, and
- move proven search terms into exact-match campaigns with tighter bidding.

### Keywords and Search Terms

- **Exact match** belongs in Brand, Category, and Competitor campaigns.
- **Broad match** belongs mostly in Discovery.
- **Search Match** is a mining tool, not a substitute for campaign structure.
- Use **negative keywords** aggressively to stop overlap and irrelevance.
- Review the **search terms report** regularly and promote winners out of
  Discovery.

### Audience Refinements

Apple Ads audience settings matter, but search intent usually matters more.

Use refinements when there is a real reason:

- **Customer type**: new users, returning users, or users of your other apps.
- **Device**: iPhone vs iPad when monetization or conversion differs.
- **Location**: only when the app or offer is meaningfully geo-specific.
- **Demographics**: use carefully; intent usually beats inferred profile data.

### Creative and Landing Surface

- Do not point every campaign at the default product page.
- Build **Custom Product Pages** around specific feature or keyword themes.
- Match screenshots, preview video, subtitle, and promotional text to the
  user's likely reason for tapping.
- Use **ad variations** to map keyword clusters or campaigns to the right CPP.
- Treat CPPs as a conversion lever, not just a merchandising asset.

## Cost Model and Planning Concepts

### Core Buying Logic

- Apple Ads is an **auction system**.
- In **manual bidding**, model around **max CPT** for the search-led parts of
  the system.
- In **automated bidding** for eligible search-results campaigns, model around
  **Target CPA / Maximize Conversions**.
- Budgeting still needs enough volume for the algorithm to learn; underfunded
  campaigns usually produce noisy, misleading results.

### Practical Metrics

- **CPT**: cost per tap; the direct bid/control concept for search-led buying.
- **TTR**: tap-through rate; use it to judge keyword and creative relevance.
- **Conversion rate**: store tap to install.
- **CPA / CPI**: acquisition cost; what finance and growth actually care about.
- **ROAS**: use when the app has meaningful post-install revenue data.

### Directional Cost Expectations

Use benchmark numbers as directional, not as promises. Apple does not publish
market-average costs.

- Search Results is usually the most efficient Apple placement because intent
  is highest.
- Search Tab and Today Tab are typically broader-reach and lower-intent, so
  they need different success criteria.
- US, Games, Finance, and other competitive categories are materially more
  expensive than lower-intent regions and softer categories.

Use [references/benchmark-notes.md](references/benchmark-notes.md) for working
benchmark ranges and caveats.

## Attribution and Measurement Reality

- For **Apple Ads itself**, start with the **AdServices attribution API**.
- For broader privacy-preserving install and re-engagement measurement on iOS,
  understand **AdAttributionKit**.
- Treat **SKAdNetwork** as legacy context you may still encounter, not the only
  framing.
- **ATT** still constrains what other networks can do; Apple Ads benefits from
  its first-party App Store position.
- For revenue optimization, do not stop at installs. Join Apple Ads data with
  in-app revenue, renewal, and retention data before making big spend calls.

## Operational Advice

- Defend brand terms first. Letting competitors buy your brand is unforced
  waste.
- Separate discovery from exploitation. Discovery finds terms; exact-match
  campaigns scale them.
- Use CPPs wherever search intent clearly differs by theme or feature.
- Judge Search Tab and Today Tab on blended incremental value, not on direct
  install cost alone.
- Revisit budget caps before declaring a campaign "bad"; many Apple Ads
  campaigns are just underfed.
- Mine returning users separately if reacquisition economics are strong.

## Common Mistakes

- Mixing brand, category, competitor, and discovery traffic in one campaign.
- Running Discovery forever without graduating winning terms.
- Using the default product page for every keyword theme.
- Evaluating all placements with the same KPI.
- Treating Apple Ads installs as automatically high quality without checking
  retention, trial start, renewal, or payer mix.
- Assuming ATT-era attribution means "measurement is impossible" instead of
  building a practical first-party reporting loop.

## Refresh Workflow

When this skill may be stale:

1. Read [references/official-links.md](references/official-links.md) first.
2. Re-check Apple Ads help pages for placements, bidding, attribution, and
   reporting definitions.
3. Re-check Apple developer docs for CPPs, Apple Ads APIs, and
   AdAttributionKit.
4. Use benchmark sources only to set directional priors, never as hard budget
   guarantees.

## References

- [Official links](references/official-links.md)
- [Benchmark notes](references/benchmark-notes.md)