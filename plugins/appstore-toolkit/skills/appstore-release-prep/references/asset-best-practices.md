# App Store assets: Apple's rules and specs

Condensed from Apple's [App Store asset best practices and resources](https://developer.apple.com/app-store/asset-best-practices/)
and [Creative assets specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications/),
both read on 2026-11-06 (iOS 27 era). Apple revises these pages: re-read them before
relying on a number here for a new asset type. Lines marked **(measured)** come from
Apple's templates, not from the page text.

## Rules for every asset

Apple reviews assets against App Review Guideline 2.3 (Accurate Metadata) and the Apple
Advertising Policies, and judges them for featuring with the same eye.

- **Stay on the core experience.** Content outside the app is allowed only when it relates
  to what the app does.
- **No** specific prices or discounts, website URLs, copyright symbols, unverifiable
  claims (awards the app has not received), logos of or references to other platforms or
  marketplaces, or Apple recognitions (Editor's Choice, App of the Day, Apple Design
  Award). The App Store already shows those it has given.
- **4+ in every asset**, whatever the app's own age rating. Games may show action, but
  no gore and no weapon pointed at a person or at the viewer.
- **Global audience.** Imagery inclusive of all backgrounds. Images and videos are
  localizable per locale; localize any text in them for every language the app supports.
- **Cohesion.** Header, search asset, screenshots and previews should read as one set:
  the same palette, iconography, fonts, message and tone.

## Images

- **Current visuals.** The latest UI, the app's own aesthetic, strong composition, and
  **one clear focal point** per asset.
- **Text is optional and short.** A short phrase that _enhances_ the visual rather than
  describes it. Overlays may show an input method or point at a feature.
- **Legibility everywhere.** Key elements, text above all, go inside the template's safe
  area, and the focal point goes at the **centre** of the composition so device and
  orientation crops never clip it. App Store Connect's product page preview tool shows
  the result before release.
- **No alpha channel or transparency** in any creative asset image.

## Videos

- **Poster frame**: the first image people see. It must stand on its own.
- **Start strong**: lead with the value proposition or the best feature. No quick cuts
  or fast motion; they are hard to follow and not accessible to everyone.
- **Loop seamlessly**: videos autoplay and repeat, with no visible jump at the seam.
- **Silent first**: muted by default (search results cannot be unmuted; the product page
  can). Sound is brand texture, not information: a short clean music loop, no sudden
  loud moments.

## Product page header (iOS 27, iPadOS 27)

The first thing a visitor to the product page sees. It **expresses the brand**, a season,
or new content, and sets the tone for the page.

- **One single, clear idea.** Dense or cluttered art dilutes it.
- **Design for a first-time visitor**: what is most compelling to someone who has never
  heard of the app.
- Product page optimization can A/B test alternative headers.

## Search result asset (iOS 27, iPadOS 27)

Shown in Search before anyone reaches the product page.

- **State the obvious**: the app's purpose must be clear at a glance, since people search
  for something specific.
- **Show the firsthand experience**: the interface, content or gameplay, so people can
  decide from it.
- Without one, Search shows the app's in-app events, previews and screenshots instead.

## Creative asset specs

| Placement                      | Aspect | Size (px)                                    | Formats                                                 |
| ------------------------------ | ------ | -------------------------------------------- | ------------------------------------------------------- |
| Product page header, image     | 21:9   | 3840x1646                                    | .jpeg, .jpg, .png                                       |
| Search result, image           | 3:2    | 1920x1280 to 3840x2560                       | .jpeg, .jpg, .png                                       |
| Universal (serves both), image | 16:9   | 5244x2950                                    | .png only                                               |
| Header, video                  | 21:9   | 3840x1646, 30 or 60 fps, 5-30 s              | .mov, .m4v, .mp4                                        |
| Search result, video           | 3:2    | 1920x1280 to 3840x2560, 30 or 60 fps, 5-30 s | .mov, .m4v, .mp4                                        |
| In-app event card              | 16:9   | 1920x1080 to 3840x2160; video 15-30 s        | image .jpeg/.jpg/.png, video .mov/.m4v/.mp4, 500 MB max |
| In-app event details page      | 9:16   | 1080x1920 to 2160x3840; video 15-30 s        | same                                                    |

A universal asset is one file placed as both header and search result. It unifies the
brand, but its safe area is the smallest share of the canvas (below), so a focal subject
comes out smaller in both places than with two dedicated files.

### Art safe area (measured)

Templates (Figma, Photoshop, Pixelmator, Sketch) are linked from the best-practices page.
Each holds one green **Art Safe Area** layer, read from the Photoshop files:

| Template      | Canvas    | Safe area x, y, w, h | Share of width |
| ------------- | --------- | -------------------- | -------------- |
| Header        | 3840x1646 | 1097, 493, 1646, 661 | 43%            |
| Search result | 3840x2560 | 836, 765, 2168, 1030 | 56%            |
| Universal     | 5244x2950 | 1921, 660, 1402, 962 | 27%            |

**The safe area is where the focal point must sit, not the frame the art must fit in.**
Apple's own sample art is a group of people far larger than the box: in the header
template the figures span x 732-3108 (62% of the width) and run from the top of the safe
area to y 3601, more than 1,900 px below the bottom of the canvas. Only their heads are in
the box; the bodies are cropped by the canvas edge. Shrinking a subject (a device, a
screenshot) until all of it fits inside the safe area leaves it small on every device,
which is the common mistake. Make the subject large, put its focal detail in the box, and
let the rest bleed past it and off the canvas.

## Screenshots

- Up to **10** per device family on the product page. Depending on orientation, up to
  **3** appear in search results, so the first three carry the decision.
- **Show the app in use**: a clear, detailed view of the real experience. Do not spend a
  whole screenshot on accolades or a call to action.
- **Lead with the best features**, in an order that tells a cohesive story, following how
  someone actually uses the app.

## App previews

- Up to **3** per device family. Up to 3 may appear in search results.
- **Real UI or gameplay**, with compelling visuals in the first seconds.
- **Tell a complete story**: a beginning, middle and end, e.g. the most important
  features in order of popularity.

## Submitting

Assets are submitted with an app version or on their own from the Asset Library, in App
Store Connect or through the API (`upload_library_asset`, `create_placement`; see the
media section of SKILL.md). Every approved asset lands in the Asset Library, which shows
where each one can be used. Custom product pages and product page optimization tests can
use creative assets too.
