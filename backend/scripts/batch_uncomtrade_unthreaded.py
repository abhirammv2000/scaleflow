import os
import json
import time
import requests
import pandas as pd
from datetime import datetime
from itertools import product
import random
import string

# === CONFIGURATION ===
API_KEY_FILE = "/opt/airflow/config/uncomtrade-api-key.json"
OUTPUT_FOLDER = "/opt/airflow/uncomtrade_data_unthreaded"
MAX_CALLS_PER_DAY = 500
MIN_ROW_THRESHOLD = 90000

# === SETUP ===
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# Load API key from JSON config
def load_api_key(path=API_KEY_FILE, use_secondary=False):
    with open(path) as f:
        secrets = json.load(f)
    return secrets["comtrade"]["secondary_key"] if use_secondary else secrets["comtrade"]["primary_key"]

# Generate unique filename
def generate_filename(prefix="comtrade", ext="csv"):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{prefix}_{ts}_{suffix}.{ext}"

# Fetch trade data
def get_trade_data(params, api_key):
    url = "https://comtradeapi.un.org/data/v1/get/C/M/HS"
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    response = requests.get(url, params=params, headers=headers)

    if response.status_code == 200:
        return response.json()
    else:
        raise Exception(f"API Error: {response.status_code} - {response.text}")

# === HIGH-IMPACT QUERY STRATEGY ===
top_reporters = ["156", "840", "276", "392", "826", "250", "484", "410", "643", "356", "380", "124", "528", "76", "724", "360", "682", "756", "792"]  # Top trading countries
periods = ["202309", "202310", "202311", "202312"]  # Chunk of months
# flow_codes = ["M", "X"]  # M: export, X: import

# Start batch pull
start_time = time.time()
api_key = load_api_key()
results = []
calls_made = 0

for reporter, period in product(top_reporters, periods):
    if calls_made >= MAX_CALLS_PER_DAY:
        print("Daily call limit reached.")
        break

    params = {
        "reporterCode": reporter,
        "period": period,
        "partnerCode": "0",
        # "flowCode": flow,
        "customsCode": "C00",
        "motCode": "0"
    }

    try:
        data = get_trade_data(params, api_key)
        row_count = len(data.get("data", []))

        truncated = row_count >= 100000
        low_volume = row_count < MIN_ROW_THRESHOLD

        results.append({
            "reporterCode": reporter,
            "period": period,
            "rowCount": row_count,
            "truncated": truncated,
            "lowVolume": low_volume
        })

        if "data" in data and isinstance(data["data"], list) and row_count > 0:
            df = pd.json_normalize(data["data"])
            csv_filename = generate_filename()
            df.to_csv(os.path.join(OUTPUT_FOLDER, csv_filename), index=False)

            status = "TRUNCATED" if truncated else "OK"
            volume_flag = "(Low Volume)" if low_volume else ""
            print(f"{status} {reporter}-{period} -> {row_count} rows {volume_flag} -> Saved: {csv_filename}")
        else:
            print(f"No data found for {reporter}-{period}.")

        calls_made += 1
        time.sleep(4)  # Throttle to ~15 calls/min

    except Exception as e:
        print(f"Error for {reporter}-{period}: {e}")

end_time = time.time()
print(f"Time taken for extracting data without threading: {end_time - start_time:.2f} seconds")

# Save summary
summary_df = pd.DataFrame(results)
summary_df.to_csv(os.path.join(OUTPUT_FOLDER, "summary.csv"), index=False)
print(f"\n Summary saved. Total successful high-volume calls: {calls_made}")