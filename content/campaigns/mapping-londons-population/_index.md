---
title: "Mapping London's Population"
weight: 8
category: "London & Data"
themes: ["Mapping London"]
image: "/images/campaigns/population-card.jpg"
stat: "26,369"
stat_label: "output areas, averaging 330 people each"
summary: "Who lives in London? An interactive 3D map of the 2021 census, from whole boroughs down to output areas of a few hundred people each: explore age, housing, work, health, origins, and language."
---

> Explore London's 2021 census. View 54 measures covering 8 categories: population, age, households, origins, migration & language, health & care, work & study, and housing. Zoom in, rotate, choose the map scale. On a computer? Try the **full screen** button.

## London is not one place

Neighbouring places can be starkly different while whole swathes of the city can be similar. **The 2021 census** is both a snapshot in time and a treasure trove of data, from which I have turned the raw numbers of 54 census measures into an explorable map.

The census publishes results down to 26,369 **output areas**, small blocks of about 330 people or 130 households. Zoomed out, the map switches to the catchily named **Lower Super Output Areas** which group the OAs into 4,994 larger areas.

## Or your own patch

Nobody lives in an "output area", so the map will also build the census areas into some more familiar geography: the 33 **boroughs**, the 75 **parliamentary constituencies**, the 14 **London Assembly seats**, and 689 council **wards**. And you can add a street map overlay to get your bearings. Though see note below on wards and constituencies.

{{< london-population >}}

## How to read it

**Height and colour both show the same thing** Taller and paler means more, the scale bottom right shows the actual range for each measure.

**Zoom in and the map adjusts** between OAs and LSOA if you pick Census Areas, but any other area type stays put.

**Almost everything is a percentage not a count.** Of households, of people, or of a subset of people. The one exception is density which is people per hectare, and because population is roughly equal across OAs and LSOAs that becomes a fairly direct read-out of built form.

**The top and bottom announce themselves.** Pick a measure and the peak areas ping in a quick wave that finishes on the very highest one, or you can switch to "lowest". Hovering any area gives you its rank as well as its figure.

**One measure diverges from a meaningful zero.** The age-adjusted health measure in Health & care is centred on 100, which is the London average for a place with that age profile. It rises in *both* directions so height is how far an area sits from what its age profile predicts, colour is which way: amber for worse and blue for better.

**You can change the base map.** The default draws borough outlines on ink. Switch to Street for an OpenStreetMap base, and hide the data layer if you want to see the map more clearly.

## Notes and Observations

**The census is a snapshot from March 2021**, taken during a lockdown. Student and worker populations were displaced, and that shows in some central and university areas.

**Small numbers are deliberately fuzzed.** ONS applies statistical disclosure control, nudging small counts up or down by one or two so individuals cannot be identified, this mainly affects OAs.

**It counts where people sleep, not where they are.** The City of London has about 8,600 residents and roughly 600,000 weekday workers. Residential measures there describe almost nobody who is actually in the Square Mile on an average Tuesday. The same is true in a milder way across the city centre.

**Wards and constituencies are approximate at the edges.** Output areas were drawn in 2021 to fit the wards of the day, and many London wards were redrawn in 2022. ONS assigns each output area to whichever ward or constituency holds most of it, and this map follows that assignment. So a ward here is "the output areas ONS puts in that ward", not the legal boundary traced exactly. In practice a typical ward's population is within ~2%, and 90% are within 5%, but the shape can wander at the edges.

## Sources

Census 2021 topic summary tables, Office for National Statistics, via Nomis, under the Open Government Licence v3.0. Boundaries are ONS 2021 output areas, generalised and clipped to the coastline; areas are ONS Standard Area Measurements, using land area only so that riverside neighbourhoods are not diluted by the Thames. Contains OS data © Crown copyright and database right 2024.
