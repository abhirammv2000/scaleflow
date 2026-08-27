import yfinance as yf
import pandas as pd
import os
import time
import random
import psutil
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import glob
from sqlalchemy import create_engine

from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime, timedelta
from airflow.models import Variable

def fetch_stock_data_threaded_combined(ticker_csv, output_folder, start_year=2000, end_year=2024,
                                       batch_size=50, threads=20, retry_limit=3, retry_delay=5, batch_pause=15, ticker_limit=None):
    tickers_df = pd.read_csv(ticker_csv)
    tickers = tickers_df['ticker'].dropna().unique().tolist()

    if ticker_limit:
        random.shuffle(tickers)
        tickers = tickers[:ticker_limit]

    DEFAULT_START = datetime(start_year, 1, 1)
    END_DATE = datetime(end_year, 12, 31)

    os.makedirs(output_folder, exist_ok=True)
    combined_data = []
    results = []

    def fetch_stock_data(ticker):
        try:
            stock = yf.Ticker(ticker)
            info = stock.info

            founded_year = info.get("founded") or info.get("startDate") or info.get("yearFounded")
            if isinstance(founded_year, int) and founded_year >= start_year:
                start_date = datetime(founded_year, 1, 1)
            else:
                start_date = DEFAULT_START

            hist = stock.history(start=start_date, end=END_DATE)
            time.sleep(random.uniform(1.5, 3.5))

            if hist.empty:
                return None, f"[SKIPPED] {ticker}: No data."

            hist.reset_index(inplace=True)
            hist['ticker'] = ticker
            return hist, f"[SUCCESS] {ticker} from {start_date.year} to {END_DATE.year}"

        except Exception as e:
            if "Rate limit" in str(e) or "Too Many Requests" in str(e):
                return None, f"[RETRY] {ticker}: Rate limited. {e}"
            return None, f"[FAILED] {ticker}: {e}"

    def fetch_with_retries(ticker):
        for attempt in range(retry_limit):
            data, log = fetch_stock_data(ticker)
            if not log.startswith("[RETRY]"):
                return data, log
            time.sleep(retry_delay * (attempt + 1))
        return None, f"[FAILED] {ticker} after {retry_limit} retries"

    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i + batch_size]
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = {executor.submit(fetch_with_retries, ticker): ticker for ticker in batch}
            for future in as_completed(futures):
                data, log = future.result()
                ticker = futures[future]
                results.append(log)
                if data is not None:
                    filename = os.path.join(output_folder, f"{ticker}.csv")
                    data.to_csv(filename, index=False)
        time.sleep(batch_pause)

    # Log all results
    with open(os.path.join(output_folder, "fetch_log.txt"), "w") as f:
        f.write("\n".join(results))

    return "Data fetched and saved per ticker. Ready for merging."

# === CONFIGURATION ===
def get_mode_config():
    """Fetch mode from Airflow Variables and return config."""
    mode = Variable.get("stress_test_mode", default_var="super_light").lower()

    config = {
        "super_light": {"ticker_limit": 250, "threads": 5},
        "light": {"ticker_limit": 500, "threads": 10},
        "slightly_heavy": {"ticker_limit": 1000, "threads": 20},
        "heavy": {"ticker_limit": 3000, "threads": 40}
    }

    return config.get(mode, config["super_light"])


def dynamic_fetch_task(**kwargs):
    """Wrapper to call fetch function with dynamic parameters."""
    config = get_mode_config()

    ticker_csv = '/opt/airflow/helper_datasets/companies.csv'
    output_folder = '/opt/airflow/stress_testing_data'
    results_folder = '/opt/airflow/stress_testing_results'
    os.makedirs(results_folder, exist_ok=True)

    # Track Start Time
    start_time = time.time()

    # Memory Before
    process = psutil.Process(os.getpid())
    mem_before = process.memory_info().rss / (1024 * 1024)  # in MB

    fetch_stock_data_threaded_combined(
        ticker_csv=ticker_csv,
        output_folder=output_folder+f"/{Variable.get('stress_test_mode', 'super_light')}",
        start_year=2000,
        end_year=2024,
        batch_size=50,
        threads=config["threads"],
        retry_limit=3,
        retry_delay=5,
        batch_pause=15,
        ticker_limit=config["ticker_limit"]
    )

    # Track End Time
    end_time = time.time()

    # Memory After
    mem_after = process.memory_info().rss / (1024 * 1024)  # in MB

    # Log Result
    log_entry = {
        "mode": Variable.get("stress_test_mode", "super_light"),
        "ticker_limit": config["ticker_limit"],
        "threads": config["threads"],
        "start_time": datetime.fromtimestamp(start_time).isoformat(),
        "end_time": datetime.fromtimestamp(end_time).isoformat(),
        "duration_seconds": round(end_time - start_time, 2),
        "memory_start_MB": round(mem_before, 2),
        "memory_end_MB": round(mem_after, 2),
        "memory_diff_MB": round(mem_after - mem_before, 2)
    }

    log_path = os.path.join(results_folder, "stress_test_log.csv")

    # Append to CSV
    if not os.path.exists(log_path):
        df_log = pd.DataFrame([log_entry])
        df_log.to_csv(log_path, index=False)
    else:
        df_existing = pd.read_csv(log_path)
        df_existing = pd.concat([df_existing, pd.DataFrame([log_entry])], ignore_index=True)
        df_existing.to_csv(log_path, index=False)

    print(f"Logged stress test result into {log_path}")


def print_selected_mode():
    config = get_mode_config()
    print(f"Selected Stress Test Mode: {config}")


# === DAG DEFINITION ===
default_args = {
    'owner': 'airflow',
    'depends_on_past': False,
    'email_on_failure': False,
    'retries': 1,
    'retry_delay': timedelta(minutes=5),
}

with DAG(
    'yahoo_stock_stress_test',
    default_args=default_args,
    description='Stress Test DAG for Yahoo Stock Data Fetching',
    schedule_interval=None,
    start_date=datetime(2024, 4, 24),
    catchup=False,
    tags=['stress_test', 'yfinance', 'scalability'],
) as dag:

    mode_info_task = PythonOperator(
        task_id='print_stress_mode',
        python_callable=print_selected_mode
    )

    fetch_data_task = PythonOperator(
        task_id='fetch_data_dynamic',
        python_callable=dynamic_fetch_task
    )

    mode_info_task >> fetch_data_task