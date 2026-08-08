---
title: "Secret Northern Page"
summary: "An unlisted northern edition of the 3D crime hotspots map — Yorkshire and The Humber"
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

This page is not linked from anywhere. You have either been sent it or you are
being nosy, either way - hello!

[Tom Forth](https://twitter.com/thomasforth) was kind about my
[3D crime hotspots map of London](/campaigns/crime-concentration/), which was
generous. As he spends a good deal of his time pointing out that
the North gets left out of things, usually with the data to prove it, here's a 
little easter egg: a Yorkshire and The Humber crime map for anyone who happens to be 
in, taking a place entirely at random, Leeds.

Like the London version, it has eight crime types, 2021 to 2025, every
police.uk street-level location aggregated into hexes that refine from 500 m
down to 70 m as you zoom in. Drag to rotate and tilt. The buttons top right jump
straight to Leeds, Bradford, Sheffield, York, or Hull.

{{< yorkshire-hotspots >}}

## Number Crunching

Of the eight crime types here, Yorkshire and The Humber's four forces recorded **1,199,825** offences
over the five years. London's two recorded **2,188,043**.
This region covers **15,408 km²** against Greater London's **1,572**, which
works out at **78 offences per square kilometre here and 1,392 in London**.


## Notes and Observations

- **Rural locations are blunter than urban ones.** police.uk publishes an
  approximate "snap point" rather than a real address, and outside the cities
  those points collapse onto village centres. North Yorkshire's 21,924
  shoplifting offences sit on just 1,465 distinct points. So a Dales market town
  can look like one tall needle when it is really a whole high street.
- **"On or near Shopping Area" is a real police.uk location**, which puts an
  entire retail centre on a single coordinate.
- **Tower heights compare within a crime type, never between them.** Each crime type
  is scaled to fill its own range, so burglary's tallest tower and shoplifting's
  tallest tower do not mean the same number.
- **British Transport Police is not in here**, which under-reports the region's stations by 12,515 offences.

Boundaries are ONS/Ordnance Survey under the Open Government Licence. The rivers,
reservoirs and place names come from OpenStreetMap. The crime data is police.uk.
The analysis, and any mistakes in it, are mine.
