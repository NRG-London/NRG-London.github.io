---
title: "Delay Replay: buses, live"
summary: "A live view of seven London bus routes, which is also a replay of the days before."
layout: "bus-live"
# Lab: unlisted until the pilot goes public. All three switches go together.
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

This pilot shows where the buses on seven routes are now, and lets you replay the days before on the same map. The routes are 127, 154, S4, 433, SL7, 130 and 157.

Positions are shown a short, set delay behind the real bus. A bus is only ever shown where it was reported. When it has not reported, it stays at its last known place and is never moved on by a guess.

Smooth keeps the picture steady by showing the buses a little further behind, so each one has usually reported again before you see it. Latest shows the newest report as soon as it arrives, with its age, and the bus glides to its new place.

This is a pilot, for testing.
