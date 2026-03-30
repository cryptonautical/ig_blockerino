# Blockerino

Mass-block every account a target Instagram profile follows, then block the profile itself. Available as a **Chrome extension** or a **Python CLI tool**.

---

## Chrome Extension (recommended)

A Manifest V3 Chrome extension that talks directly to Instagram's private mobile API — same protocol as `instagrapi`. All requests come from **your browser**, no server needed.

### Install

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

### Usage

1. Click the Blockerino extension icon
2. Log in with your Instagram credentials
3. Type a target username and click **Add to Queue**
4. Watch real-time progress — add more targets any time

### Features

- **Client-side requests** — all API calls originate from your IP, not a server
- **Live queue** — add/remove targets while blocking is in progress
- **Persistent queue** — survives browser restarts via `chrome.storage`
- **Rate limiting** — 6 blocks/min cap with exponential backoff on 429s
- **Auto re-login** — handles session expiry transparently

---

## Python CLI

Requires Python 3.10+ and the `instagrapi` library.

### Install

```bash
pip install -r requirements.txt
```

### Usage

```bash
python blockerino.py <target_username> [per_minute_limit]
```

| Argument            | Required | Default | Description                                  |
|---------------------|----------|---------|----------------------------------------------|
| `target_username`   | Yes      | —       | Instagram username whose followers to block  |
| `per_minute_limit`  | No       | 6       | Max block actions per minute                 |

---

## How It Works

1. Fetches the target profile's full following list.
2. Excludes any accounts you already follow.
3. Blocks each remaining account with rate limiting and exponential backoff.
4. Blocks the target profile itself.

## Disclaimer

Automating actions on Instagram may violate their [Terms of Use](https://help.instagram.com/581066165581870). Use at your own risk.
