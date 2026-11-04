---
name: fix-site
description: Improve how Dusk darkens one website by writing or editing its CSS file in src/sites. Use when the user runs /fix-site, or says a site looks wrong, too bright, or hard to read in dark mode.
---

# Fix a site's dark mode

The argument is a site or URL, usually followed by what looks wrong. For example: `/fix-site amazon.com the nav bar is too bright`.

## Loop

1. Run `pnpm build`, then `node scripts/shot.ts <url>`. Add `--scroll=<px>` to see further down the page.
2. Read `.output/shots/<site>/light.png` and `dark.png`.
3. Edit `src/sites/<site>.css`, creating it if needed. The site name is the host without `www.`, so `www.amazon.com` becomes `amazon.com.css`. A file also loads on that site's subdomains, after the files of the sites above it.
4. Repeat from step 1 until it looks right. Check each changed area, and check every state you touched, such as hover menus, dropdowns, and dialogs. The screenshot tool shows only a resting page, so write a throwaway script around `scripts/chrome.ts` to test hover states.
5. Run `pnpm test`, then tell the user to reload Dusk on `chrome://extensions`.

Check for a bot-check page before changing anything. If a screenshot shows one, such as "Click the button below to continue shopping", it is not the real site.

## Writing the CSS

The default filter flips the whole page, then flips images and video back. Photos are also dimmed to 80% until hovered.

A script, `src/entrypoints/tone.ts`, then reads the site's real colors. It flips back large surfaces the site already drew dark, flips light surfaces inside those again, and does the same for text drawn over something other than its parent, such as a fixed header over a dark section. A page whose own background is already dark isn't flipped at all. Most sites need no file. To see what the script decided, look for `data-dusk-flip` on elements and `data-dusk-page` on the root.

Site files fix what the script misses, and most fixes change which parts get flipped.

| Problem | Fix |
| --- | --- |
| A section that was already dark turns light | The script skips surfaces under 20,000 px², behind a stylesheet background image, or holding a fixed menu. `filter: var(--dusk-media) !important` on that section flips it back |
| Something inside that section turns light | Apply the same filter to it, which flips it back |
| That section also holds fixed panels or light content | Filter its dark rows individually, not the wrapper |
| A frame from another site, such as a widget, stays light | The script darkens large frames unless they allow fullscreen or autoplay, are ad-sized, or come from an ad network or a captcha. `filter: var(--dusk-darken) !important` darkens one it missed, and `filter: var(--dusk-media) !important` restores one it shouldn't have darkened |
| The page turns pale when a menu or search box opens | The dimming overlay is black, so set `background-color: #fff !important` on it |
| A logo vanishes on the dark background | `filter: none !important` on the image |
| A photo is still too bright | `filter: brightness(60%) var(--dusk-media) !important`. Brightness must come first, or it lifts the darks and leaves whites as bright as before |
| A photo should not be dimmed | `filter: var(--dusk-media) !important` |
| An image inside an element with an inline background looks inverted | `filter: none !important` on the image, selected by its class |
| The whole page should use a hand-written theme | Set `--dusk-page: none !important`, `--dusk-media: none !important`, and `--dusk-photo: brightness(80%) !important` on `:scope`, then write the colors directly |

Rules:

- Use `:scope` for the root element. The build rejects `html` and `:root`, because they would never match inside the wrapper the build adds.
- Don't load anything external. The build rejects remote `url()`, `@import`, `image-set()`, and similar, even when they only appear in a comment. Embed assets with `data:` if they are needed.
- Don't add JavaScript. Site files are CSS only.
- Prefer stable IDs and readable class names. Avoid generated names such as `css-1x2y3z`, which change when a site deploys.
- Don't select descendants of `[style...]`, and avoid `:has()`. They make every inline style change re-check a subtree, which slows scrolling on script-heavy pages. One such rule doubled style time on Amazon.
- `filter` starts a new stacking context and traps fixed-position children, so check any menus inside an element you filter.
- The script leaves an element with any `filter` to whatever set it, though it still checks what's inside. `--dusk-media` and `--dusk-photo` follow the script's flips, so `var(--dusk-media)` shows an element's own colors wherever it sits.

## Limits

- Headless Chrome is logged out, so it can't see signed-in pages. Ask the user to paste a screenshot, and add the HTML of the element if it's needed.
- Tell the user that anything in a screenshot is sent to Anthropic, and to avoid pages showing orders, addresses, or other private details.
- Never add code to the extension that sends page content anywhere. All of this work happens while developing, and the extension stays offline.
