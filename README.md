# Blockerino

A CLI tool that mass-blocks every account a given Instagram profile follows, then blocks the profile itself.

## Features

- Fetches the full following list of a target profile
- Skips accounts you already follow
- Blocks each account with built-in rate limiting and exponential backoff
- Blocks the target profile itself when finished
- Configurable per-minute action limit

## Requirements

- Python 3.10+
- [instagrapi](https://github.com/subzeroid/instagrapi)

## Installation

```bash
pip install instagrapi
```

## Usage

```bash
python blockerino.py <target_username> [per_minute_limit]
```

| Argument            | Required | Default | Description                                  |
|---------------------|----------|---------|----------------------------------------------|
| `target_username`   | Yes      | —       | Instagram username whose followers to block  |
| `per_minute_limit`  | No       | 6       | Max block actions per minute                 |

### Examples

```bash
# Block everyone that @somepage follows (default 6/min)
python blockerino.py somepage

# Same but with a tighter limit of 4 actions per minute
python blockerino.py somepage 4
```

## How It Works

1. Logs into Instagram using hardcoded credentials (edit `main()` to change them).
2. Fetches the target profile's full following list via the private/mobile API.
3. Fetches your own following list and excludes any overlap.
4. Blocks each remaining account one by one with:
   - A per-minute rate limiter (default 6/min).
   - 2–5 seconds of jittered delay between each action.
   - Exponential backoff (60s base, doubling) on 429 / rate-limit errors.
5. After all followers are processed, blocks the target profile itself.

## Rate Limiting

The script uses multiple layers to avoid Instagram's rate limits:

- **Client-level delay**: 3–6 second random pause between every API request.
- **Per-minute cap**: Configurable via CLI argument (default 6).
- **Retry with backoff**: On 429 errors, waits 60s → 120s → 240s before retrying (up to 4 attempts).

If you still see rate-limit errors, lower the per-minute limit or increase the `base_sleep` values in `call_with_retry` / `block_with_retry`.

## Running Tests

```bash
pip install pytest
python -m pytest test_blockerino.py -v
```

## Disclaimer

Automating actions on Instagram may violate their [Terms of Use](https://help.instagram.com/581066165581870). Use at your own risk. Consider using a non-primary account to avoid restrictions.
