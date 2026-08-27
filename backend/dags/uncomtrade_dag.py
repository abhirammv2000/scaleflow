# comtrade_full_extraction_dag.py
from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime
import os
import pandas as pd
from sqlalchemy import create_engine
import psycopg2
import json
import requests
import time
from itertools import product
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from time import time as now

# === CONFIGURATION ===
API_KEY_FILE = "/opt/airflow/config/uncomtrade-api-key.json"
OUTPUT_FOLDER = "/opt/airflow/uncomtrade_data_threaded"
POSTGRES_USER = "airflow"
POSTGRES_PASSWORD = "airflow"
POSTGRES_HOST = "postgres"
POSTGRES_PORT = "5432"
POSTGRES_DB = "airflow"
POSTGRES_TABLE = "comtrade_cleaned_data"
MAX_CALLS_PER_DAY = 500
MIN_ROW_THRESHOLD = 90000
THREAD_WORKERS = 5

# === THREADING SETUP ===
results = []
lock = Lock()
rate_lock = Lock()
next_call_time = now()
calls_made = 0

# === EXTRACTION FUNCTIONS ===

def load_api_key(path=API_KEY_FILE, use_secondary=False):
    with open(path) as f:
        secrets = json.load(f)
    return secrets["comtrade"]["secondary_key"] if use_secondary else secrets["comtrade"]["primary_key"]

def generate_filename(reporter, period, ext="csv"):
    return f"comtrade_{reporter}_{period}.{ext}"

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

def run_threaded_extraction():
    start_time = time.time()
    global calls_made
    api_key = load_api_key()

    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    # Reduced top reporters if needed, or keep same list
    top_reporter_ids = [
        "156", "840", "276", "392", "826", "250", "484", "410", "643", "356",
        "124", "724", "528", "191", "036", "756", "076", "203", "578", "702",
        "344", "616", "620", "752", "554", "608", "348", "417", "566", "887",
        "792", "470", "364", "196", "807", "818", "422", "320", "458", "764",
        "704", "586", "682", "504", "788", "352", "360", "051", "498", "784"
    ]

    periods = ["202309", "202310", "202311", "202312"]
    tasks = list(product(top_reporter_ids, periods))

    print(f"\nStarting threaded extraction for {len(tasks)} tasks with {THREAD_WORKERS} workers...")

    # REDUCED number of threads for stability
    with ThreadPoolExecutor(max_workers=THREAD_WORKERS) as executor:
        futures = []
        for r, p in tasks:
            futures.append(executor.submit(process_trade_query, r, p, api_key))
            time.sleep(0.5)  # Soft throttle between thread launches

        for future in as_completed(futures):
            pass  # Threads finish and synchronize here

    # Save the final extraction summary
    summary_df = pd.DataFrame(results)
    summary_df.to_csv(os.path.join(OUTPUT_FOLDER, "summary.csv"), index=False)
    print(f"\nSummary saved. Total successful API calls: {calls_made}")

    end_time = time.time()
    print(f"\nTime taken for extraction: {end_time - start_time:.2f} seconds")

# === POST EXTRACTION FUNCTIONS ===

def merge_extracted_csvs():
    files = [os.path.join(OUTPUT_FOLDER, f) for f in os.listdir(OUTPUT_FOLDER)
             if f.endswith(".csv") and not f.startswith("summary")]
    if not files:
        raise Exception("No CSV files found to merge!")

    merged_file_path = os.path.join(OUTPUT_FOLDER, "merged_data.csv")
    first = True
    for file in files:
        for chunk in pd.read_csv(file, chunksize=100000):
            if first:
                chunk.to_csv(merged_file_path, index=False, mode="w")
                first = False
            else:
                chunk.to_csv(merged_file_path, index=False, mode="a", header=False)
    print(f"Merged {len(files)} files into merged_data.csv")


def clean_merged_data():
    merged_path = os.path.join(OUTPUT_FOLDER, "merged_data.csv")
    if not os.path.exists(merged_path):
        raise Exception("Merged file not found!")

    cleaned_path = os.path.join(OUTPUT_FOLDER, "cleaned_data.csv")
    columns_to_be_dropped = [
        "typeCode", "freqCode", "refPeriodId", "refYear", "refMonth",
        "partnerCode", "partner2Code", "cmdCode", "classificationCode",
        "classificationSearchCode", "isOriginalClassification", "customsCode",
        "mosCode", "motCode", "isAltQtyEstimated", "isGrossWgtEstimated",
        "isReported", "isAggregate"
    ]
    categorical_columns = ['flowCode', 'isQtyEstimated', 'isNetWgtEstimated']

    # Remove existing cleaned file if it exists
    if os.path.exists(cleaned_path):
        os.remove(cleaned_path)

    chunksize = 50_000  # Safe size: 100k rows per chunk

    for i, chunk in enumerate(pd.read_csv(merged_path, chunksize=chunksize)):

        # STEP 1: Drop all-NA columns and rows
        chunk.dropna(axis=1, how='all', inplace=True)
        chunk.dropna(inplace=True)

        # STEP 2: Drop unnecessary columns (only if present)
        chunk.drop(columns=[col for col in columns_to_be_dropped if col in chunk.columns], inplace=True, errors='ignore')

        # STEP 3: Encode categorical columns
        for col in categorical_columns:
            if col in chunk.columns:
                chunk[col] = chunk[col].astype('category')
                chunk[col] = chunk[col].cat.codes

        # STEP 4: Transform 'period' into YYYY-MM
        if 'period' in chunk.columns:
            chunk['period'] = chunk['period'].astype(str)
            chunk['period'] = pd.to_datetime(chunk['period'], format='%Y%m', errors='coerce').dt.strftime('%Y-%m')

        # STEP 5: Append cleaned chunk to output CSV
        chunk.to_csv(cleaned_path, mode='a', header=(i == 0), index=False)

        print(f"Processed chunk {i+1}")

    print(f"\nAll chunks processed successfully. Final cleaned file: {cleaned_path}")


def upload_cleaned_to_postgres():
    cleaned_path = os.path.join(OUTPUT_FOLDER, "cleaned_data.csv")
    if not os.path.exists(cleaned_path):
        raise Exception("Cleaned data file not found!")

    engine_url = f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    engine = create_engine(engine_url)

    batch_size = 5000
    with pd.read_csv(cleaned_path, chunksize=batch_size) as reader:
        for idx, chunk in enumerate(reader):
            chunk.to_sql(
                name=POSTGRES_TABLE,
                con=engine,
                if_exists="append" if idx > 0 else "replace",
                index=False
            )
            print(f"Inserted batch {idx+1} into {POSTGRES_TABLE}")
    print(f"Upload complete to PostgreSQL table: {POSTGRES_TABLE}")

# === DAG DEFINITION ===
default_args = {
    "owner": "shreyash",
    "start_date": datetime(2024, 4, 4),
    "retries": 1
}

with DAG("comtrade_full_etl_pipeline",
         schedule_interval=None,
         default_args=default_args,
         catchup=False,
         description="End-to-End ETL for Comtrade Data: Extraction, Merge, Clean, Load") as dag:

    extraction_task = PythonOperator(
        task_id="run_threaded_extraction",
        python_callable=run_threaded_extraction
    )

    merge_task = PythonOperator(
        task_id="merge_extracted_csvs",
        python_callable=merge_extracted_csvs
    )

    clean_task = PythonOperator(
        task_id="clean_merged_data",
        python_callable=clean_merged_data
    )

    upload_task = PythonOperator(
        task_id="upload_cleaned_to_postgres",
        python_callable=upload_cleaned_to_postgres
    )

    extraction_task >> merge_task >> clean_task >> upload_task