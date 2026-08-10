---
title: "Mapping London's Population"
weight: 8
category: "London & Data"
image: "/images/campaigns/population-card.jpg"
summary: "Who actually lives in London? An interactive 3D map of the 2021 census, from whole boroughs down to output areas of a few hundred people each — 54 measures covering age, housing, work, health, origins and language."
stat: "26,369"
stat_label: "output areas, averaging 330 people each"
---

> Explore the map below: pick a theme, then a measure, and zoom in. On a computer? Try the full screen button.

## London is not one place

Almost every statistic you read about London is a single number for 8.8 million people. It is usually true and almost always useless. Take two examples from the map below. The median age of a London neighbourhood ranges from 20 to 60, and if you go down to individual output areas, from 14 to 83. Just under a quarter of London's households rent from a social landlord — 23% — but there are neighbourhoods where it is nobody and neighbourhoods where it is more than nine in ten.

The 2021 census is the only source that goes far enough down to show that. It publishes results for **output areas** — small blocks deliberately drawn to hold roughly the same number of people. There are 26,369 of them in London, averaging about 330 residents and 130 households each. At that grain you are no longer looking at boroughs; you are looking at estates, terraces and individual tower blocks.

This map puts 54 census measures onto that geography in 3D. It opens on population density and covers age, household make-up, ethnicity and birthplace, migration and language, health and unpaid care, work and qualifications, and housing tenure and type.

{{< london-population >}}

## How to read it

**Height and colour both show the same thing** — taller and paler means more. Height is always in direct proportion to the value; colour is compressed slightly so the middle of the range stays distinguishable.

**Zoom in and the map refines itself.** It opens on London's 4,994 neighbourhoods (LSOAs, roughly 1,700 people each). Zoom past a borough's worth of screen and it swaps to the full 26,369 output areas. Every neighbourhood figure is exactly the sum of the output areas inside it, so nothing shifts as you cross over.

**Almost everything is a share, not a count.** Because output areas are drawn to hold about the same number of people, a map of raw counts would be a map of how the boundaries were drawn rather than of London. The one deliberate exception is density, which is people per hectare — and because population is held roughly constant, that becomes an unusually direct read-out of built form.

**One measure diverges from a meaningful zero.** The age-adjusted health measure in Health & care is centred on 100 — the London average for a place with that age profile — and rises in *both* directions. Height is how far an area sits from what its age structure predicts; colour is which way, amber for worse and blue for better.

**You can change the base map.** The default draws borough outlines on ink. Switch to Street for an OpenStreetMap base, and hide the areas entirely if you want to see what is underneath them.

## What the census can and cannot tell you

It is worth being straight about the limits, because they matter at this grain.

**It is a snapshot from March 2021**, taken during a lockdown. Student and worker populations were displaced, and that shows in some central and university areas.

**Small numbers are deliberately fuzzed.** ONS applies statistical disclosure control, nudging small counts up or down by one or two so individuals cannot be identified. At output-area scale that is a real fraction of a small category, so a figure of "0.0%" means "almost nobody", not "nobody". Areas with too few people for a measure to mean anything are greyed out rather than shown.

**It counts where people sleep, not where they are.** The City of London has about 8,600 residents and roughly 600,000 weekday workers. Residential measures there describe almost nobody who is actually in the Square Mile on a Tuesday. The same is true in a milder way across the centre.

**Age drives more than you would think.** Self-reported bad health looks dramatically worse in retirement suburbs than in student areas, for reasons that have nothing to do with those places. That is why the health section carries both the raw figure and an age-adjusted one that asks a better question: is this area's health better or worse than its age profile alone would predict? The answer looks very different — and much more like a map of deprivation than a map of age.

## Sources

Census 2021 topic summary tables, Office for National Statistics, via Nomis, under the Open Government Licence v3.0. Boundaries are ONS 2021 output areas, generalised and clipped to the coastline; areas are ONS Standard Area Measurements, using land area only so that riverside neighbourhoods are not diluted by the Thames. Contains OS data © Crown copyright and database right 2024.
