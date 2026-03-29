import time
import sys
import random
from instagrapi import Client


def make_client() -> Client:
    """Create a Client configured with delays to avoid 429s."""
    cl = Client()
    cl.delay_range = [3, 6]  # random delay (seconds) between every private API request
    return cl


def fetch_following(client: Client, target_username: str) -> list[dict]:
    """Return list of {user_id, username} dicts for everyone the target follows."""
    user_info = call_with_retry(lambda: client.user_info_by_username_v1(target_username))
    following = call_with_retry(lambda: client.user_following(user_info.pk))
    return [{"user_id": u.pk, "username": u.username} for u in following.values()]


def enforce_rate_limit(max_actions_per_window: int, window_seconds: int, actions_this_window: int, window_start: float) -> tuple[int, float]:
    """Ensure we do not exceed the allowed actions per time window."""
    now = time.time()
    if now - window_start >= window_seconds:
        return 0, now
    if actions_this_window >= max_actions_per_window:
        sleep_for = window_seconds - (now - window_start)
        if sleep_for > 0:
            print(f"Rate limit hit; sleeping {sleep_for:.1f}s...")
            time.sleep(sleep_for)
        return 0, time.time()
    return actions_this_window, window_start


def is_rate_limited_error(exc: Exception) -> bool:
    text = str(exc).lower()
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status == 429 or "429" in text or "please wait a few minutes" in text


def call_with_retry(fn, max_retries: int = 4, base_sleep: float = 60.0):
    delay = base_sleep
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as exc:
            if is_rate_limited_error(exc) and attempt < max_retries - 1:
                jitter = random.uniform(0, 5)
                sleep_for = delay + jitter
                print(f"Rate limited; sleeping {sleep_for:.1f}s before retry...")
                time.sleep(sleep_for)
                delay *= 2
                continue
            raise


def block_with_retry(client: Client, user_id: int, max_retries: int = 4, base_sleep: float = 60.0) -> None:
    delay = base_sleep
    for attempt in range(max_retries):
        try:
            client.user_block(user_id)
            return
        except Exception as exc:
            if is_rate_limited_error(exc) and attempt < max_retries - 1:
                print(f"Rate limited; sleeping {delay:.1f}s before retry...")
                time.sleep(delay)
                delay *= 2
                continue
            raise


def main():
    if len(sys.argv) not in (1, 2):
        print("Usage: python blockerino.py [per_minute_limit]")
        sys.exit(1)

    login_user, login_pass, target_username = 'user', 'pass', sys.argv[1]
    per_minute_limit = int(sys.argv[2]) if len(sys.argv) == 3 else 6

    cl = make_client()
    cl.login(login_user, login_pass)

    try:
        users = fetch_following(cl, target_username)
    except Exception as exc:
        print(f"Failed to fetch following list for {target_username}: {exc}")
        sys.exit(1)

    if not users:
        print(f"No accounts found in {target_username}'s following list.")
        sys.exit(0)

    # Exclude profiles we already follow
    my_following = call_with_retry(lambda: cl.user_following(cl.user_id))
    my_following_ids = {u.pk for u in my_following.values()}
    before = len(users)
    users = [u for u in users if u["user_id"] not in my_following_ids]
    skipped = before - len(users)
    print(f"Found {before} accounts; skipping {skipped} you already follow. Blocking {len(users)}.")

    success, failed = [], []
    actions_this_window, window_start = 0, time.time()
    for i, entry in enumerate(users, 1):
        actions_this_window, window_start = enforce_rate_limit(per_minute_limit, 60, actions_this_window, window_start)
        username = entry["username"]
        try:
            block_with_retry(cl, entry["user_id"])
            success.append(username)
            print(f"[{i}/{len(users)}] Blocked {username}")
            actions_this_window += 1
            time.sleep(2.0 + random.uniform(0, 3))
        except Exception as exc:
            failed.append((username, str(exc)))
            print(f"[{i}/{len(users)}] Failed {username}: {exc}")

    print(f"\nDone. Blocked {len(success)}; Failed {len(failed)}")
    if failed:
        print("Failures:")
        for u, err in failed:
            print(f"- {u}: {err}")

    # Block the target profile itself
    try:
        target_info = call_with_retry(lambda: cl.user_info_by_username_v1(target_username))
        block_with_retry(cl, target_info.pk)
        print(f"Blocked target profile: {target_username}")
    except Exception as exc:
        print(f"Failed to block target profile {target_username}: {exc}")


if __name__ == "__main__":
    main()