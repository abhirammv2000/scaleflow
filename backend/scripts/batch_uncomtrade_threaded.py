import os
import json
import time
import requests
import pandas as pd
from datetime import datetime
from itertools import product
import random
import string
from sqlalchemy import create_engine
import psycopg2
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from time import time as now

# === CONFIGURATION ===
API_KEY_FILE = "/opt/airflow/config/uncomtrade-api-key.json"
OUTPUT_FOLDER = "/opt/airflow/uncomtrade_data_threaded"
MAX_CALLS_PER_DAY = 500
MIN_ROW_THRESHOLD = 90000
THREAD_WORKERS = 15

# === SETUP ===
results = []
lock = Lock()
rate_lock = Lock()
next_call_time = now()
calls_made = 0

# Load API key
def load_api_key(path=API_KEY_FILE, use_secondary=False):
    with open(path) as f:
        secrets = json.load(f)
    return secrets["comtrade"]["secondary_key"] if use_secondary else secrets["comtrade"]["primary_key"]

# Generate filename
def generate_filename(reporter, period, ext="csv"):
    return f"comtrade_{reporter}_{period}.{ext}"

# API request
def get_trade_data(params, api_key):
    global next_call_time
    url = "https://comtradeapi.un.org/data/v1/get/C/M/HS"
    headers = {"Ocp-Apim-Subscription-Key": api_key}

    with rate_lock:
        wait_time = max(0, next_call_time - now())
        if wait_time > 0:
            time.sleep(wait_time)
        next_call_time = now() + 4

    response = requests.get(url, params=params, headers=headers)
    if 'X-RateLimit-Remaining' in response.headers:
        print(f"API Calls Left Today: {response.headers['X-RateLimit-Remaining']}")

    if response.status_code == 200:
        return response.json()
    elif response.status_code == 429:
        raise Exception("Rate limit exceeded (429)")
    else:
        raise Exception(f"API Error: {response.status_code} - {response.text}")

# Hardcoded top 100 reporters list
TOP_100_REPORTERS = [
    "156", "840", "276", "392", "826", "250", "484", "410", "643", "356",
    "124", "724", "528", "191", "036", "756", "076", "203", "578", "702",
    "344", "616", "620", "752", "554", "608", "348", "417", "566", "887",
    "792", "470", "364", "196", "807", "818", "422", "320", "458", "764",
    "704", "586", "682", "504", "788", "352", "360", "051", "498", "784",
    "414", "275", "710", "376", "728", "380", "710", "643", "586", "250",
    "276", "528", "156", "392", "840", "410", "826", "124", "643", "344",
    "826", "840", "250", "356", "392", "156", "554", "703", "620", "608",
    "724", "484", "608", "276", "840", "250", "410", "643", "356", "036",
    "276", "752", "554", "643", "124", "826", "380", "392", "156", "410"
]

# Worker function
def process_trade_query(reporter, period, api_key, retry_count=0):
    global calls_made
    if retry_count > 2 or calls_made >= MAX_CALLS_PER_DAY:
        return

    params = {
        "reporterCode": reporter,
        "period": period,
        "partnerCode": "0",
        "customsCode": "C00",
        "motCode": "0"
    }

    try:
        data = get_trade_data(params, api_key)
        row_count = len(data.get("data", []))
        truncated = row_count >= 100000
        low_volume = row_count < MIN_ROW_THRESHOLD

        with lock:
            results.append({
                "reporterCode": reporter,
                "period": period,
                "rowCount": row_count,
                "truncated": truncated,
                "lowVolume": low_volume
            })

        if row_count > 0:
            df = pd.json_normalize(data["data"])
            filename = generate_filename(reporter, period)
            df.to_csv(os.path.join(OUTPUT_FOLDER, filename), index=False)

            status = "TRUNCATED" if truncated else "OK"
            volume_flag = "(Low Volume)" if low_volume else ""
            print(f"{status} {reporter}-{period} -> {row_count} rows {volume_flag} -> Saved: {filename}")
        else:
            print(f"No data for {reporter}-{period}.")

        with lock:
            calls_made += 1

    except Exception as e:
        if "429" in str(e):
            print(f"Rate limited for {reporter}-{period}. Retrying in 5s...")
            time.sleep(5)
            return process_trade_query(reporter, period, api_key, retry_count + 1)
        else:
            print(f"Error for {reporter}-{period}: {e}")

# Main function
def main():
    start_time = time.time()
    global calls_made
    api_key = load_api_key()

    # Make sure output folder exists
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    # Use hardcoded top 100 reporter list
    top_reporter_ids = TOP_100_REPORTERS

    periods = ["202309", "202310", "202311", "202312"]
    tasks = list(product(top_reporter_ids, periods))

    print(f"\n Starting threaded extraction for {len(tasks)} tasks...")

    with ThreadPoolExecutor(max_workers=THREAD_WORKERS) as executor:
        futures = [executor.submit(process_trade_query, r, p, api_key) for r, p in tasks]
        for future in as_completed(futures):
            pass

    summary_df = pd.DataFrame(results)
    summary_df.to_csv(os.path.join(OUTPUT_FOLDER, "summary.csv"), index=False)
    print(f"\n Summary saved. Total successful API calls: {calls_made}")

    end_time = time.time()
    print(f"\n Time taken for extracting data threading with {THREAD_WORKERS} workers: {end_time - start_time:.2f} seconds")

if __name__ == "__main__":
    main()