---
title: "{{ replace .File.ContentBaseName `-` ` ` | title }}"
date: {{ .Date }}
format: "appearance"   # report | oped | appearance | newsletter | petition
type_label: "Video"    # display badge, e.g. Video | TV | Radio | Clip
outlet: ""             # where it lives, e.g. "X / Twitter", "YouTube"
campaigns: []          # campaign keys this belongs to, e.g. ["tunnel-toll-tax"]
external_url: ""        # REQUIRED for a stub: the off-site link
thumbnail: ""          # optional preview image under /static/images/
summary: ""
build:
  render: never        # no local page — list views link straight to external_url
  list: always         # still appears in Recent Activity and tagged hubs
---
