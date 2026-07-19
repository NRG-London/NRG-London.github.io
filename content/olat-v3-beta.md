---
title: "OLAT Explorer v3 — Beta"
build:
  list: never
  render: always
sitemap:
  disable: true
---

This is a **beta** of a new version of the OLAT Explorer. It shows the same
journey-time data as the [live map](/campaigns/improving-travel-times/), but
instead of loading a pre-made picture for every combination of options, it sends
your browser a small data file per town centre (about 40 kB) and draws the map
live. That makes it far lighter, exact rather than a compressed image, and it
unlocks things a fixed picture cannot: switch to a **difference map** to see how
many minutes a car or e-bike saves, drag the **isochrone** slider to watch a
catchment grow or shrink, and **hover the map** to read the journey time to any
point in London.

Everything else — the borough map, the town-centre picker, the e-bike and car
toggles — works exactly as before.

{{< olat-explorer-v3 default="croydon" scenarios="on" >}}

*Beta notes: the star marking the selected centre is now drawn live on top of the
map rather than baked into the image. The "car premium" and "e-bike premium"
views compare against public transport only, so the mode toggles are disabled
while a difference map is shown.*
