# karaoke4phun

Party karaoke with a TV, everyone's phones, and YouTube's karaoke videos.

- **TV screen** (`/host`) plays the queue in YouTube's embedded player, shows who's singing and who's next, and puts a QR code on screen for joining.
- **Phones** scan the QR code, pick a name, search YouTube (or paste a link), and queue songs. Anyone can pause, restart, or skip.
- **Fair rotation**: everyone gets one song per round, however many they queue. People who join mid-round go to the back of that round.

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
| F | Fullscreen |

## How it fits together

```
server/index.js    Express + Socket.IO: rooms, search API, QR codes
server/room.js     Queue and fair singer rotation (unit-tested)
server/youtube.js  YouTube search with on-disk cache; link parsing; oEmbed lookup
public/host.*      TV screen with the YouTube IFrame player
public/remote.*    Phone remote
```

Parties live in memory. If the server restarts, the TV gets the same party code back and phones reconnect, but the queue starts empty.

## Known limits

- Some videos can't be embedded or are blocked in your country. The TV announces it and skips to the next song.
- YouTube may show ads between or during videos.
- No key change or vocal removal, because the YouTube player doesn't expose its audio.
