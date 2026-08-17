---
title: "Tracking London Crime"
weight: 9
category: "Policing & Crime"
themes: ["Tackling Crime"]
image: "/images/campaigns/tracking-crime-card.jpg"
stat: "+31%"
stat_label: "London's recorded crime since 2013, against +54% elsewhere"
summary: "How much crime is there in London, and is it getting better or worse? The honest answer needs a like-for-like comparison with the rest of the country. This interactive chart gives you one — nineteen crime types, back to 2012, London against everywhere else."
---

> Pick a crime type, choose how you want to see it, and the chart redraws. Everything here is Home Office recorded crime, on the same basis for London and for everywhere else.

"Is crime going up?" sounds like it should have a simple answer. It doesn't — because the number by itself tells you very little. London is enormous, so of course it records more crime than Cumbria. London's population grows, so a rising count can hide a falling rate. And every force's figures move when recording practice changes, which makes a single line on its own almost impossible to read.

What actually answers the question is a comparison: London against the rest of England and Wales, the same crimes counted the same way, over enough years to see past the noise.

{{< ng-chart "london-crime-charts" >}}

## What you can do with it

**Pick a crime type.** Nineteen of them, from total recorded crime down to individual offences like homicide, rape, knife crime and shoplifting. Several of these can't be separated out in the police.uk data most crime maps use, which folds homicide and rape into one broad "violence and sexual offences" bucket.

**Switch the comparison on.** "London only" shows the capital by itself. "vs rest of E&W" puts London beside the other 41 police forces, so you can see whether a London trend is a London story or a national one.

**Change what the bars mean.** Counts are raw offences. Indexed sets the first year to 100, so two very differently-sized places can be compared on the same axis — this is the one to use for the national comparison, because London's counts and the rest of the country's counts are miles apart in size. Per 1,000 divides by population, which is how you tell a rise in crime from a rise in the number of people.

**Switch the year basis.** Calendar years, or the April-to-March financial years the police and government actually plan and report against. The two rarely tell quite the same story at the edges.

## The headline

Between 2013 and 2025, recorded crime in London rose about 31%. Across the rest of England and Wales it rose about 54%.

That is not a claim that London is safe, and it is not a claim that crime has fallen. Both went up. But the story told in much of the coverage — that London is uniquely and increasingly lawless — does not survive contact with a like-for-like comparison. On this measure the capital has done better than the country it sits in.

Individual crimes vary enormously around that average, which is exactly why the chart lets you change the crime type rather than picking one for you.

## What "recorded crime" means, and doesn't

These are offences **recorded by the police**. That is not the same as offences committed. Two things move the number that have nothing to do with how much crime is happening:

- **Reporting.** Crimes nobody reports are not recorded. When confidence in the police rises or falls, or a crime becomes easier to report online, the recorded figure moves on its own.
- **Recording practice.** After a critical 2014 inspection, forces across the country were pushed to record reported crime far more consistently. A good deal of the national rise in the years that followed is better bookkeeping rather than more offending.

Both of those affect London and the rest of the country in broadly the same way and at broadly the same time — which is precisely why the comparison is more trustworthy than either number alone. A national change in recording rules moves both sets of bars.

## Where the numbers come from

Home Office police recorded crime, published quarterly, covering all 43 territorial forces in England and Wales.

I've used this rather than the police.uk street-level data that most crime maps are built on, for two reasons. Greater Manchester — England's second-largest force — has published almost nothing to police.uk since 2019, so any "rest of England and Wales" figure built from it quietly leaves out a city of 2.9 million. And police.uk has been running several per cent short for London specifically in recent years while matching the rest of the country almost exactly, which is the worst possible shape of error for a comparison like this one: it lands on one side and not the other.

The Home Office figures have neither problem. The trade-off is that they arrive quarterly rather than monthly, so the chart is a little further behind — currently running to March 2026. The Home Office also revises its whole back-series at each release, so earlier bars can shift slightly as well as recent ones.

Anti-social behaviour isn't here, and can't be: it isn't a notifiable offence, so it doesn't appear in recorded crime at all.
