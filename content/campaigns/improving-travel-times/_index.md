---
title: "Improving Travel Times"
weight: 20
category: "Transport"
summary: "Mapping journey times across London, why travel in outer London looks different, and why the car is not going away any time."
---

*Why do journeys across outer London take so long, and why does it matter for jobs, opportunity, and quality of life?*

## Exploring the problem: Outer London Access Time

*There's a lot of talk about getting people to switch from their car to public transport, often framed as a moral choice. It's actually a practical choice, driven by people's rational assessment of their options.*

It's often said that only half of Londoners own a car, but this hides a fundamental fact: in inner London only about 1/3 of households have a car, but in outer London it's about 2/3. Transport planning tends to ignore this, and the reasons why a car is a rational choice for so many people in outer London. See ["A tale of two sub-regional urban zones"](https://neilgarratt.com/library/glp-car-ownership-two-londons/) for more.

Although it's true that London has one of the best public transport networks in the world, it's not true in every part of London. In fact, there is a stark divide in the level of public transport in central and inner London versus the outer boroughs, which I find is poorly understood especially by London's transport experts who, by and large, tend to live in the better-connected parts of the city. I built this map to tackle that knowledge gap.

## Interactive Journey Time Map
UPDATE: I've added e-bike and car options, which you can toggle on and off. The e-bike option assumes you travel at an average of 12mph for a max of 30 mins, and it assumes an e-bike is available at both ends of a public transport journey. The car option attempts to model congestion with a 20% speed reduction in outer London, 40% in inner London, 60% in central London - it looks reasonable in outer London but may understate peak time congestion in the city centre.
{{< olat-explorer-v2 default="croydon" >}}

I'm working on some further features. You can try them on the [beta test page](https://neilgarratt.com/olat-v3-beta/).

Using the R5R transport routing engine, I've built OLAT: the Outer London Access Time map, a colour-coded map of travel times between all parts of London. Blue and green areas show places that are easily reachable within 45 mins, these are the places that are "in range" for someone looking for work, for example. Feel free to use it to find potential places to live!

The interactive OLAT map allows you to explore how large those easy-travel zones are for well-connected boroughs, and how limited they are for others. In particular, notice that for many outer London boroughs getting to relatively nearby outer boroughs is slow and difficult. These are the orbital journeys that are often 2 to 3 times faster by car, even in busy traffic.

Within each borough, you can select from a range of named centres which is where, especially in outer London, you'll find places that are surprisingly poorly connected to the rest of London. For instance, Harold Hill in Havering, or Selsdon in Croydon. In Hillingdon, Northwood has good radial links towards London but poor links to the south of its own borough. The 202 centres shown are those listed by the GLA as part of the London Plan, plus Bank in the City of London.

Public transport journey time calculation is based on all London public transport including Tube, DLR, Tram, Overground, Elizabeth Line, London buses including Superloop, national rail services, and walking. Cycling and driving are not included. Journey times are the mean travel time between 7.30am and 8.30am on a Tuesday morning, and take into account connection and waiting times so a more frequent service is captured as a lower mean journey time across the hour.
