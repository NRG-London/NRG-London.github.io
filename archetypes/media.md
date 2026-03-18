---
title: "{{ replace .File.ContentBaseName `-` ` ` | title }}"
date: {{ .Date }}
type_label: ""    # TV | Op-Ed | Assembly | Radio | Podcast
outlet: ""
youtube_id: ""    # YouTube video ID (provides automatic thumbnail)
thumbnail: ""     # Path to thumbnail image (used when no youtube_id)
external_url: ""  # Link to original article/source
summary: ""
#
# THUMBNAIL IMAGE SOURCING (in priority order):
# 1. YouTube items: leave thumbnail blank — auto-generated from youtube_id
# 2. Articles/op-eds: pull the main image from the source article (og:image)
#    Save to /static/images/media/<slug>.jpg
# 3. If no article image: use a suitable stock image from Unsplash
#    (https://unsplash.com — free, no copyright issues)
#    Save to /static/images/media/<slug>.jpg
# 4. Set thumbnail: "/images/media/<slug>.jpg"
#
---
