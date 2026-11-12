# Proviso design language

Proviso is a contract that pays itself. Two people agree a deal whose conditions
are tests a machine can run. PayPal holds the payer's money. An AI verifier
opens the delivered work, runs every test and records what it saw. When every
test passes, PayPal pays the worker. No one approves the payment by hand.

The interface follows from that idea. It is an instrument for one contract: it
shows where the contract is, where the money is, what the machine checked and
what it saw, and who has to act next. It is styled after a professional
market-data terminal: plain, flat, dense and quiet, with colour kept for
meaning. It is not a marketing page and not a generic dashboard. This document
says how it looks and why, precisely enough that a new screen can be built
without asking.

## 1. Principles

Each principle comes with the rule it forces on the interface. If a screen
breaks one of these rules, the screen is wrong, not the rule.

### 1.1 A contract is a set of tests

The deal is not a paragraph of prose. It is a numbered list of conditions, and
each condition is a test with a verdict.

- Conditions are numbered (`01`, `02` …) everywhere they appear: the composer,
  the contract page, the run log. Panels are not numbered; only sequences are.
- A condition is always shown together with how it will be checked
  ("Checked by code · Browser", "Judged by AI") and the exact technical
  signature (`responsive · width=375`). Nothing about a test is implicit.
- The summary of a contract's tests is a segmented meter, one segment per
  test, so "3 of 4 failed" can be read as a shape before it is read as words.

### 1.2 Money is exact and quiet

Money in Proviso is a fact about where a specific amount sits right now, so it
is set the way a terminal sets a price: plainly.

- Every amount is set in the reading face with tabular figures, full cents and
  its currency (`$250.00`). No rounding, no "k", no animated counters.
- Large amounts are `--ink`. The colour of where the money is goes on a small
  mark beside it (a square, a tag, a 3 px edge bar), never on a big figure.
- Money has exactly four places: with the payer, held by PayPal, with the
  worker, or returned to the payer. Each place has one colour (section 3) and
  that colour is used for nothing else.
- Wherever an amount is held, the interface also says what would move it next:
  "captured when all 4 tests pass", "hold released when nothing passes by the
  deadline".

### 1.3 State is a place on a line, not a badge

A contract travels a fixed track: Draft, Signed, Funded, Submitted, Verifying,
Passed, Paid. Failure, expiry and disputes leave the track at the station where
they happened.

- The contract page leads with the track. The current station is a filled
  square in its state colour; done stations are checked; the rest are hollow.
- A branch is drawn as a drop below the station it left from, labelled with
  what happened ("Failed · worker can resubmit"). Stations after a branch are
  dimmed, not hidden: you can see what did not happen.
- In lists, state is a seven-tick micro-track plus the state's name. The ticks
  give position; the word gives meaning.

### 1.4 The AI is a judge that must show its evidence

A verdict that moves money is worthless without the evidence behind it.

- Every verdict row shows, without a click: the outcome, the verifier's
  confidence, its reasoning in its own words, and the first evidence screenshot.
  Raw responses and run timings fold away; what the verifier *saw* never does.
- A failed or inconclusive verdict opens its full evidence by default.
- A detected manipulation attempt (text on the delivered page aimed at the
  verifier) is the one alarm in the product: a flat red bar inside the verdict,
  the injected text quoted verbatim in mono, where it was found, and the
  statement that it was recorded and ignored. It is also counted in the run log
  header so it cannot be scrolled past.

### 1.5 Colour means something, or it is not there

A terminal is grey until something happens. Proviso is the same.

- Surfaces are neutral greys in four steps (section 3). There are no gradients,
  glows, shadows (dialogs excepted), illustrations or tinted cards.
- One saturated blue, the accent, marks selection and action: the active tab or
  segment, the primary button, links, focus. It never carries data.
- Every other hue is a fixed meaning from the vocabulary in section 3.1, and
  every coloured mark travels with a word or a glyph.
- People and the machine are told apart by what labels them, not by typeface:
  people carry a role letter and colour (P blue, W magenta); the verifier and
  the AI drafter are named in `--machine` cyan ("Verifier", "AI drafter",
  "Judged by AI"). Every action a person can take names the person ("Sign as
  payer", "Your move · Worker"). The machine has no buttons.

## 2. Influences: what we borrowed and what we refused

The interface is styled after LSEG Workspace (formerly Refinitiv Eikon), the
market-data terminal, because a contract whose money moves on facts should look
like an instrument that professionals trust with money, not like a landing
page. We took the visual idiom only: no LSEG logo, name, typeface, layout of a
specific app, or brand colour value appears in Proviso.

### 2.1 What LSEG Workspace looks like

Observed in LSEG's own product screenshots (the Workspace for Equities product
page, the Workspace trial manual, the Workspace mobile listing) and LSEG's help
on themes; colours were sampled from those images:

- **Greys in steps.** Dark is the default theme. Window chrome is near black
  (about `#0d0d0d`); the tab strip about `#333`; the sub-tab strip about `#262626`;
  each panel has a flat mid-grey header bar (about `#404040`) over a body of
  about `#1a1a1a`. Panels meet with a few pixels of chrome between them.
- **One electric blue** (about `#334bff`) for the active tab (solid fill, white
  text), selected segment buttons ("Today", "Guidance") and the app-library
  bookmark. Identifiers (instrument codes) are a lighter blue. The blue never
  colours data.
- **Up and down** are green and red text with ▲ ▼ triangles. Backgrounds stay
  neutral except a highlighted row and tiny score badges. The mobile watchlist
  marks each row's direction with a thin coloured bar on its left edge.
- **Type** is a proportional sans everywhere, numbers included, right-aligned in
  columns. No monospace in quotes, monitors or news. Sizes are small (about
  11 to 13 px); the instrument name in the quote header is large capitals.
- **Panel headers** are uppercase sans at about 11 px, regular weight, on the
  grey bar, with a `>` to open the full app. Column heads are sentence case,
  grey, right-aligned over numbers.
- **Tabs** are flat rectangles divided by 1 px rules; corners are square.
  Rounded pills appear only for bookmarks and query tokens.
- **Rows** are about 22 to 26 px with 1 px separators and almost no striping.
- **Charts** are a thin single-colour line on the dark ground, a value flag in
  the line's colour on the axis, dotted grid lines.
- **Light theme** keeps the structure: white panels, light grey strips and
  header bars, grey hairlines, black text, the same blue for the active tab.
- No shadows, gradients, glow or illustration anywhere.

Sources: LSEG, "LSEG Workspace for equities"
(lseg.com/en/data-analytics/products/workspace/equities); LSEG Workspace Trial
Manual (2023, hosted by PolyU CPCE); LSEG Workspace on the App Store
(apps.apple.com/app/id1481442629); University of Manchester Library, "How do I
change LSEG Workspace to light theme" (manchester-uk.libanswers.com, faq
259701).

### 2.2 Borrowed

| From Workspace | In Proviso |
| --- | --- |
| Neutral greys in steps: chrome, panel, strip, header bar | `--paper`, `--surface`, `--surface-2`, `--head` (section 3.2) |
| Flat grey header bar with an uppercase title on every panel | `.panel-title` on `--head`; the only uppercase labels in the product |
| One saturated blue for selection and action | `--accent`: active nav tab underline, active segment fill, primary button, focus ring |
| Proportional sans with tabular figures, numbers right-aligned | IBM Plex Sans with `tabular-nums` for every figure (section 4) |
| Square panels and tabs, 1 px rules | Panels 0 px radius, controls and tags 2 px |
| Compact rows | Grid and header rows 28 px |
| A thin coloured bar on the edge of a row for its direction | The current place in the money flow, failed rows in the run log, alarms and notices carry a 3 px edge bar in their colour |
| Colour on small marks, not on big text | Large amounts in `--ink`; state on squares, tags and bars |
| Dark by default, light as an equal | Section 11 |

### 2.3 Refused

| In Workspace | Why Proviso does not take it |
| --- | --- |
| The LSEG name, logo, typeface and exact brand values | Idiom, not brand. Proviso's blue, greys and type are its own. |
| 11 px body text and walls of tables | Proviso is read by two people about one contract, on a projector in the demo; body is 13 px and no table is wider than it needs to be. |
| Red and green as the only signal | Every Proviso colour travels with a word or glyph (section 3.1). |
| Multi-window docking, bookmark bars, function codes | Proviso has three pages; the chrome is one bar. |
| Candlesticks and dense technical charts | One step chart of money over time and the money-flow diagram. |
| The solid blue header bar of the mobile app | Blue stays the accent; it is never a surface. |

### 2.4 What was removed from the previous design

The first design (a Bloomberg-flavoured amber-on-graphite look) was judged to
read as generated. These were removed: the three-colour stacked headline on the
home page; amber and green as large display text; a monospaced face for nearly
everything including body text; letter-spaced uppercase micro-labels on most
elements; numbered panel labels ("01 TRACK", "02 MONEY FLOW"); rounded cards
with tinted fills; the hazard-striped alarm; the `§` logo tile; the pulsing
ring on the current station; the `▸` prompt marks; slogans in product copy
("Nobody pressed pay").

## 3. Colour

Colour is semantic. Every hue answers one question, and the same answer always
has the same hue in both themes. No information is carried by colour alone:
every coloured mark is paired with a word, a glyph or a position.

### 3.1 The vocabulary

| Token | Means | Glyph / word that always accompanies it |
| --- | --- | --- |
| `accent` (blue) | Selection and action: the active tab or segment, the primary button, focus | the control's own label |
| `held` (amber) | Money held by PayPal, waiting on a condition | lock, "held" |
| `paid` (green) | A test passed; money paid to the worker | ✓, "pass", "paid" |
| `returned` (slate) | Money back with the payer: hold released, refund, expiry | ↩, "released", "refunded" |
| `fail` (red) | A test failed | ✕, "fail" |
| `alarm` (red) | A manipulation attempt detected | shield, "manipulation attempt" |
| `inconclusive` (violet) | The verifier could not decide; nothing was decided | ?, "inconclusive" |
| `disputed` (orange) | A person contested the result; also operational warnings | scale, "disputed" |
| `machine` (cyan) | The verifier or the AI drafter is speaking or working | "Verifier", "AI drafter", "Judged by AI" |
| `payer` (light blue) | The payer as a person | P mark, "Payer" |
| `worker` (magenta) | The worker as a person | W mark, "Worker" |

Green is reserved for facts that pay the worker (a pass, a payout); it is never
used for a merely positive message. The payer's light blue is an identifier
colour, like an instrument code in a terminal; it is lighter and less saturated
than the accent and is always next to the `P` mark.

### 3.2 Tokens

Each semantic hue has three tokens: `--x` for text and icons on a surface,
`--x-fill` for a solid tag or mark, `--x-on` for text on that fill. A fourth,
`--x-soft`, is the hue mixed 8 to 11 % into `--surface` in OKLab, for a row
that needs a ground (a failed, inconclusive or checking run-log row, the AI
drafter's notes, a field the AI left empty, the manipulation alarm); it always
comes with an edge bar or a word, and is never the ground of a whole card.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--paper` | `#0b0b0c` | `#e6e7e9` | Chrome: the top bar and the gutters between panels |
| `--surface` | `#161617` | `#ffffff` | Panel body |
| `--surface-2` | `#1e1e20` | `#f4f4f5` | Strips, hover rows, the current place in the money flow |
| `--head` | `#2c2c2e` | `#e9e9eb` | Panel header bars, grid headers |
| `--inset` | `#0f0f10` | `#ffffff` | Field ground |
| `--rule` | `#2a2a2c` | `#dcdde0` | 1 px separators |
| `--rule-strong` | `#454548` | `#c2c4c8` | Box edges in the money flow |
| `--field` | `#6a6a6e` | `#85888e` | Control edges, "can still move" legs |
| `--ink` / `-2` / `-3` | `#e8e8e8` / `#bdbdbd` / `#959595` | `#141415` / `#3b3d42` / `#5f6268` | Text, three steps |
| `--accent` / `-fill` | `#8197ff` / `#3d5afe` | `#1f3ce6` / `#1f3ce6` | Accent text and links / accent fills (`--accent-on` white) |
| `--held` | `#f5a524` | `#955800` | |
| `--paid` | `#3cc472` | `#086f37` | |
| `--returned` | `#9eaabb` | `#4a5a6d` | |
| `--fail` | `#f86b70` | `#c42828` | |
| `--alarm` / `-fill` | `#ff5a5f` / `#c8102e` | `#c8102e` / `#c8102e` | |
| `--inconclusive` | `#ac94ff` | `#6a3fd1` | |
| `--disputed` | `#ff8c42` | `#b04600` | |
| `--machine` | `#3fc5de` | `#00708a` | |
| `--payer` / `-fill` | `#52a8ff` / `#1f6fd1` | `#0b62c4` / `#0b62c4` | |
| `--worker` / `-fill` | `#ec6fc2` / `#a8287a` | `#a81f72` / `#a81f72` | |

For the money and verdict hues `--x-fill` equals `--x`; `--x-on` is a near
black in dark and white in light.

### 3.3 Contrast

WCAG 2.2 ratios computed from the values above. Text sits on `--surface`,
`--surface-2` and the `--head` bar; `--paper` holds the page title and footer.

| Text token | Dark: surface | strip | head | paper | Light: surface | strip | head | paper |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `--ink` | 14.76 | 13.58 | 11.37 | 16.06 | 18.41 | 16.75 | 15.18 | 14.88 |
| `--ink-2` | 9.63 | 8.86 | 7.42 | 10.47 | 10.87 | 9.89 | 8.96 | 8.78 |
| `--ink-3` | 6.04 | 5.56 | 4.65 | 6.57 | 6.12 | 5.56 | 5.04 | 4.94 |
| `--accent` | 6.72 | 6.19 | 5.18 | 7.31 | 7.38 | 6.71 | 6.08 | 5.96 |
| `--held` | 8.86 | 8.16 | 6.83 | 9.64 | 5.72 | 5.20 | 4.71 | 4.62 |
| `--paid` | 8.04 | 7.40 | 6.19 | 8.74 | 6.29 | 5.72 | 5.19 | 5.08 |
| `--returned` | 7.68 | 7.07 | 5.92 | 8.36 | 7.06 | 6.42 | 5.82 | 5.71 |
| `--fail` | 6.31 | 5.81 | 4.86 | 6.87 | 5.70 | 5.19 | 4.70 | 4.61 |
| `--alarm` | 5.92 | 5.45 | 4.57 | 6.45 | 5.88 | 5.35 | 4.85 | 4.75 |
| `--inconclusive` | 7.26 | 6.68 | 5.60 | 7.90 | 6.47 | 5.89 | 5.34 | 5.23 |
| `--disputed` | 7.82 | 7.20 | 6.03 | 8.51 | 5.64 | 5.13 | 4.65 | 4.56 |
| `--machine` | 8.83 | 8.13 | 6.80 | 9.61 | 5.70 | 5.19 | 4.70 | 4.61 |
| `--payer` | 7.24 | 6.66 | 5.58 | 7.87 | 5.90 | 5.37 | 4.87 | 4.77 |
| `--worker` | 6.56 | 6.04 | 5.06 | 7.14 | 6.77 | 6.16 | 5.58 | 5.47 |

Text on solid fills (`--x-on` on `--x-fill`): dark held 9.15, paid 8.28,
returned 8.05, fail 6.89, alarm 5.88, inconclusive 7.70, disputed 8.31, machine
8.77, payer 4.94, worker 6.46, accent 5.13. Light: held 5.72, paid 6.29,
returned 7.06, fail 5.70, alarm 5.88, inconclusive 6.47, disputed 5.64, machine
5.70, payer 5.90, worker 6.77, accent 7.38. Every pair clears 4.5:1.

On the soft grounds the hue's own text measures 4.96 to 8.02 dark and 4.65 to
5.70 light, and `--ink-3` at least 5.31 dark and 4.87 light.

Control edges use `--field`: 3.36:1 dark and 3.55:1 light against `--surface`,
above the 3:1 minimum for non-text. The focus ring is `--accent` (6.72 dark,
7.38 light against the surface). `--rule` hairlines are separators, never the
only cue for a control.

## 4. Typography

Two families from Google Fonts under the SIL Open Font Licence, self-hosted at
build time through `next/font` (no request to Google at run time, no layout
shift):

- **IBM Plex Sans** (400, 500, 600, 700): everything a person reads, and every
  figure. Figures use `font-variant-numeric: tabular-nums lining-nums` (the
  `.tnum` class), so columns of money align without a monospaced face, as in a
  terminal's quote list.
- **IBM Plex Mono** (400, 500): identifiers and raw machine output only:
  PayPal order, authorization, capture and payout ids, the contract id, URLs,
  selectors and repository names typed into fields, and text quoted from a
  delivered page (`.font-code`, `code`, `pre`).

| Role | Face | Size / line | Weight | Notes |
| --- | --- | --- | --- | --- |
| Page title | Plex Sans | 22 / 28 | 600 | Contract title, list and ledger titles; home is 26 / 32 |
| Panel title | Plex Sans | 12 / 16 | 600 | Uppercase, +0.02em, on the `--head` bar; the only uppercase label |
| Body | Plex Sans | 13 / 18 | 400 | |
| Small | Plex Sans | 12 / 16 | 400–500 | Hints, field and column labels (`.label`), sentence case |
| Tag | Plex Sans | 10.5 / 18 | 600 | Uppercase verdict and kind tags |
| Hero figure | Plex Sans `.figure-hero` | 20–22 | 600 | The contract amount and the money's current place |
| Figure | Plex Sans `.tnum` | 13 / 18 | 500–600 | Amounts in lists, the grid, the diagram |
| Identifier | Plex Mono | 10.5–12 | 400 | PayPal references shown whole; ids shortened to eight characters |

Rules: amounts never break across lines; numbers that are not money (counts,
confidence, times) are `.tnum` too so they align; nothing is letter-spaced
except the panel title.

## 5. Density and grid

Proviso is read by two people who care a great deal about one contract. Density
is a courtesy: the whole state of a contract fits in the first screen.

- Base unit 4 px. Panel header bars 28 px; panel bodies 12 to 16 px padding.
  Gap between panels 12 px of `--paper`, like a terminal's window gutters.
- The shell is fluid, like a terminal that fills its screen: the top bar, the
  page and the footer span the whole window with one gutter on each side,
  16 px on phones, 24 px from 640 px, 32 px from 1760 px. There is no maximum
  page width. What grows on a wide screen is the number of panels side by side,
  never the length of a line of prose: paragraphs keep a measure of about 36 to
  42 rem, and run log text and the mediator's reasoning are capped at 88
  characters.
- At 1280 × 720 (the size the demo is recorded at) the contract page shows the
  track, the whole money flow, and the heads of the run log and "Your move"
  without scrolling. Nothing scrolls sideways at any width; the ledger grid
  scrolls inside its own panel on a phone.
- From `3xl` (1760 px) a page is a screen, not a document. The contract page
  and the ledger are exactly the window's height less the shell
  (`--shell-chrome` in `globals.css`: top bar 45 px, the page's 24 px top and
  bottom padding, footer 42 px, 1 px of slack), with a floor (44 rem for a
  contract, 46 rem for the ledger) for short windows; the page itself never
  scrolls, and a panel whose content is longer scrolls inside itself (the run
  log column, the audit tape, the ledger grid). The contract list is at least
  that tall, and grows (the page scrolls) only when the list is longer than the
  window. The last panel in each column stretches to the bottom edge, so every
  column ends on the same line above the footer, the way a terminal's tiles do,
  instead of stopping short over bare `--paper`. Home is the exception: it
  starts under the top bar with the normal gutter and is as tall as its
  content, its three columns ending on one line; what fills a tall window there
  is the content drawn larger (the widest-breakpoint scale, below), never an
  empty box stretched to the bottom.
- The widest-breakpoint scale. Every size in the interface is in rem, so from
  `4xl` (2400 px: 2560 × 1440, 3440 × 1440) the root font size is 112.5 %, and
  type, row heights, padding and fixed columns grow together by 1.125; media
  queries still measure in the browser's default 16 px, so the breakpoints stay
  put. The home page's workspace (`.home-scale` in `globals.css`) is drawn a
  further 1.3 times larger there with CSS `zoom`, which also scales its borders
  and its pixel-sized icons, so on a 1440 px tall screen its columns reach most
  of the way down (about 1,060 px of the 1,290 below the top bar at 3440 ×
  1440 in a full-height window) instead of sitting in a short band. Only the
  home page is zoomed: the top bar and every other page keep 4xl's scale, so
  moving between pages never changes the chrome.

Breakpoints (Tailwind's, plus two for wide screens defined in `globals.css`):

| Name | From | What changes |
| --- | --- | --- |
| base | 0 | One column; the money flow is drawn top to bottom |
| `sm` | 640 px | 24 px gutters; tables replace cards for the contract list from `md` (768 px) |
| `lg` | 1024 px | Two-column layouts (below) |
| `3xl` | 1760 px (110 rem) | Pages fill the window's height; more panels side by side; 32 px gutters |
| `4xl` | 2400 px (150 rem) | Ultrawide layouts (2560 × 1440, 3440 × 1440): a third column; root type 112.5 %, the home workspace 1.3 times larger again |

Page by page:

| Page | Below 1024 px | 1024 to 1759 px | 3xl (1760 px) | 4xl (2400 px) |
| --- | --- | --- | --- | --- |
| Contract | Track, money flow, your move, run log, tape | Track and money flow across the page; run log beside a 380 px "Your move" column that stays in view; tape under the run log | Two columns, 1.4 fr and 1 fr. Left: track, money flow, then "Your move" (416 px) beside the audit tape, which fills the rest of the height. Right: dispute and run log, scrolling inside the column; the run log panel reaches the bottom | Three columns, 1.3 fr, 1 fr and 480 px. Left: track, money flow, and the audit tape filling the rest of the height. Middle: dispute and run log. Right: "Your move" as a full-height rail |
| Ledger | Flow list, figures, chart, grid | Flow across the page; figures beside the chart; grid below | Flow beside a 544 px column of figures over the chart; the grid takes the rest of the window's height and scrolls inside itself | Left: flow (drawn 340 px tall instead of 250), the four figures in one row, and the chart filling the rest of the height. Right (at least 1280 px, so every grid column fits): the grid at the window's full height |
| Contracts | Cards | Table with the figures above | The figures become a 272 px rail on the left; the table's panel reaches the bottom of the window | The table splits into two tables side by side, read down the first and then the second, both reaching the bottom |
| Home | Introduction, example, composer, steps | Introduction and example beside the composer; steps below in four columns | Three columns from the top, ending on one line: the introduction over the example run, which gains each reviewer's note on the AI-judged test and the run's signed receipt; the composer, with a text box of a set height and the two example deals written out in full (choosing one fills the box); and the steps as a rail down the third column, numbered stops in each step's colour joined by a line, sharing the column's height | The same, with the workspace drawn 1.3 times larger (the widest-breakpoint scale) |
| Proposal | Deal over proposal | Deal beside proposal | Deal at 480 px; the proposal's fields and its tests side by side | The tests in two columns, so a three-test proposal and its Create button fit on one screen |

Three rules make the wide layouts work without duplicating markup. Where a
panel moves between grids, its wrapper is `display: contents` below (or above)
the breakpoint, so the panels inside are placed in the outer grid directly; the
contract page's left column is a flex column at `3xl` and `contents` again at
`4xl`, where its panels and "Your move" are placed in a three-column grid with
rows `auto auto 1fr`. A panel that spans those rows is placed with an explicit
`row-[1/4]`, because Tailwind's `row-span-*` sets the whole `grid-row` and
would undo its `row-start`. And the money flow responds to its own width, not
the window's: it is a container, it draws one row of places once it has 58 rem
of room, and its type grows with the room (section 7.3).
- Panels have square corners and a 1 px `--rule` edge; controls and tags have
  2 px corners. Elevation comes from the grey steps, never from shadows
  (dialogs are the one exception).
- Row heights: grid rows and grid headers 28 px; run log and tape rows are as
  tall as their content with 1 px separators.

## 6. Components

**Top bar.** One `--paper` bar: the mark and the word "Proviso" in 15 px bold
(section 9), the three pages as uppercase links (the active one in `--ink` with a 2 px
accent underline), then "Viewing as" with the payer/worker switch and the theme
switch. A 2 px line in the viewer's role colour runs along its top edge.

**Panel.** A `--surface` box with a 1 px `--rule` edge and a 28 px `--head` bar
holding the uppercase title, optional context in `--ink-2` sentence case, and
an aside on the right. Panels are not numbered.

**Track.** Seven stations on a rule. Done stations are filled `--ink` with a
check; the current station is a filled square in its state colour with its name
in that colour; a branch drops below the station it left from. A station's
label is always text, never only a dot. The micro-track in lists is seven 6 px
ticks with the current tick in the state colour.

**Money flow.** The panel that answers "where is the money, and where can it
go". It is the product's signature element and has its own section (7).

**Run log.** The tests as the verifier's log. Under the header bar, the
headline ("3 of 4 failed") with the segmented meter, then one row per
condition: a fixed-width verdict tag, the condition, the verifier's reasoning
with its confidence, the check signature, and the evidence thumbnail on the
right. A failed row carries a faint `--fail-soft` ground and a 3 px `--fail`
edge bar, like a flagged row in a quote list; inconclusive and checking rows do
the same in their colours. When there are several
attempts they are flat tabs in the header bar, the chosen one filled with the
accent. Rows land one by one as verdicts arrive: verdicts that arrive while the
page is open are held back for a moment and played in test order
(`staged-rows.ts`), so a run that finishes between two polls still reads as a
run. A test decided by code lands on its turn; an AI-judged test shows its
review panel voting, one reviewer at a time ("Reviewers voting · 2 of 3"), and
only then its result. Nothing is shown before the API has reported it, verdicts
already there when the page opened show at once, and so does everything under
reduced motion. While a run plays in (a few seconds; the turns of one batch take
at most 2.6 s, plus 2.65 s per AI-judged test), the rest of the page (header,
track, money flow, "Your move", receipt, audit tape) holds what it showed
before those verdicts arrived, and the receipt waits for the run, so no panel
announces a result the run log has not shown yet; everything flips to the real
state when the last result lands. The failure banner and the dispute card are
never held.

**Review panel.** How an AI-judged test was decided, drawn under that test's
row in the run log (`review-panel.tsx`). A `--surface-2` header line names it
("Review panel · 3 AI reviewers judged it independently") and gives the result
on the right in its colour: "All 3 agree: pass" in `--paid`, "All 3 agree:
fail" in `--fail`, and anything else in `--inconclusive` with a question mark,
saying why a person decides ("Reviewers disagreed, so a person decides" with
the tally "2 pass · 1 fail"; "A reviewer was unsure, so a person decides"; "A
reviewer could not answer, so a person decides"). Below it one cell per
reviewer side by side (stacked under 26 rem of room), each with a 2 px top
edge in its vote's colour: the role's name and brief (Strict reader, "Takes
the test word by word"; Worker's advocate; Sceptic, "Hunts for manipulation and
missing evidence"), the vote as a tag (filled for pass and fail, outlined for
unsure and no answer) with its confidence as a figure and a ten-cell meter,
"Flagged text aimed at the verifier" in `--alarm` when that reviewer reported
it, and its reasoning under a rule. The reasoning is open from the start when
the panel did not pass, and behind "Each reviewer's reasoning" when it did. The
footer states the rule ("a pass or a fail needs all three to agree, each at
least 80% sure. Anything else is not decided by the AI."). A split never looks
like a failure: its colour is `--inconclusive`, not `--fail`. A test decided by code gets a plain outlined "Checked by code"
mark with "a fact, not a judgement" instead, so a fact and a judgement never
look alike.

**Receipt.** What the verifier signed about the contract (`receipt-panel.tsx`),
a panel under "Your move" ("Receipt · signed by the verifier · Ed25519"). A
two-column list of labels in `--ink-3` and values: Terms (the terms
fingerprint, fixed when both signed), Run (the outcome as a tag, Passed,
Failed or Inconclusive, with the attempt and the number of verdicts), Issued,
Verifier (name, version and model), Receipt (its hash) and Signed by (the key
fingerprint, with "this verifier's key" when it matches the published key, or
"not this verifier's current key" in `--disputed`). Hashes are shortened to
`9f2c41ab…e01d` in mono with a dotted underline and copy the whole value on
click. Under a rule, "Check it yourself": the command that verifies the
receipt independently, in an inset code block with Copy, and links to every
receipt and the verifier's public key as JSON. Each verdict in the run log
shows its own signed evidence hash the same way. A receipt is a record, never a
gate: nothing in the panel moves money. Before a run it says the verifier
signs a receipt for every run it finishes.

**Recap.** On a paid contract, one line under the parties in the page header
(`recap.tsx`) says what happened, every figure read from the contract's own
records: the work was submitted (and on which attempt), how many tests passed
and how the AI reviewers voted, that the verifier signed a receipt, that PayPal
paid the worker the amount, and the time from the passing submission to the
contract becoming PAID ("6 min 45 s from submission to payment"). It is a
`label` and plain text joined by small arrows; only the PayPal step is
`--paid`. It is not shown in any other state; when the payout lands with the
page open it stamps in.

**Example run (home).** The home page shows how a run reads with a worked
example, labelled as one ("Example run · website milestone"): four tests, an
AI-judged test with its three reviewers, a caught manipulation attempt and the
money rail. When it scrolls into view it plays once over about six seconds, in
the run log's own motion (rows checking then stamping, reviewers voting in turn,
the alarm, the money moving to "Paid out"), then offers Replay; its box never
changes size while it plays. Under reduced motion it shows the finished run.

**Loading.** A contract that is loading shows the page's own grid with empty
panels (outline and title strip) at their usual sizes at every breakpoint, so
nothing jumps when it arrives.

**Alarm.** Only for manipulation attempts. A flat `--alarm-fill` bar inside the
verdict ("Manipulation attempt detected · recorded · ignored"), the injected
text quoted in mono, and where it was found. In the run log header the count is
a solid red tag.

**Tape.** The audit trail, newest first: time (tabular, 24-hour, seconds),
actor (role colour for people, cyan for the verifier and the mediator, neutral
ink for PayPal and Proviso), what happened with a tone square in the colour of
where the money or the contract went, and references in mono. Repeated
failures fold into one line with a count.

**Your move.** The viewer's own obligations: a grey header bar with the role
letter, "Your move · Payer" as the panel title and the identity, a 2 px line in
the role colour along the panel's top, then only the actions the API allows.
When there is nothing to do it says what the viewer is waiting for.

**Tags and chips.** Tags are rectangular, 2 px radius, uppercase 10.5 px
semibold; decided outcomes are filled, pending ones outlined. State chips are a
square dot and the state's name on a faint tint.

**Segmented controls and tabs.** Flat cells divided by 1 px rules; the active
cell is filled with `--accent-fill` and white text, as a terminal marks its
active tab. Used for the theme switch, contract-type choice, list filters and
attempts. The payer/worker switch fills the active side in that role's colour,
because it is an identity, not a selection.

**Buttons.** 36 px (small 30, large 40), 2 px radius. Primary is an
`--accent-fill`; secondary is `--surface-2` with a `--field` edge. Actions that
bind a person (sign, submit) are filled in that person's role colour. Accepting
a split that pays out is `--paid`. Destructive or contesting actions are
outlined. Pressed, filled buttons darken (brightness 0.9) and outlined ones
take the next grey step, so a click registers on screen. The PayPal button is
PayPal's own and is never restyled; Proviso only frames it.

**Fields.** `--inset` ground, `--field` edge, 2 px radius, 13 px text; the edge
turns `--accent` on focus. URLs, selectors and repository names are typed in
mono.

**Notices and quoted sides.** A box with a 1 px `--rule` edge and a 3 px edge
bar in its colour: notices on `--surface` with the title in that colour and the
body in `--ink-2`; a party's side of a dispute or a party's identity in the
composer on `--surface-2` with the bar in the role colour. No tinted cards.

**Grid (ledger).** AG Grid Community themed through its theming API with the
same tokens, passed as `var(--token)` strings so the grid follows the theme
without a re-render (`browserColorScheme: "inherit"`): `--head` header row in
sentence case, 28 px rows, tabular figures right-aligned in four accounting
columns (into hold, captured, paid out, returned), the accent for selection and
focus, a pinned totals row in semibold that sums what the filters show. Five
filter chips, one per ledger kind, are the same five paths the money flow
draws, so a flow chosen in the diagram and a chip are one filter. No Enterprise
features.

**Summary band and chart (ledger).** Four figures (held now, paid out, holds
released, refunded) in `--ink`, each labelled with a square in its money colour,
beside a step chart of money over time drawn with AG Charts Community: the held
balance as an amber area, paid out as a solid green line, returned as a dashed
slate line, so the series differ by shape as well as colour; dotted grid lines;
the legend is written out in HTML in the panel's header bar. The chart draws to
a canvas, so the tokens are resolved to concrete colours from an element inside
the themed tree and re-read when the theme changes. A screen-reader caption
states the current totals.

## 7. The money flow (signature element)

Proviso's promise is about money moving by itself, so the one drawing every
judge and every user should remember is the picture of where the money is and
where it can go. It appears twice: for one contract under its track, and summed
over every contract at the top of the ledger. Both are drawn by Proviso in SVG
and HTML; no charting library is involved.

### 7.1 Places (nodes)

A place is somewhere a contract's money can be. There are exactly five, always
drawn, always in the same positions, so that a viewer who has seen one contract
can read any other at a glance:

| Place | What it is | Colour when the money is there |
| --- | --- | --- |
| Payer's PayPal | The payer's account, before funding | `--ink` (no money colour: nothing has happened yet) |
| PayPal hold | The authorization: reserved on the payer's account, not charged | `--held` |
| Captured | Proviso's PayPal balance after capture, waiting to pay out | `--held` |
| Worker's PayPal | Where a pass sends it | `--paid` |
| Back to payer | Released holds and refunds | `--returned` |

A place box is a flat, square-cornered box. It carries its mark (the role
letter for people, a lock for the hold, a `C` letter mark for Proviso's balance, ↩ for the
return), its title in semibold sentence case, who it belongs to, the amount,
and one or two words of state. A place is in one of five states,
each with its own frame so the state never depends on colour:

- **current** (the money is here now): the strip grey ground (`--surface-2`),
  a 3 px bar in the place's colour down its left edge, the amount as the hero
  figure in `--ink`, and a filled `NOW` tag in the place's colour. A split has
  two current places. The colour is in the bar and the tag, never in a large
  figure.
- **incoming** (money is on its way here: a payout PayPal has not confirmed):
  dashed edge in the place's colour, the amount it will receive, "on its way".
- **visited** (money passed through): solid neutral edge, a check, and what
  happened ("captured", "charged", "split two ways").
- **possible** (money may still come): dashed neutral edge, what it would
  receive in `--ink-3`, and the condition ("on a pass", "if both accept").
- **closed** (money can no longer come): dotted edge, no figure, the outcome in
  words ("nothing paid", "never captured").

### 7.2 Legs (edges)

A leg is one PayPal operation, and each maps to exactly one ledger kind, which
is why the ledger can be filtered by clicking one:

| Leg | From → to | Ledger kind | PayPal reference shown |
| --- | --- | --- | --- |
| Hold placed | Payer → hold | `AUTHORIZED` | authorization id |
| Captured | Hold → captured | `CAPTURED` | capture id |
| Paid out | Captured → worker | `PAID_OUT` | payout batch id |
| Hold released | Hold → back to payer | `VOIDED` | authorization id |
| Refunded | Captured → back to payer | `REFUNDED` | refund id |

A leg is in one of five states, drawn so they differ by shape before colour:

| State | Line | Label |
| --- | --- | --- |
| done | Solid 2.25 px in the destination's colour, with an arrowhead | Verb in the destination's colour and amount in `--ink` above the line; local time and the whole PayPal reference (mono) below |
| moving | Dashed (7 on, 6 off) in its colour, flowing, with a packet travelling along it | "Sent" and amount; "waiting for PayPal" and the payout batch id; the attempt number once PayPal has returned one |
| possible | Dashed (3 on, 4 off) in `--field`, with an arrowhead | "Captured when" and the trigger in words: "all 3 tests pass", "nothing passes by the deadline" (with the deadline, absolute and relative), "both accept the split", "the payer approves in PayPal" |
| closed | Dotted `--rule-strong`, no arrowhead | One phrase: "no refund", "never captured" |
| failed | Dashed `--fail` | "✕ Returned 3×", the amount struck through, the last batch id |

Everything is derived from what `GET /api/contracts/[id]` already returns: the
ledger rows decide which legs are done and with what amount, time and
reference; `payout` decides an in-flight payout and its status; `activity`
decides a leg PayPal is working on right now (capturing, releasing,
refunding); the events count returned payouts (`PAYOUT_RETRIED`,
`PAYOUT_ABANDONED`); the contract state and the dispute's proposal decide which
legs are still possible and what would trigger them. The model is
`src/components/contract/money-flow.ts`; nothing in it is decided by the page.

### 7.3 Layout

Once the panel's drawing area is 58 rem (928 px) wide, which is a 1024 px
window with the panel spanning the page, the places sit on one line, left to
right in the order the money travels (payer, hold, captured, worker), with "back to payer" under the
capture: the release leg drops from the hold and turns right into it, the refund
leg drops straight down from the capture. A split therefore reads as the
capture's two exits, the worker's share going right and the payer's share going
down, each labelled with its amount. The panel's grey header bar carries the
title and states the position in words ("$400.00 paid to worker") in the colour
of where the money is; the bottom row holds the legend (moved, moving now, can
still move, no longer possible) on the left and the one-sentence detail with the
PayPal order id on the right. At 1280 × 720 the whole panel reads under the
track without scrolling.

Narrower than that, the same places stack top to bottom with the legs down a
spine on the left and "back to payer" beside the capture; leg labels sit beside
the spine, so nothing is shortened on a phone. The switch is a container query
on the panel, so the diagram picks the right drawing in whatever column a
layout gives it.

On a wide screen the diagram grows instead of sitting small in a long band:
every type size, line height and box height in it is multiplied by `--fs`, which
is 1 up to 80 rem of room, 1.12 from 80 rem, 1.25 from 96 rem (the left column
at 3440 px) and 1.4 from 120 rem. The legs are measured from the rendered boxes,
so they follow.

The places and labels are HTML in a CSS grid; the legs are one SVG drawn over
it from the measured boxes of the places, redrawn when anything resizes.

### 7.4 Motion

Money moving is the moment the product exists for, so it is the one place
where motion is allowed to be seen. When a ledger row lands while the page is
open:

1. If the panel is out of view (the viewer was watching the run log), the page
   scrolls it into view first, unless the viewer is typing.
2. The leg draws itself from source to destination in the destination's colour
   (1.1 s, ease in and out) while a 10 px packet travels its length.
3. The destination keeps its previous state until the packet arrives, then
   takes its new state, its `NOW` tag stamps in and a ring breathes out once.
4. The leg's label stamps in with the amount and the PayPal reference.

Several legs taken in one update (capture and payout together) play in the
order the money took them, 1.2 s apart. A payout PayPal has not confirmed is
the only looping motion: its dashes flow and a packet runs along it until PayPal
says the money arrived, which then plays as above. Under
`prefers-reduced-motion: reduce` there is no drawing, no packet and no ring;
the new state simply appears, because every state is drawn, not animated.

### 7.5 The ledger's flow

The ledger opens with the same five places summed over every contract (in its
main currency) as a Sankey: band widths are amounts. Payers feed the holds; the
holds feed the capture and, at the bottom, back to payers; the capture feeds the
workers and back to payers. Money still held does not flow on: it leaves its
place as a short amber stub that fades out, labelled "still held". Bands are
tinted in their destination's colour at 30 % so overlapping bands stay legible;
the place bars are solid. Column heads stack a coloured name, the amount in
`--ink` and a note. Pointing at a flow, in the drawing or the list, or
having chosen it, raises that band to 60 % with a 1 px edge and drops the others
to 9 %, so the picture shows exactly what the grid will show.

Beside the drawing, a list names every flow with its route, its number of
movements and its exact amount, plus what is still held now. Each flow, in the
drawing or the list, filters the ledger grid to that ledger kind; choosing it
again shows everything. The list is the keyboard and screen-reader control
(buttons with `aria-pressed`; the chosen row takes the accent tint with a 3 px
accent edge, like a selected row in a quote list); the drawing is
`aria-hidden`. Under 1024 px only
the list is shown, each row with a bar in proportion to what went into holds:
below that width the columns are too close for their heads to sit side by side.

AG Charts Community 14 has no Sankey series (it is an Enterprise feature), so
this is drawn in SVG like the contract diagram.

## 8. Motion

Motion says that something changed state. It never decorates.

| What moves | Why | How long |
| --- | --- | --- |
| A verdict row landing | A test just got its verdict | 240 ms fade and 6 px rise; the tag stamps in (scale 1.12 → 1) over 180 ms; rows stagger by 60 ms |
| Verdicts that arrive with the page open | The run is happening now | Played in test order: 650 ms between tests; an AI-judged test's reviewers vote 700 ms apart and its result follows 550 ms after the last vote |
| The home example run | Shows a run before the visitor starts one | Nine beats over about 6 s, once, when it scrolls into view; Replay plays it again |
| The recap on a paid contract | The payout just landed | Stamps in, 180 ms, only when it appears with the page open |
| The checking row | The verifier is working on this test | A scan line sweeps the row every 1.4 s |
| A state chip while the verifier works | Submitted or verifying | Its dot's opacity pulses, 1.6 s |
| A money-flow leg being taken | Money just moved (section 7.4) | Leg draws and a packet travels, 1.1 s; the destination rings once, 0.8 s; legs play 1.2 s apart |
| A payout PayPal has not confirmed | Money is on its way | Dashes flow along the leg, 0.9 s loop; a packet runs it every 1.8 s |
| New ledger rows | A movement just landed | AG Grid cell flash in the `held` tint, 1 s |
| A ledger flow pointed at | Shows what choosing it will filter (section 7.5) | Band opacity change, 150 ms |
| Hover, press | Feedback | 100 to 120 ms colour change |

The current station on the track does not pulse: it is marked by its filled
square and its colour. Easing is `cubic-bezier(0.2, 0, 0, 1)` for entrances and
linear for loops. Under `prefers-reduced-motion: reduce`, every animation and
transition above is removed; state changes still show because they are drawn,
not animated.

## 9. Iconography

Line icons on a 24 px grid, 1.75 px stroke, round caps, drawn for Proviso. Icons
are decorative unless they stand alone, in which case they carry a title. The
outcome glyphs are a closed set that always travels with its word: ✓ pass,
✕ fail, ? inconclusive, dashed circle queued, scan frame checking, shield
manipulation, lock held, scale disputed. Letter marks identify parties in a
2 px-radius square: `P` payer, `W` worker, `C` Proviso's balance (C for captured, since `P` is the payer).

The mark (`brand.tsx`) is the product's own vocabulary: a 3 px-radius
`--accent-fill` square with a square-capped `--accent-on` check, the shape a met
condition takes on the track. It sits before the word "Proviso" in the top bar
and is the favicon (`src/app/icon.svg`, `favicon.ico`) and the app icon
(`apple-icon.tsx`). The Open Graph image (`opengraph-image.tsx`, 1200 × 630,
built once at build) is the dark theme: the mark and name, the headline and the
home page's one sentence, and the example run in its finished state, set in IBM
Plex Sans (OFL, `src/assets/fonts`).

## 10. Voice and microcopy

- Say what happened and who did it: "PayPal placed a hold of $250.00 on the
  payer's account", not "Funds secured".
- Name PayPal at every money step. Money is "held", "captured", "paid",
  "released" or "refunded"; never "processed". "Released" always means a hold
  going back to the payer.
- The machine reports, it does not reassure. Verifier text is quoted as
  written. The AI "proposes"; people "decide", "sign" and "contest".
- No slogans in the product: a sentence either states a fact or tells the
  viewer what will happen next.
- Errors show the API's own words and what will happen next ("Proviso tries again
  automatically"). No "Oops", no exclamation marks, no emoji.
- Times: relative for "when" ("in 22 hours"), absolute on the tape and on hover.
  Deadlines show both.
- Labels in sentence case; only panel titles, the top-bar links and tags are
  uppercase.

## 11. Themes

Dark and light are generated from the same token names and are equals: every
screen is designed and checked in both. Dark is the default look of the
terminals this idiom comes from and the theme the demo is recorded in; light is
white panels with light grey strips and header bars, the same structure.

A first-time visitor gets their operating system's preference. The theme switch
in the top bar offers System, Light and Dark; an explicit choice is stored in a
`clause_theme` cookie that the server reads, so the first paint is already in
the right theme and nothing flashes. "System" deletes the cookie and lets the
`prefers-color-scheme` media query decide in CSS. The `color-scheme` property
follows the theme so native controls and scrollbars match.

## 12. Accessibility commitments

- Text contrast of at least 4.5:1 in both themes for every text token on every
  surface it is used on (section 3.3); control edges at least 3:1.
- No information by colour alone: every state has a word, every outcome a
  glyph, every role a letter and a name, every station a label.
- A visible focus ring on every interactive element: 2 px `--accent` outline
  with a 2 px offset.
- Real labels on every field; groups of toggles use `aria-pressed`; the track is
  an ordered list with `aria-current="step"`; live headlines use `aria-live`.
- Motion is removed under `prefers-reduced-motion`.
- Layout works from 360 px to 3440 px wide with no horizontal scroll; touch
  targets are at least 30 px high and 36 px for primary actions.
- Screenshots of evidence have descriptive alt text; full-size views open in a
  native `<dialog>` that closes with Escape.
