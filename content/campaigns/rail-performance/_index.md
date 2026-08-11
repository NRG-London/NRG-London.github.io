---
title: "How Is Your Train Operator Doing?"
weight: 4
category: "Data"
stat: "66.4%"
stat_label: "of station stops nationally are reached on time — down from 71% four years ago"
summary: "Rail punctuality for every Great Britain operator, four-week period by four-week period, back to 2014. Pick your operator and see whether it is getting better or worse, and how it compares to the ones most like it."
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

> Unlisted while I build this out. Pick an operator below, then a measure. The
> shaded band is the range across the operators most like it.

## Two questions the official statistics answer badly

The Office of Rail and Road publishes all of this. It is public, it is careful,
and it is close to unreadable unless you already know what a CaSL is. The
quarterly release is a PDF, the data portal is a wall of numbered tables, and
the operators' own pages select for the quarter that flattered them.

So there are two questions almost nobody can answer in ten seconds:

**Is my train service getting better or worse?** And **how does it compare to
the operator next door?**

That is all this page tries to do.

{{< ng-chart2 "rail-punctuality" >}}

## How to read it

**"On time" is stricter than it sounds.** It counts station stops where the
train arrived early or less than one minute late — not "roughly on time", not
"within five minutes". Nationally that is about two thirds of stops. The other
two measures loosen the threshold to three and fifteen minutes.

**The x-axis is in railway periods, not months.** The railway year runs from
1 April and is divided into thirteen periods of four weeks. They drift against
calendar months, which is why the axis is labelled by year rather than by month
and why "period 9" rather than "November".

**The vertical axis does not start at zero.** For a bar chart that would be
indefensible; for a line it is the only way to see the movement, because almost
all the variation sits between 55% and 80%.

**The dashed tail is provisional.** ORR publishes each period as soon as it is
validated, and Network Rail supplies final figures one period later. The last
point on the chart can still move.

**The band is mine, not ORR's.** ORR does not publish a sector average, so the
shaded range is computed here from the operators I have grouped together, and
the line through it is their average weighted by recorded station stops. Great
Western Railway and East Midlands Railway each run services across more than one
sector, so they sit less comfortably in any single group than the rest.

## Notes and observations

**Compare like with like.** A metro service stopping every two minutes and an
Anglo-Scottish express have very different opportunities to lose a minute, which
is why the default comparison is against similar operators rather than against
the national average. The older PPM measure made this worse still: its threshold
varies by operator type — five minutes for London and South East, ten for long
distance — so a national PPM league table is not a comparison at all. The
measures on this page are defined identically for every operator, which is
exactly why these and not PPM.

**Everything here is measured against the plan of the day.** Punctuality and
cancellations are judged against the timetable operator and Network Rail agreed
at 22:00 the previous evening — not the timetable you booked against three weeks
earlier. A service pulled at nine the night before has, statistically, never
existed. That gap is the thing I most want to measure next.

**The 12-month average is the honest default.** Railway performance is strongly
seasonal — autumn leaf fall and winter weather move every operator together — so
a period-by-period line is mostly season. Switching to "every period" shows how
much noise the average is hiding.

## Sources

Office of Rail and Road, [passenger rail
performance](https://dataportal.orr.gov.uk/statistics/performance/passenger-rail-performance/),
table 3138, "Train punctuality at recorded station stops by operator", and the
[railway period
dates](https://dataportal.orr.gov.uk/media/2250/railway-period-dates.ods)
calendar. Analysis and presentation are my own.

This site is not affiliated with, endorsed by, or connected to Network Rail,
National Rail, the Office of Rail and Road, or any train operator. It is not an
official source of railway information.
