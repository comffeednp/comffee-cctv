# Dashboard design spec

The dashboard follows the Comffee design rules: SAP Fiori (Horizon) type in the 72 font on the Comffee
colours (espresso ground, cream text, mocha labels, amber accent, phosphor for live). This file is the
contract for every screen. Screens use the components in `dashboard/src/components` and the classes in
`dashboard/src/styles/theme.css`; they never add their own colours, fonts, font sizes, radii or shadows.

- Stylesheet: `import './styles/theme.css';` once in `dashboard/src/main.tsx`.
- Components: `import { Button, Section } from '../components/index.ts';` (path relative to the screen).
- Router links: wrap the app once in `<NavigationContext.Provider value={navigate}>`; every component that
  takes `href` then routes plain clicks on in-app paths through `navigate` (no full page load).
- Toasts: wrap the app once in `<ToastProvider>`; screens call `useToast().show({...})`.
- Service worker: call `registerServiceWorker()` once in `main.tsx`.

## 1. Tokens

All tokens are CSS custom properties on `:root` in `theme.css`. Use them through the classes below; in a
screen's own markup, write `var(--token)` only for layout values (spacing, sizes) and never a literal colour.

### Colours

| Token | Value | Use |
|---|---|---|
| `--color-bg` | #0a0807 | Page ground, field wells |
| `--color-bg-soft` | #14100d | Side nav, bottom bar, grouped lists, timeline track |
| `--color-bg-card` | #1c1714 | Cards, dialogs, popovers, hover fill |
| `--color-bg-elev` | #2a2320 | Selected or pressed fill, toasts, neutral badges |
| `--color-video` | #000000 | Behind video |
| `--color-line` | #2e2622 | Hairlines between rows, card edge |
| `--color-line-bright` | #3d3430 | Button rim, segmented rim |
| `--color-line-field` | #75665a | Field rim, switch rim |
| `--color-cream` | #f4ecdf | Titles, values |
| `--color-cream-dim` | #e9e1d3 | Body text, menu rows |
| `--color-mocha` | #b2a597 | Labels, secondary lines, hints, icons in rows |
| `--color-mocha-deep` | #8a7a68 | Placeholders, disabled days |
| `--color-ink` | #150e07 | Text on amber |
| `--color-amber` | #ffb547 | The accent: primary button, links, focus ring, selected marks, recorded blocks |
| `--color-amber-hover` | #ffc978 | Primary button hover |
| `--color-phosphor` | #7cffb2 | Live, online, recording, success |
| `--color-error` | #f87171 | Errors and failures only (offline, failed, delete) |
| `--color-error-hover` | #fca5a5 | Danger button hover |

Tints: `--color-amber-soft`, `--color-amber-line`, `--color-phosphor-soft`, `--color-error-soft`,
`--color-error-line`, `--color-error-line-hover`, `--color-scrim` (dialog backdrop), `--color-video-scrim`
(labels over video). Shadows: `--shadow-popover`, `--shadow-dialog`, `--shadow-float`.

Colour meaning is fixed: amber = needs a person or is the main action, phosphor = live or fine, mocha =
neutral, red = an error or failure. Red is never decoration. Colour never carries meaning alone: a status
always has its word next to it.

### Type (SAP Horizon in 72)

Font `--font-sans` = 72 (Regular 400, Semibold Duplex 500/600, Bold 700, Black 900), self-hosted in
`dashboard/public/fonts` (Apache 2.0, `LICENSE.txt` and `NOTICE.md` beside the files). `--font-mono` =
the system monospace, for literal codes, addresses and scripts only. No other face, no letter-spacing, no
uppercase, no italic, no inline font sizes.

| Role | Size / line / weight | Class | Colour |
|---|---|---|---|
| Page title (h1, one per page) | 24 / 1.25 / 900 | `k-h1` (PageHeader) | cream |
| Section title (h2) | 20 / 1.25 / 700 | `k-title2` (Section) | cream |
| Card, list, form, dialog title | 16 / 1.25 / 700 | `k-h6` | cream |
| Row title | 16 / 1.5 / 700 | ListRow | cream |
| Body copy | 16 / 1.5 / 400 | `k-body` | cream-dim |
| Page subtitle | 16 / 1.5 / 400 | `k-lead` (PageHeader) | mocha |
| Base text: labels, values, leads, secondary lines, menus | 14 / 1.5 / 400 | `k-body-s` | mocha (values cream) |
| Field label (+ colon) | 14 / 1.5 / 400 | FormField | mocha |
| Small: hints, timestamps, footnotes, badges | 12 / 1.5 / 400 | `k-xs`, `footnote` | mocha |
| Caption above a page title | 14 / 1.25 / 700 | `k-caption` | amber |
| Button | 14 / 1.25 / 600 (primary 700) | Button | amber / ink |
| Stat number | 24 / 1.15 / 700 tabular | `k-stat` | cream |
| Code (setup code, one-time code) | 20 / 1.2 / 600 mono tabular | `k-code`, `CopyBox code` | cream |
| Monospace inline (IP, path) | 14 / 1.5 mono | `mono` | inherits |

Helpers: `tnum` (tabular figures for every number in a column), `fw-bold`, `fw-semibold`,
`text-cream`, `text-cream-dim`, `text-mocha`, `text-amber`, `text-phosphor`, `text-error`, `truncate`,
`sr-only`.

Writing: sentence case everywhere. Titles 1-4 words, no full stop. Labels 1-3 words; the colon is drawn
by FormField, never typed. Placeholders in sentence case, no full stop, never repeating the label. Leave
an empty value blank, never "N/A". Buttons are verbs that keep their name through the flow ("Save", then
"Saving...", then a "Saved." toast). Errors say what happened and how to fix it, without apologising.
Raw error codes never reach the screen: map each `ApiErrorCode` to a sentence with a fallback ("That did
not go through. Try again.").

### Shape, space, layout, motion

| Token | Value | Use |
|---|---|---|
| `--radius-card` | 12px | Cards, grouped lists, dialogs, video frames |
| `--radius-control` | 8px | Buttons, segmented control, popovers, toasts, copy box, nav rows, calendar days |
| `--radius-field` | 4px | Text fields and the Select trigger |
| `--radius-pill` | 999px | Badges, dots, switch |
| `--space-1..7` | 4, 8, 12, 16, 24, 32, 48 | The only gaps and paddings |
| `--gutter` | 16 (phones), 24 (from 768) | Page side padding |
| `--sidenav-w` | 256px | Desktop side nav |
| `--topbar-h` | 56px | Top bar |
| `--bottomnav-h` | 61px | Phone bottom bar (plus the home-indicator inset) |
| `--phone-bottom` | bottom bar + inset on phones, 0 from 1024 | Clearance for anything fixed at the bottom |
| `--content-max` | 1200px | Main column width cap |
| `--tap` | 44px | Minimum tap target |
| `--ease-standard`, `--ease-enter`, `--ease-exit` | curves | Motion |
| `--dur-fast`, `--dur`, `--dur-slow` | 120, 150, 240 ms | Motion |

Motion answers something (a tap, a choice, a live change) and never plays because a page loaded.
Transform and opacity only. Every animation stops under `prefers-reduced-motion: reduce` (theme.css
already handles this for every component). The focus ring is a 2 px amber outline, shown at once; fields
draw it on their own edge.

## 2. Page anatomy

Every signed-in screen renders inside `AppShell`, and its content starts with `PageHeader`.

1. `PageHeader`: optional back link (sub-pages), optional caption, ONE h1, ONE subtitle line, optional
   status badge beside the h1, optional actions. Exactly one h1 per page, nowhere else.
2. Then sections. Every block under the header lives in a `Section` (h2 + one-line lead). Inside a
   Section, card titles are h3 (Card's default). Headings never skip a level.
3. Rows and cards: title 16 Bold cream + one secondary line 14 mocha. Values (dates, sizes, counts) go in
   the right column with tabular figures, never inside a sentence.
4. Body copy is `k-body`; the last line of a page may be a `footnote` (12 mocha, left aligned).
5. Hubs and settings (Settings, a location, a camera): a stack of Sections, each with ONE `GroupedList` of
   `ListRow`s with chevrons. One row = one destination. No forms, tables or inline Save/Edit/Delete
   buttons on a hub. Destructive rows (Delete location) go last, in their own GroupedList, `tone="danger"`.
   Counts and states are the row `value` or a `Badge`, never a sentence.
6. Editing pages: exactly ONE save, the `FloatingSave`. No other Save, Update or Apply button on the page.
   One-shot actions are not saves and keep their own single primary Button (Add camera, Test connection,
   Create viewer, Send).
7. Flows (setup, add camera, new location): one step per screen. Each step is a Section whose title is the
   step name and whose lead says "Step 2 of 4" style progress in words plus what to give, then the fields,
   then ONE primary Button named for the step's verb ("Next", "Create location"). Back is a ghost Button on
   the left of the primary.
8. Every dropdown is `Select`. Never a native `<select>`, never a hand-made menu.
9. Single choices of 2-4 short options use `SegmentedControl`; on/off settings use `Toggle`.
10. One idea per element: a label is 1-3 words; a helper line fits on one line at 360 px. No card inside a
    card. No box inside a box. Never a paragraph where a label and a value would do.
11. Empty lists show `EmptyState` with the one action that fills them. Loading shows `Spinner` (with a
    label) in the place the content will appear.
12. Confirmations of destructive or sensitive actions use `Dialog` (with `password` when the API requires a
    password). Results of an action show as a `Toast`; errors that block a form show on the field
    (`FormField error`) or as a `Dialog error`.

## 3. Phone and laptop

Width bands: phone below 768, tablet 768-1023, laptop 1024 and up. Everything must work at 360 px wide.

- Below 1024: sticky top bar (camera mark, title slot, actions slot) and a fixed bottom bar with at most
  5 items (icon 24 + 12 px label). Main content clears the bar (`--phone-bottom`). Toasts show at the top,
  under the top bar.
- From 1024: a 256 px side nav (product name, nav rows 48 px with 24 px icons, an optional footer slot),
  no bottom bar, the top bar only holds the title and actions. Toasts show at the bottom left of the
  content.
- One column on phones with a 16 px gutter; nothing scrolls sideways; tap targets are at least 44 px
  (rows 56 px). Buttons in a row wrap instead of overflowing. Long names wrap; codes and addresses break
  anywhere (`CopyBox`).
- Grids: `grid-tiles` (1 column on phones, then as many 280 px columns as fit) for camera tiles;
  `grid-2` (two columns from 768) for side-by-side panels.
- Video: `media-16x9` holds a `<video>` (16:9, black, 12 px corners); `media-overlay` puts the camera name
  and a StatusDot over the bottom of the video; `media-center` centres a Spinner or a message on it;
  `IconButton variant="overlay"` for controls on video.
- Fixed bottom things (FloatingSave) sit above the phone bar automatically.
- The FloatingSave is bottom right; nothing else may be fixed in that corner.

Layout helpers in theme.css: `stack` (column, gap 16), `stack-8`, `stack-24`, `row` (centred row, gap 8),
`row-between`, `wrap`, `grow`, `shrink-0`, `divider`, `grid-tiles`, `grid-2`, `media-16x9`,
`media-overlay`, `media-center`, `footnote`.

## 4. Components

All components are Preact function components. Props marked `?` are optional; defaults are in brackets.
Every component also takes `class?` for layout classes (spacing helpers only, never colours or fonts).

### AppShell

The frame of every signed-in screen.

| Prop | Type | |
|---|---|---|
| `nav` | `NavItem[]` | `{ href, label, icon: IconName, current?, badge?: string \| number, phone? [true] }` |
| `title?` | node | Short context in the top bar (location name or a location Select). Not a heading. |
| `actions?` | node | IconButtons at the right of the top bar |
| `sideFooter?` | node | Bottom of the desktop side nav (signed-in person, sign out) |
| `productName?` | string ["Comffee CCTV"] | Side nav brand |
| `navLabel?` | string ["Main"] | Accessible name of the nav |
| `children` | node | The page (PageHeader first) |

Owner nav: Live (`live`), Recordings (`recordings`), Cameras (`cameras`), Locations (`locations`), Settings
(`settings`). Viewer nav: Live, Recordings, Settings.

```tsx
<AppShell
  nav={[
    { href: '/live', label: 'Live', icon: 'live', current: path.startsWith('/live') },
    { href: '/recordings', label: 'Recordings', icon: 'recordings', current: path.startsWith('/recordings') },
    { href: '/cameras', label: 'Cameras', icon: 'cameras', current: path.startsWith('/cameras') },
    { href: '/locations', label: 'Locations', icon: 'locations', current: path.startsWith('/locations') },
    { href: '/settings', label: 'Settings', icon: 'settings', current: path.startsWith('/settings') },
  ]}
  title={locationName}
  actions={<IconButton icon="refresh" label="Reload cameras" onClick={reload} />}
>
  <PageHeader title="Live" subtitle="Every camera at this location, as it happens." />
  ...
</AppShell>
```

Sign-in, setup and other signed-out screens do not use AppShell: render a `<main class="app-main">` with a
PageHeader and one Card holding the form (max width about 440 px is up to the screen, using `stack`).

### PageHeader

| Prop | Type | |
|---|---|---|
| `title` | string | The h1 |
| `subtitle` | string | One line, required |
| `caption?` | string | Amber line above the title |
| `status?` | node | Badge or StatusDot beside the title |
| `actions?` | node | Buttons on the right |
| `back?` | `{ href, label }` | Quiet back link above, for sub-pages |

```tsx
<PageHeader
  back={{ href: '/cameras', label: 'Cameras' }}
  title="Front door"
  subtitle="Camera settings and recording."
  status={<StatusDot status="recording" />}
/>
```

### Section

| Prop | Type | |
|---|---|---|
| `title` | string | h2 (or h3 with `level={3}`) |
| `lead` | string | One line, required |
| `actions?` | node | Buttons on the right of the heading |
| `level?` | 2 \| 3 [2] | |
| `id?` | string | |
| `children?` | node | 16 px below the heading |

```tsx
<Section title="Cameras" lead="Each camera at this location.">
  <GroupedList label="Cameras">...</GroupedList>
</Section>
```

### Button

| Prop | Type | |
|---|---|---|
| `children` | node | Verb, sentence case |
| `variant?` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` ['secondary'] | ONE primary per screen |
| `size?` | `'m' \| 'l'` ['m'] | m 44 px; l 56 px for a flow step's main action |
| `type?` | `'button' \| 'submit' \| 'reset'` ['button'] | |
| `icon?` | IconName | Leading icon |
| `loading?`, `loadingLabel?` | boolean, string | Spinner, disabled, label swapped ("Saving...") |
| `disabled?`, `block?` | boolean | `block` = full width |
| `href?`, `download?`, `target?` | | Renders a link styled as a button |
| `form?`, `name?`, `value?`, `title?`, `id?`, `autoFocus?` | | |
| `onClick?` | `(event) => void` | |

```tsx
<Button variant="primary" type="submit" loading={saving} loadingLabel="Creating...">Create location</Button>
<Button variant="danger" icon="trash" onClick={() => setConfirm(true)}>Delete camera</Button>
```

### IconButton

| Prop | Type | |
|---|---|---|
| `icon` | IconName | |
| `label` | string | Required: accessible name and tooltip |
| `variant?` | `'quiet' \| 'secondary' \| 'danger' \| 'overlay'` ['quiet'] | overlay = on video |
| `size?` | `'m' \| 's'` ['m'] | m 44 px; s 36 px inside fields and dense rows |
| `pressed?` | boolean | On/off buttons (aria-pressed) |
| `loading?`, `disabled?`, `type?`, `href?`, `id?`, `aria-expanded?`, `aria-controls?`, `aria-haspopup?`, `onClick?` | | |

```tsx
<IconButton icon="fullscreen" label="Full screen" variant="overlay" onClick={enterFullscreen} />
```

### Icon

`<Icon name="cameras" size={20} />`. Sizes 16, 18, 20 (default), 24, 32. Decorative unless `label` is given.
Names: live, recordings, cameras, locations, settings, record, pause, play, fullscreen, exit-fullscreen,
detect, chevron, chevron-left, chevron-down, arrow-left, copy, download, calendar, list, timeline, grid,
check, warning, info, close, plus, trash, edit, user, users, key, storage, shield, audit, log-out, refresh,
eye, eye-off, router, link, cloud, more, search (`ICON_NAMES` lists them). Suggested meanings: router =
router connector, link = bridge connector, cloud = direct connector or uploads, key = recovery key,
audit = audit log, storage = storage, users = viewers, user = account.

### FormField, TextInput, PasswordInput

`FormField` draws the label (14 mocha with SAP's colon), the control, then one hint or error line. The
control inside picks up its id, `aria-describedby` and error state automatically.

| FormField prop | Type | |
|---|---|---|
| `label` | string | 1-3 words, no colon |
| `hint?` | string | One line: how the value must look. Hidden while `error` shows. |
| `error?` | string | What is wrong and how to fix it; turns the edge red |
| `optional?` | boolean | Adds "(optional)" to the label |
| `required?` | boolean | Marks the control required |
| `id?` | string | Control id (generated otherwise) |
| `children` | node | One TextInput, PasswordInput or Select |

| TextInput prop | Type | |
|---|---|---|
| `value`, `onInput` | string, `(value: string) => void` | Controlled |
| `type?` | `'text' \| 'email' \| 'url' \| 'search' \| 'tel' \| 'number'` ['text'] | |
| `mono?` | boolean | Monospace (IP addresses, paths) |
| `id?`, `name?`, `placeholder?`, `autoComplete?`, `inputMode?`, `enterKeyHint?`, `autoCapitalize?`, `spellcheck?`, `required?`, `disabled?`, `readOnly?`, `autoFocus?`, `maxLength?`, `minLength?`, `min?`, `max?`, `step?`, `pattern?`, `invalid?`, `aria-label?`, `onBlur?`, `onKeyDown?`, `inputRef?` | | |

| PasswordInput prop | Type | |
|---|---|---|
| `value`, `onInput` | | Controlled |
| `autoComplete?` | `'current-password' \| 'new-password' \| 'off'` ['current-password'] | |
| `id?`, `name?`, `placeholder?`, `required?`, `disabled?`, `autoFocus?`, `minLength?`, `maxLength?`, `invalid?`, `aria-label?`, `onKeyDown?`, `inputRef?`, `showLabel?` ["Show password"] | | Eye button inside the right edge |

```tsx
<FormField label="Camera address" hint="The camera's local IP address, like 192.168.1.20." error={errors.lanIp}>
  <TextInput value={lanIp} onInput={setLanIp} mono inputMode="decimal" autoComplete="off" />
</FormField>
<FormField label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
  <PasswordInput value={password} onInput={setPassword} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
</FormField>
```

Fields are 48 px tall wells with 4 px corners, value in 14, amber edge on focus. Stack fields with
`stack` (16 px apart).

### Select

The only dropdown. A field-shaped button opens a `k-popover` listbox of `k-option` rows (40 px, chosen row
filled with an amber underline and a check). Keyboard: Enter, Space, Arrow Down/Up open; Arrow keys, Home,
End move; Enter or Space picks; Escape closes; typing jumps to a matching label. The popover is fixed to
the viewport, flips above the field when there is no room below, and is never clipped by a card or dialog.

| Prop | Type | |
|---|---|---|
| `value` | `T \| null` | `T` is string or number |
| `options` | `SelectOption<T>[]` | `{ value, label, detail?, icon?, disabled?, group? }`; consecutive options with the same `group` show under that heading |
| `onChange` | `(value: T) => void` | |
| `placeholder?` | string ["Choose"] | |
| `id?`, `name?` (adds a hidden input), `disabled?`, `invalid?`, `aria-label?` (when not in a FormField) | | |

```tsx
<FormField label="Quality">
  <Select
    value={quality}
    onChange={setQuality}
    options={[
      { value: '360p', label: '360p', detail: 'Sub stream, least data' },
      { value: '720p', label: '720p', detail: 'Converted by the hub' },
      { value: '1080p', label: '1080p', detail: 'Main stream, most data' },
    ]}
  />
</FormField>
```

In the top bar: `<Select aria-label="Location" value={locationId} options={locationOptions} onChange={setLocation} />`.

### Toggle

| Prop | Type | |
|---|---|---|
| `checked`, `onChange` | boolean, `(checked: boolean) => void` | |
| `label` | string | 16 Bold cream |
| `description?` | string | One 14 mocha line |
| `disabled?`, `busy?` (spinner while saving), `id?` | | |
| `inList?` | boolean | Renders as a GroupedList row (wraps itself in the list item) |

```tsx
<GroupedList label="Recording">
  <Toggle inList label="Record this camera" description="Saved encrypted to the cloud." checked={recording} onChange={setRecording} />
</GroupedList>
```

### SegmentedControl

| Prop | Type | |
|---|---|---|
| `label` | string | Accessible name of the group |
| `options` | `SegmentOption<T>[]` | `{ value, label, icon?, iconOnly?, disabled? }`; 2-4 options |
| `value`, `onChange` | `T`, `(value: T) => void` | `T` is a string |
| `block?` | boolean | Equal segments across the full width |
| `size?` | `'s' \| 'm'` ['m'] | |
| `disabled?` | boolean | |

```tsx
<SegmentedControl
  label="View"
  value={view}
  onChange={setView}
  options={[
    { value: 'timeline', label: 'Timeline', icon: 'timeline' },
    { value: 'list', label: 'List', icon: 'list' },
  ]}
/>
```

### Card

| Prop | Type | |
|---|---|---|
| `title?`, `subtitle?` | string | 16 Bold title, one 14 mocha line |
| `icon?` | IconName | Mocha icon before the title |
| `headingLevel?` | 2 \| 3 \| 4 [3] | 2 when the card is itself a page section |
| `actions?` | node | Right of the title |
| `flush?` | boolean | No padding, clipped corners (video, full-bleed content) |
| `children?` | node | 16 px below the head |

One card groups ONE thing. Never a card inside a card, never a GroupedList inside a card.

### GroupedList and ListRow

| GroupedList prop | Type | |
|---|---|---|
| `label?` | string | Accessible name |
| `children` | ListRow or `Toggle inList` items | |

| ListRow prop | Type | |
|---|---|---|
| `title` | string | 16 Bold cream |
| `secondary?` | string | One 14 mocha line |
| `icon?` / `leading?` | IconName / node | 20 px mocha icon, or a custom node |
| `value?` | string | Right column, tabular figures |
| `trailing?` | node | Badge, StatusDot or a small button before the chevron |
| `href?` / `onClick?` | | Makes the row a link or a button |
| `chevron?` | boolean [true when href or onClick] | |
| `tone?` | `'default' \| 'danger' \| 'amber'` | danger rows go last in their own list |
| `selected?`, `disabled?`, `linkTitle?` | | |

```tsx
<Section title="Account" lead="Your sign-in and recovery.">
  <GroupedList label="Account">
    <ListRow icon="user" title="Account" secondary="Password and two-step sign-in" href="/settings/account" />
    <ListRow icon="key" title="Recovery key" secondary="Needed to open recordings" href="/settings/recovery-key" trailing={<Badge tone="amber">Not saved</Badge>} />
  </GroupedList>
</Section>
<Section title="Remove" lead="This cannot be undone.">
  <GroupedList label="Remove">
    <ListRow icon="trash" title="Delete location" tone="danger" onClick={() => setConfirm(true)} />
  </GroupedList>
</Section>
```

Never put a Select inside a GroupedList row; open a sub-screen instead.

### StatusDot

| Prop | Type | |
|---|---|---|
| `status` | `'online' \| 'offline' \| 'recording' \| 'paused'` | online/recording phosphor (recording pulses), paused amber, offline red |
| `label?` | string | Defaults: Online, Offline, Recording, Paused |
| `hideLabel?` | boolean | Word for screen readers only (it is never a bare dot for sighted people unless the word is visible nearby) |

### Badge

| Prop | Type | |
|---|---|---|
| `tone?` | `'neutral' \| 'amber' \| 'ok' \| 'error' \| 'count'` ['neutral'] | |
| `size?` | `'xs' \| 's'` ['xs'] | 12 or 14 px |
| `children` | node | One or two words, or a number |

### Dialog

Native `<dialog>` modal: focus stays inside, Escape and a backdrop click cancel (not while busy). Focus
starts on the password field when there is one, otherwise on Cancel.

| Prop | Type | |
|---|---|---|
| `open` | boolean | |
| `title` | string | "Delete this camera?" |
| `message?` | string | What happens, whether it can be undone |
| `children?` | node | Extra content |
| `confirmLabel` | string | The verb ("Delete camera") |
| `busyLabel?` | string | "Deleting..." |
| `cancelLabel?` | string ["Cancel"] | |
| `tone?` | `'default' \| 'danger'` ['default'] | danger = red confirm |
| `busy?`, `error?`, `confirmDisabled?` | | `error` shows above the buttons |
| `password?` | `{ label, hint?, autoComplete? }` | Asks for a password; confirm stays disabled until typed |
| `onConfirm` | `(password: string) => void` | Empty string when no password field |
| `onCancel` | `() => void` | |

```tsx
<Dialog
  open={confirmOpen}
  tone="danger"
  title="Delete this location?"
  message="Its cameras and recordings are removed for good."
  confirmLabel="Delete location"
  busyLabel="Deleting..."
  password={{ label: 'Your password' }}
  busy={deleting}
  error={deleteError}
  onConfirm={(password) => deleteLocation(password)}
  onCancel={() => setConfirmOpen(false)}
/>
```

### Toast

`<ToastProvider>` once around the app; `const toast = useToast();` in a screen.

`toast.show({ message, tone?: 'info' | 'success' | 'error', action?: { label, onClick }, durationMs? })`
returns an id; `toast.dismiss(id)`. Default 4 s; errors and toasts with an action 8 s. At most 3 at once.
Messages are one short sentence with a full stop ("Camera saved.").

### Spinner

| Prop | Type | |
|---|---|---|
| `size?` | 16 \| 20 \| 24 \| 32 [20] | |
| `label?` | string ["Loading"] | Read by screen readers |
| `decorative?` | boolean | Hidden when text beside it already says it |

### EmptyState

| Prop | Type | |
|---|---|---|
| `icon?` | IconName ['info'] | |
| `title` | string | "No cameras yet" |
| `message?` | string | One line inviting the next step |
| `action?` | node | Usually one primary Button |

```tsx
<EmptyState icon="cameras" title="No cameras yet" message="Add a camera to start watching and recording."
  action={<Button variant="primary" icon="plus" href="/cameras/add">Add camera</Button>} />
```

### FloatingSave

| Prop | Type | |
|---|---|---|
| `dirty` | boolean | Disabled until true |
| `saving?` | boolean | Spinner + `savingLabel` |
| `form?` | string | id of the page's `<form>`: the button submits it (preferred) |
| `onSave?` | `() => void` | When there is no form |
| `label?` ["Save"], `savingLabel?` ["Saving..."], `title?` | | |

```tsx
<form id="camera-form" onSubmit={save} class="stack">...fields...</form>
<FloatingSave form="camera-form" dirty={dirty} saving={saving} title="Save camera settings" />
```

### CopyBox

| Prop | Type | |
|---|---|---|
| `value` | string | Exact text shown and copied |
| `label` | string | "Setup code", "Bridge token", "Router script" |
| `multiline?` | boolean | Keeps line breaks, scrolls after 240 px (scripts) |
| `code?` | boolean | Large 20 px digits for short codes |
| `copyLabel?` ["Copy"], `copiedLabel?` ["Copied"], `onCopy?` | | |

```tsx
<CopyBox label="Router script" value={setup.script} multiline />
```

### CalendarMonth

Presentational month grid; the screen owns the month, marks and selection (dates are strings in the
location's calendar, matching `RecordingDaysQuery.month` and `RecordingDay.date`).

| Prop | Type | |
|---|---|---|
| `month` | string | "YYYY-MM" |
| `selected?` | string \| null | "YYYY-MM-DD" |
| `marked?` | string[] | Days with recordings, each gets an amber mark |
| `today?` | string | "YYYY-MM-DD" in the location timezone, thin ring |
| `min?`, `max?` | string | Days outside cannot be chosen |
| `onSelect` | `(day: string) => void` | |
| `onPrev`, `onNext` | `() => void` | |
| `prevDisabled?`, `nextDisabled?` | boolean | |
| `weekStartsOn?` | 0 \| 1 \| 6 [0] | |
| `locale?` | string | Month and weekday names |
| `loading?` | boolean | Dims the grid |
| `label?`, `markedLabel?` ["has recordings"] | string | |

```tsx
<CalendarMonth
  month={month}
  selected={day}
  marked={days.map((d) => d.date)}
  today={todayInZone}
  max={todayInZone}
  onSelect={setDay}
  onPrev={() => setMonth(shiftMonth(month, -1))}
  onNext={() => setMonth(shiftMonth(month, 1))}
  nextDisabled={month >= todayInZone.slice(0, 7)}
  loading={loadingDays}
/>
```

### TimelineTrack

Presentational 24 hour track with recorded blocks, hour ticks, hour labels (every 3 h, every 6 h below
640 px) and a cream playback cursor. Times are unix milliseconds.

| Prop | Type | |
|---|---|---|
| `dayStart` | number | First instant of the day in the location timezone |
| `dayEnd?` | number [dayStart + 24 h] | Pass it on daylight-saving days |
| `blocks` | `{ start, end, tone?: 'default' \| 'muted' }[]` | Clipped to the day, touching blocks merged |
| `cursor?` | number \| null | Playback position |
| `timeZone?`, `locale?` | string | Hour labels |
| `onPick` | `(time: number) => void` | Click position, or new position after a key press |
| `label` | string | Accessible name ("Front door, 12 November") |
| `disabled?` | boolean | |

Keyboard (it is a slider): arrows move 1 minute (Shift 10), Page Up/Down 1 hour, Home/End the day's ends.

```tsx
<TimelineTrack
  label={`${cameraName}, ${dayLabel}`}
  dayStart={dayStart}
  dayEnd={dayEnd}
  timeZone={location.timezone}
  blocks={recordings.map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end) }))}
  cursor={playhead}
  onPick={seekTo}
/>
```

### Helpers

- `cx(...classes)` joins class names.
- `NavigationContext`, `useNavigate()`, `useLinkClick(href, onClick?)`, `isRouterClick(event, href)` for
  router-aware links in screen code.
- `FieldContext`, `useField()` for a custom control placed inside FormField.
- `registerServiceWorker()`.

## 5. App shell files

- `dashboard/index.html`: title "Comffee CCTV", theme colour #0a0807, manifest, icons, font preloads, no
  inline script; it loads `/src/main.tsx`.
- `dashboard/public/manifest.webmanifest`: name "Comffee CCTV", short name "CCTV", start `/live`,
  standalone, icons in `public/icons` (the amber dome-camera mark on espresso; SVG, 192 and 512 PNG,
  maskable 512, apple touch 180, favicon 32).
- `dashboard/public/sw.js`: caches only the app shell (the page, `/assets/*`, fonts, icons, manifest).
  It never touches `/api`, `/live/...`, `/bridge` or anything else, so recordings, streams and API answers
  are never stored. Page loads are network first with the cached page as the offline fallback; built
  assets are cache first, trimmed to 80 entries. The hub should serve `/sw.js` with
  `Cache-Control: no-cache`.
