# karaoke4phun

Party karaoke with a TV, everyone's phones, and YouTube's karaoke videos.

- **TV screen** (`/host`) plays the queue in YouTube's embedded player, shows who's singing and who's next, and puts a QR code on screen for joining.
- **Phones** scan the QR code, pick a name, search YouTube (or paste a link), preview a video on their own phone, and queue songs. They can swap their own song for a better version or remove it. Anyone can pause, restart, or skip.
- **Fair rotation**: everyone gets one song per round, however many they queue. People who join mid-round go to the back of that round.
- **Host phone**: scan the *host* QR code (on the TV's start screen, or press **H**) to get host tools:
  - reorder the queue (up, down, play next) and remove or swap anyone's song. Reordering switches to a custom order where new songs go to the end, until you switch back to fair rotation
  - add songs for anyone, including people without a phone
  - see how many songs each singer has sung and queued
  - show or hide the TV's queue sidebar
- **Audience screen** (`/a/CODE`, link under **H** on the TV): for a second TV. It mirrors the main TV's video in sync (muted, since the main TV has the sound) with a ticker of who's singing and the next three singers.

## Run it

Needs Node 20.6 or newer.

```bash
npm install
```

```bash
npm start
```

Open `http://localhost:3000/host` on the computer connected to the TV, click **Start the party**, and press **F** for fullscreen. Phones on the same Wi-Fi scan the QR code.

`npm run dev` restarts on file changes. `npm test` runs the tests.

## Turn on search (optional, recommended)

Without a key, people can still add songs by pasting a YouTube link (YouTube app → Share → Copy link).

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. Under **Credentials**, create an API key. Restrict it to the YouTube Data API v3.
3. `cp .env.example .env` and set `YOUTUBE_API_KEY`.

The free quota is 10,000 units a day and a search costs about 101, so roughly 100 searches a day. Results are cached for a week in `data/search-cache.json`, so repeat searches are free. "Karaoke versions only" adds "karaoke" to the search.

## TV shortcuts

| Key | Action |
|---|---|
| Space | Pause / play |
| N or → | Skip |
| S | Show / hide the queue sidebar |
| H | Show the host and audience-screen QR codes |
| F | Fullscreen (also works on the audience screen) |

## How it fits together

```
server/index.js    Express + Socket.IO: rooms, search API, QR codes
server/room.js     Queue and fair singer rotation (unit-tested)
server/youtube.js  YouTube search with on-disk cache; link parsing; oEmbed lookup
public/host.*      TV screen with the YouTube IFrame player
public/remote.*    Phone remote (host tools when opened from the host QR code)
public/audience.*  Audience screen, synced to the TV's playback reports
```

The host link carries a secret key (`#host=…`). The phone remembers it and removes it from the address bar. Anyone with that link has host powers, so don't share the host QR code.

Parties live in memory. If the server restarts, the TV gets the same party code back and phones reconnect, but the queue starts empty.

## Known limits

- Some videos can't be embedded or are blocked in your country. The TV announces it and skips to the next song.
- YouTube may show ads between or during videos.
- No key change or vocal removal, because the YouTube player doesn't expose its audio.
