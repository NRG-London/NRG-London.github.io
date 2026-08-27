---
title: "How This Is Measured"
category: "Transport"
layout: "article"
summary: "The method behind the bus performance pages: what is measured, how, and what it cannot tell you."
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

> Unlisted while I build this out, and **currently a placeholder**: the pages it
> describes are running on sample data. The full method is written up separately
> and will be published here in the reader's language rather than the analyst's.

## What is being measured

Every London bus reports its position roughly every thirty seconds, and that
feed is open data. Watching the point where a route starts gives its actual
departure times. The gaps between those departures are the headways passengers
actually meet.

**Excess wait time** compares those real gaps with the scheduled ones. Both are
weighted by their own length, because a passenger arriving at random is more
likely to land in a long gap than a short one — a route with gaps of 2 and 18
minutes is not a route with a 10-minute service. Excess wait is the difference:
the time a rider loses to irregularity, over and above what the timetable
already asks of them.

**Wait more than 10 minutes** is the share of all that waiting time which falls
inside a gap longer than ten minutes. It is the same fact, in the units a
passenger standing at a stop would use.

Figures are weekdays, 07:00 to 22:00, unless labelled otherwise.

## What it cannot tell you

**A month is missing.** The archive this project draws its history from was down
between 28 July and 26 August 2026. That data does not exist and cannot be
recovered. It shows as "no data" and is never treated as a zero.

**Position data is not a timetable.** "Scheduled" here means the departures the
feed itself declares, not the published timetable. That is good enough for
headways, which is what these pages measure, and not good enough for
stop-by-stop punctuality, which they do not claim to.

**Buses report every one to three minutes, not every thirty seconds.** TfL's
export refreshes more slowly than the buses' own equipment. Single events at a
single point therefore carry about a minute of timing noise — fine for a
distribution over a week, not fine for adjudicating one journey.

**Some journeys cannot be classified at all.** Where the position feed blacked
out across the moment that would have settled the question, the journey is
reported as indeterminate rather than guessed at. That is typically two or three
per cent.

## Sources

Bus location data from the [Bus Open Data
Service](https://www.bus-data.dft.gov.uk/), originating with Transport for
London; historic positions from the National Data Library volunteer archive.
Contains public sector information licensed under the Open Government Licence
v3.0. Analysis and presentation are my own.
