---
title: "The Bakerloo line, replayed"
summary: "Every Bakerloo line train, minute by minute, against the timetable it was meant to run."
layout: "bakerloo"
# Lab: unlisted until the project goes public. All three switches go together.
build:
  list: never
  render: always
sitemap:
  disable: true
noindex: true
---

TfL publishes where its trains are meant to be, and where they are now, but not where they were. Since 2 October 2026 I have logged TfL's live Bakerloo line feed every ten seconds and rebuilt every train's journey from it, station by station. This page replays those days against the timetable.

**What you are looking at.** Blue trains are the ones that actually ran. The faint dashed trains are the timetable: by default TfL's last published working timetable (WTT 48, September 2023), or the current public timetable, which since spring 2026 runs fewer trains in the peaks. The number under each platform is the time since its last train. It turns white when the wait is longer than the timetable ever allows there, and amber when it is twice the timetabled interval.

**How it was made.** The feed never says when a train arrived; it gives predictions and a description of where each train is ("Left Waterloo", "At Oxford Circus Platform 4"). Each arrival is pinned between the last sighting before the platform and the first one after it, usually to within 15 to 30 seconds. About one position in twenty is estimated, and the "Highlight estimated positions" switch shows which. Minutes when the feed was down are marked "No data" and never counted as a missing train.

**Caveats.** North of Queen's Park the Bakerloo shares its track with the Overground's Lioness line, so passengers there have another train; the comparisons that matter most are between Elephant & Castle and Queen's Park. TfL's line status is the only public statement of cause: the feed cannot tell a missing train from a missing driver.

This is a working draft. Source: TfL live arrivals feed, logged every 10 seconds; TfL Working Timetable 48 (September 2023); TfL public timetable.
