---
title: "How Is Your Bus Route Doing?"
weight: 4
category: "Transport"
themes: ["Buses", "Transport"]
image: "/images/bus/bus-double-decker-screenprint-3x.png"
stat: "1 in 5"
stat_label: "trips on a typical London bus route mean waiting more than ten minutes"
summary: "Why TfL's bus performance stats don't tell the whole story, how often buses are cut short before their expected destination, and how to find out what was going on when your bus journey went kaput."
build:
  list: "never"
  render: "always"
sitemap:
  disable: true
noindex: true
---

> Performance stats for every route, and my Bus Replay Viewer to watch what really happened on a particular day.

Why TfL's bus performance stats don't tell the whole story, how often buses are cut short before their expected destination, and how to find out what was going on when your bus journey went kaput. 

{{< bus-hero >}}

## Passengers and bus companies don't look at buses the same way

If a bus route is meant to run every 12 minutes, how often should you wait more than 20? As I leaned against the bus stop's sloping half-seat, gazing upon Purley's scenic multi-storey car park, I pondered this question for the third time that week. I realised that TfL's bus performance figures don't tell the real story.

If most of a route is fine but one part is falling apart, the official figures tend to average things out and suggest it's mostly fine. But for the people in the bit that's going wrong, it's awful: every time you try to get to work, an appointment, or to school you're stressing about being late, or leaving earlier and earlier to compensate.

These frustrations are a big part of my case work postbag: people want to know what's going on. 

Often it's the dreaded curtailment where a bus is cut short. That's when you're on a bus and suddenly the driver announces they've been instructed to terminate early - everybody off! If you're on the bus it's annoying, if you're somewhere up ahead waiting for that bus, it's not only annoying but you don't even know why. You just stand there waiting for ages, wondering where all the buses have gone and why the arrival times app seems to be lying to you.

## So what is going on?

That's the question people ask me, and I always had to rely on going to TfL to ask them. One benefit of finding myself at a loose end waiting 20 minutes for a bus is it gives time to think up a better way to answer that question. Looking for answers, I started delving into TfL's published data and eventually that turned into this project.

Instead of averages smoothed out over a whole route, I've tried to pick out where people are having problems. How often are people waiting more than 20 mins? What's the longest wait? How often are buses being cut short, and where? And is it just your imagination, or are these things getting worse?

And if you really want to know what was going on, I've built a **Bus Replay Viewer**. Pick a route, pick a day, watch a bird's eye view of the whole route - where every bus was at every moment of the day. If you were waiting half an hour with no buses and no clue what was happening, now you can see exactly where they were hiding.

## How do I know this?

I built my own server which lurks quietly in a data centre in London, pinging the location of every one of London's roughly 9000 buses every 10 seconds, all day every day. That's about 9Gb of data every day. I also made use of the Bus Open Data Archive generously built by [Open Innovations](https://open-innovations.org/projects/), so all the data I have from before September 2026 is thanks to them.

From this chaotic sea of numbers I create both the performance stats for individual bus routes, and the data files for the replay viewer. Alas, I only have space on my website for 35 days of replay viewer data, older files are automatically deleted, but if you want you can download the file for a particular day and keep it yourself, then you'll be able to rewatch that day for ever.

You can start here with the weekly league table, or search for a specific route. Every route has its own page so you can bookmark it to get straight back there, all the pages are: **neilgarratt.com/buses/[route]** so you can type the route number at the end. neilgarratt.com/buses/73 for example

{{< bus-league >}}

## What the numbers mean

**Long waits** How often does someone on this route have to wait longer than 10 minutes, longer than 20 minutes, or longer than half an hour? And, smaller text underneath, how often should it happen, according to the timetable? What was the longest wait, and where?

**Excess Wait Time** is the headline measure TfL use for high frequency routes - 5 or more buses per hour. If there's meant to be a bus every 10 minutes, someone turning up at random would expect to wait 5 minutes on average. But buses don't always run to plan. Excess Wait Time is the difference between how long the timetable says people should expect to wait, and how long they actually did have to wait. Averaged over the whole route. I recreate this metric from my own data and I get a slightly different answer from TfL. I give both figures on my individual bus pages, the biggest gap tends to be when a route has a lot of curtailments because (in my view) TfL's calculation understates the impact of this. Perhaps they'd curtail fewer buses if they used my EWT equation instead?

## Sources

Bus location data from the [Department for Transport's Bus Open Data
Service](https://www.bus-data.dft.gov.uk/), originating with Transport for
London. Historic positions from the National Data Library volunteer archive.
Analysis and presentation are my own.

Contains public sector information licensed under the Open Government Licence
v3.0. This site is not affiliated with, endorsed by, or connected to Transport
for London, the Department for Transport, or any bus operator. It is not an
official source of bus information, and it should not be used to plan a journey.
