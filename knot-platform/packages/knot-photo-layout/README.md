# @knot/photo-layout

How a set of images is laid out: first cut them into several equal-height rows by real aspect ratio, then assign a height to each row.

The card (`web/src/components/PhotoGallery.vue`) and the share poster (`backend/src/sharePoster.js`) share
`planPhotoRows`, so a set of ordinary pictures is cut the same way in both places. Only the budget differs, and both
budgets are defined here — `LAYOUT_RULES` for the card and `POSTER_LAYOUT_RULES` for the poster — so no consumer keeps
its own copy. The card caps a row at 200% of content width (a phone screenshot around 1:2 fits whole) and never leaves a
cell narrower than a finger can hit; the poster allows 300% per row, caps the whole collage, and is not tapped. When
extremely shaped pictures are mixed, those two priorities can pick different cuts; either way the poster's 300% is the
only source for how tall a single image may be drawn on it.

The box shape is clamped to 1:4–8:1 for layout purposes, but cropping is always measured against the picture's real
ratio, so a 1:8 screenshot is not treated as a 1:4 one and a 10:1 panorama is not recorded as "not cropped".
Extreme and ordinary pictures are also never squeezed into one row to the point where a cell drops under 44px:
that split takes precedence over the cost function.

- `photoAspect(photo)`: the real aspect ratio of one image; 4:3 when dimensions are missing. Not clamped.
- `planPhotoRows(aspects, rules)`: exhaustive cut (`2^(n-1)` ways); returns each row's height, cell shares, and crop direction.
- `planPhotoLayout(photos)`: used by the card; the row-cut result goes straight to CSS variables.
- `planPhotoBoxes(photos, { width, gap, rules })`: used by the share poster; multiply row heights into pixel boxes and hand them to sharp for cropping and compositing. `gap` defaults to `PHOTO_GAP`.
- `PHOTO_GAP`: the gap between pictures, shared by the card's CSS and the poster's pixel boxes so both use one number.
- `LAYOUT_RULES`: target row height, row height bounds, total height cap, the narrowest cell (soft target and the hard 44px floor), crop penalty. To tune layout taste, change only this.
- `POSTER_LAYOUT_RULES`: the same rules with the poster's budget — a row up to 300% of content width, the whole collage up to 400%, and `maxCard` as a hard cap (`strictCard`) so the collage can't push the image past its height limit. The share poster derives its own `maxCard` from its pixel height budget and overrides this default. The tap floor is off there (`minTapShare: 0`): a poster isn't tapped, and splitting every extreme picture into its own row would make an extreme collage many times taller than the page it has to fit. Ordinary picture sets lay out identically in both places.
- `LAYOUT_VERSION`: bumped next to the rules whenever they change. The share poster's cache key includes it, so already-rendered images are redrawn under the new arrangement instead of being served stale.

The design notes are at the top of `src/index.js`: why not to measure the DOM, why "too-tall images" need no special case, and what each term of the cost function penalizes.
