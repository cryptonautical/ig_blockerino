"""Tests for blockerino retry and rate-limit logic (no live API calls)."""
import time
from unittest.mock import MagicMock, patch
import pytest
from requests.exceptions import RetryError

from blockerino import (
    call_with_retry,
    block_with_retry,
    enforce_rate_limit,
    is_rate_limited_error,
    fetch_following,
    make_client,
)


# --- is_rate_limited_error ---

def test_detects_429_in_message():
    exc = Exception("too many 429 error responses")
    assert is_rate_limited_error(exc) is True


def test_detects_429_status_code():
    exc = Exception("error")
    resp = MagicMock()
    resp.status_code = 429
    exc.response = resp
    assert is_rate_limited_error(exc) is True


def test_detects_please_wait():
    exc = Exception("Please wait a few minutes before you try again.")
    assert is_rate_limited_error(exc) is True


def test_non_rate_limit_error():
    exc = Exception("user not found")
    assert is_rate_limited_error(exc) is False


# --- call_with_retry ---

@patch("blockerino.time.sleep", return_value=None)
def test_call_with_retry_succeeds_first_try(mock_sleep):
    fn = MagicMock(return_value="ok")
    result = call_with_retry(fn, max_retries=3, base_sleep=1.0)
    assert result == "ok"
    fn.assert_called_once()
    mock_sleep.assert_not_called()


@patch("blockerino.time.sleep", return_value=None)
def test_call_with_retry_retries_on_429(mock_sleep):
    fn = MagicMock(side_effect=[Exception("429 error"), "ok"])
    result = call_with_retry(fn, max_retries=3, base_sleep=1.0)
    assert result == "ok"
    assert fn.call_count == 2
    assert mock_sleep.call_count == 1


@patch("blockerino.time.sleep", return_value=None)
def test_call_with_retry_raises_after_max_retries(mock_sleep):
    fn = MagicMock(side_effect=Exception("429 error"))
    with pytest.raises(Exception, match="429"):
        call_with_retry(fn, max_retries=3, base_sleep=1.0)
    assert fn.call_count == 3


@patch("blockerino.time.sleep", return_value=None)
def test_call_with_retry_raises_non_429_immediately(mock_sleep):
    fn = MagicMock(side_effect=ValueError("bad input"))
    with pytest.raises(ValueError, match="bad input"):
        call_with_retry(fn, max_retries=3, base_sleep=1.0)
    fn.assert_called_once()
    mock_sleep.assert_not_called()


# --- block_with_retry ---

@patch("blockerino.time.sleep", return_value=None)
def test_block_with_retry_succeeds(mock_sleep):
    client = MagicMock()
    client.user_block.return_value = True
    block_with_retry(client, 12345, max_retries=3, base_sleep=1.0)
    client.user_block.assert_called_once_with(12345)


@patch("blockerino.time.sleep", return_value=None)
def test_block_with_retry_retries_on_rate_limit(mock_sleep):
    client = MagicMock()
    client.user_block.side_effect = [Exception("429 too many requests"), True]
    block_with_retry(client, 12345, max_retries=3, base_sleep=1.0)
    assert client.user_block.call_count == 2


# --- enforce_rate_limit ---

def test_enforce_rate_limit_resets_after_window():
    start = time.time() - 61  # window already expired
    actions, new_start = enforce_rate_limit(5, 60, 5, start)
    assert actions == 0
    assert new_start >= time.time() - 1


@patch("blockerino.time.sleep", return_value=None)
def test_enforce_rate_limit_sleeps_when_full(mock_sleep):
    start = time.time() - 10  # 10s into a 60s window
    actions, new_start = enforce_rate_limit(5, 60, 5, start)
    assert actions == 0
    assert mock_sleep.call_count == 1


def test_enforce_rate_limit_passes_when_under():
    start = time.time()
    actions, new_start = enforce_rate_limit(5, 60, 2, start)
    assert actions == 2
    assert new_start == start


# --- fetch_following (mocked) ---

@patch("blockerino.call_with_retry")
def test_fetch_following_returns_user_list(mock_retry):
    client = MagicMock()
    user_info = MagicMock()
    user_info.pk = 111

    follower1 = MagicMock()
    follower1.pk = 222
    follower1.username = "alice"
    follower2 = MagicMock()
    follower2.pk = 333
    follower2.username = "bob"

    mock_retry.side_effect = [user_info, {222: follower1, 333: follower2}]
    result = fetch_following(client, "target")
    assert len(result) == 2
    assert result[0] == {"user_id": 222, "username": "alice"}
    assert result[1] == {"user_id": 333, "username": "bob"}


# --- make_client ---

def test_make_client_has_delay_range():
    cl = make_client()
    assert cl.delay_range == [3, 6]
