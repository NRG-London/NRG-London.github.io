# neilgarratt.com — Project Summary

## Overview

Personal portfolio website for Neil Garratt, Conservative London Assembly Member for Croydon & Sutton and Chair of the Budget & Performance Committee. The site replaces an outdated Squarespace site with a Hugo static site hosted on GitHub Pages.

## Objectives

1. **Personal brand, not party template.** Differentiate from the ubiquitous Bluetree-hosted sites used by most Conservative politicians, while still clearly displaying party branding.
2. **Editorial feel.** The site should read more like a magazine profile than a campaign leaflet — serious, data-driven, distinctive.
3. **Low maintenance.** Adding a new media appearance or campaign page should take minutes, not hours. Content is markdown files with structured front matter.
4. **Free hosting.** GitHub Pages with a custom domain. No ongoing hosting costs.
5. **Substack integration.** The newsletter/blog lives on Substack (for its email distribution capabilities). The site pulls recent post titles via RSS and links through to Substack — no content duplication.
6. **Video hosted externally.** YouTube embeds for TV appearances, Assembly clips, and campaign launch events. Keeps the repository well under GitHub Pages' 1GB limit.

## Key Design Decisions

### Colour Palette (Locked In)

| Role | Colour | Hex |
|------|--------|-----|
| Background (sage mist) | Very subtle green-grey | `#f3f6f4` |
| Primary accent | Conservative blue | `#0070BA` |
| Deep / dark sections | Navy-charcoal | `#1a2332` |
| Borders | Warm grey-green | `#dde3df` |
| Muted text | Mid sage grey | `#8a9490` |
| Blue light tint | Pale blue | `#E2EEF7` |
| Blue dark (hover) | Deep blue | `#004d80` |
| Ink (body text) | Dark navy | `#1a2332` |
| Card backgrounds | White | `#ffffff` |

The sage mist background was chosen because it:
- Subtly echoes the green of the Conservative tree logo
- Avoids the cold/icy feeling of a blue-tinted background
- Provides warmth without the peachy undertone of cream/parchment
- Reads as "slightly different" without being nameable — distinctive but not distracting

### Typography

- **Headings:** Libre Baskerville (serif) — editorial, authoritative
- **Body / UI:** DM Sans (sans-serif) — clean, modern, good at small sizes
- Both loaded from Google Fonts

### Party Branding

- Full "Conservatives" wordmark with tree in the nav bar (transparent PNG)
- Tree logo + "Conservative Party" text badge in the bio sidebar
- Party branding is present and clear but does not dominate the visual identity
- The green of the tree logo harmonises with the sage mist background
- Imprint line in footer (legally required)

### Site Structure

```
Homepage
├── Hero (name, role, intro, portrait photo)
├── Current Campaigns (top 3, linking to full pages)
├── In the Media (recent 4, dark band, linking to archive)
├── Newsletter (Substack RSS feed, subscribe CTA)
├── About (bio text + sidebar facts)
└── Contact (email, social links)

/campaigns/          → Campaign archive (all campaigns, newest first)
/campaigns/{slug}/   → Individual campaign page (rich content hub)

/media/              → Media archive (all appearances, filterable by type)
/media/{slug}/       → Individual media item page

/about/              → Full about/bio page
```

### Content Types

**Campaigns** — each campaign is a content hub that can include:
- Summary text and detailed analysis
- Embedded YouTube videos (launch events, interviews)
- Downloadable PDF reports (hosted in /static/reports/)
- Links to related press coverage
- Links to related Substack posts
- Timeline of key dates/events

Front matter fields:
```yaml
title: "Tunnel Toll Tax"
date: 2025-03-01
category: "Transport"           # Transport, Accountability, Local, etc.
status: "active"                # active, completed, archived
summary: "One-line summary for cards and meta description"
hero_stat: "£X.Xm"             # Optional headline number for the card
hero_stat_label: "in fines"     # Label for the headline number
```

**Media** — each appearance is a single item:
```yaml
title: "The Big Debate: Court backlogs and criminal justice"
date: 2025-03-15
type_label: "TV"                # TV, Op-Ed, Assembly, Radio, Podcast
outlet: "ITV London"
youtube_id: "dQw4w9WgXcQ"      # Optional — for video embeds
external_url: ""                # Optional — link to article/clip
summary: "Brief description"
```

### Newsletter / Substack Integration

The homepage newsletter section:
1. Shows a title ("The View from City Hall"), description, and subscribe button
2. Pulls recent post titles and dates from the Substack RSS feed
3. Each title links to the Substack post URL
4. All reading and subscribing happens on Substack — no content duplication

Implementation: Hugo's built-in `getJSON` or a JavaScript fetch of the Substack RSS feed (converted to JSON via a public RSS-to-JSON service, or parsed client-side). The JS approach is simpler and doesn't require rebuilding the site when a new Substack post goes up.

### External Services

| Service | Purpose |
|---------|---------|
| GitHub Pages | Hosting |
| Google Fonts | Typography (Libre Baskerville, DM Sans) |
| YouTube | Video hosting for TV clips, Assembly footage, campaign videos |
| Substack | Newsletter/blog — RSS feed pulled into homepage |

## Technical Architecture

### Hugo Project Structure

```
neilgarratt.com/
├── hugo.toml                    # Site configuration
├── projectsummary.md            # This file
├── content/
│   ├── _index.md                # Homepage content
│   ├── about/_index.md          # About page content
│   ├── campaigns/
│   │   ├── _index.md            # Campaign archive page
│   │   ├── tunnel-toll-tax.md
│   │   ├── tfl-operating-surplus.md
│   │   └── heavier-buses-weaker-roads.md
│   └── media/
│       ├── _index.md            # Media archive page
│       ├── itv-big-debate-court-backlogs.md
│       ├── cityam-hammersmith-bridge.md
│       └── ...
├── layouts/
│   ├── _default/
│   │   ├── baseof.html          # Base template (head, nav, footer)
│   │   ├── list.html            # Default list template
│   │   └── single.html          # Default single page template
│   ├── index.html               # Homepage template
│   ├── campaigns/
│   │   ├── list.html            # Campaign archive
│   │   └── single.html          # Individual campaign page
│   ├── media/
│   │   ├── list.html            # Media archive with type filters
│   │   └── single.html          # Individual media item
│   ├── partials/
│   │   ├── head.html            # <head> tag with meta, fonts, CSS
│   │   ├── nav.html             # Navigation bar
│   │   ├── footer.html          # Footer with imprint
│   │   └── campaign-card.html   # Reusable campaign card component
│   └── shortcodes/
│       └── youtube.html         # YouTube embed shortcode
├── static/
│   ├── css/
│   │   └── main.css             # All styles
│   ├── images/
│   │   ├── conservative-logo.png
│   │   ├── neil-portrait.jpg    # To be supplied
│   │   └── ...
│   └── reports/                 # PDF reports for download
│       └── ...
└── .github/
    └── workflows/
        └── deploy.yml           # GitHub Actions auto-deploy
```

### Deployment

- **Build:** GitHub Actions workflow triggers on push to `main` branch
- **Host:** GitHub Pages with custom domain `neilgarratt.com`
- **DNS:** CNAME record pointing to `{username}.github.io`
- **HTTPS:** Automatic via GitHub Pages (Let's Encrypt)

### Content Workflow

**To add a new media appearance:**
1. Create `content/media/yyyy-mm-dd-short-title.md`
2. Fill in the front matter (title, date, type_label, outlet, youtube_id or external_url, summary)
3. Optionally add body text with more detail
4. Commit and push — site rebuilds automatically

**To add a new campaign:**
1. Create `content/campaigns/campaign-slug.md`
2. Fill in front matter (title, date, category, status, summary)
3. Write the body content in markdown — can include YouTube shortcodes, links to PDFs, etc.
4. Commit and push

**To update the homepage hero or bio:**
- Edit `content/_index.md` or `content/about/_index.md`
- Commit and push

## Content Still Needed

- [ ] Portrait photo (high-quality, for hero section)
- [ ] High-resolution Conservative logo (transparent PNG or SVG — current version works but ideally request official vector from CCHQ)
- [ ] Full bio text (review and update the draft in the mockup)
- [ ] Campaign content for each active campaign page
- [ ] Media items — list of all appearances to date with YouTube IDs / article URLs
- [ ] Substack URL for RSS integration
- [ ] Social media profile URLs (X, YouTube, Substack, LinkedIn)
- [ ] Confirmation of promoted-by imprint text

## Revision History

| Date | Change |
|------|--------|
| 2026-03-18 | Initial design mockup and colour exploration |
| 2026-03-18 | Locked in sage mist (#f3f6f4) background + Conservative blue (#0070BA) palette |
| 2026-03-18 | Confirmed Hugo + GitHub Pages architecture |
| 2026-03-18 | Hugo project scaffolding and templates created |
