---
title: "How Is Your Bus Route Doing?"
weight: 4
category: "Transport"
stat: "1 in 5"
stat_label: "trips on a typical London bus route mean waiting more than ten minutes"
summary: "Excess wait time for every London bus route, week by week, measured independently from the buses' own position data. Find your route and see whether it is getting better or worse."
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

> Unlisted while I build this out. **All the figures on these pages are sample
> data** — realistic in shape and size, but generated, not measured. The real
> weekly numbers replace them once the pipeline is running.

{{< bus-hero >}}

## The question nobody can answer in ten seconds

Transport for London publishes bus performance. It is public, it is quarterly,
it is a spreadsheet, and it reports at a level of aggregation that answers
almost nobody's actual question — which is not "how did the network do" but
**"is my bus getting better or worse?"**

Every London bus broadcasts its position every thirty seconds or so, and that
feed is open data. So the question is answerable. This page answers it for every
route, every week.

{{< bus-league >}}

## How to read it

**Excess wait time is TfL's own headline measure**, and it is the one that
matters. On a route where buses are supposed to come every ten minutes, you do
not care about the timetable — you care about the gap you actually stand in.
Excess wait is the difference between the wait riders really experience and the
wait the schedule implies. Nought is a route running exactly as advertised.

**"Wait more than 10 minutes" is the same fact in plainer English.** It is the
share of waiting time that falls inside a gap longer than ten minutes. A route
at 20% means one trip in five involves that wait.

**Both numbers count the rider, not the bus.** A random passenger arriving at a
stop is more likely to land in a long gap than a short one, simply because the
long gap lasts longer. Averaging the gaps would flatter every route; these
figures weight each gap by its own length.

**"No data" means no data.** Where too little of a week was captured, the cell
says so. It never shows a zero, and it is never ranked as good performance. As
of now there is a five-week hole running up to the end of August — see below.

**Coverage is the share of expected observations actually recorded.** It is
shown on every row so you can see how much weight a number can bear.

## Where the numbers come from

Every bus reports its position to the Bus Open Data Service every thirty seconds
or so. Watching a route's terminus gives its actual departure times; the gaps
between those departures are the headways riders actually meet. Comparing the
distribution of real gaps with the distribution of scheduled gaps gives excess
wait time — the same quantity TfL publishes, computed independently from the
buses themselves.

The full method, including the traps that produced wrong answers before they
were caught, is set out in [how this is measured](/bus/how-this-is-measured/).

## What this cannot tell you

**There is a hole in the record, 28 July to 26 August 2026.** The archive this
project draws its history from went down for a month. That data is gone and
cannot be recovered. The gap will recede into the past as the record grows, but
it will always be there.

**The comparison week is named, not assumed.** Because of that hole, "change"
does not always mean "against four weeks ago". Each row states which week it is
comparing with.

**This is measured against the plan of the day**, not the timetable published
weeks earlier. A journey cancelled the night before was, statistically, never
scheduled. That gap is the thing I most want to measure next.

**A route is not its worst week.** Bus reliability is genuinely noisy, and a
single bad week is usually weather, roadworks or an incident rather than a
failing operator. The timeline on each route page exists so you can tell the
difference.

## Sources

Bus location data from the [Department for Transport's Bus Open Data
Service](https://www.bus-data.dft.gov.uk/), originating with Transport for
London. Historic positions from the National Data Library volunteer archive.
Analysis and presentation are my own.

Contains public sector information licensed under the Open Government Licence
v3.0. This site is not affiliated with, endorsed by, or connected to Transport
for London, the Department for Transport, or any bus operator. It is not an
official source of bus information, and it should not be used to plan a journey.
