---
title: "{{ replace .File.ContentBaseName `-` ` ` | title }}"
date: {{ .Date }}
format: "appearance"   # report | oped | appearance | newsletter | petition
type_label: "Video"    # display badge, e.g. Video | TV | Radio | Clip
outlet: ""             # where it lives, e.g. "X / Twitter", "YouTube"
campaigns: []          # campaign keys this belongs to, e.g. ["tunnel-toll-tax"]
external_url: ""        # REQUIRED for a stub: the off-site link
thumbnail: ""          # optional local image path under /static/images/ (used as-is)
thumbnail_url: ""      # optional image override. For X/Twitter `external_url`s the
                       # poster is auto-fetched from the tweet; otherwise put any
                       # public image URL here. ./scripts/fetch-thumbnails.ps1
                       # downloads + resizes + commits to /images/thumbs/stub-<slug>.jpg
summary: ""
build:
  render: never        # no local page — list views link straight to external_url
  list: always         # still appears in Recent Activity and tagged hubs
---
