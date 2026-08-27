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

def measure_and_log(stage_name, function_to_run, results_folder="/opt/airflow/stress_testing_results", **kwargs):
    os.makedirs(results_folder, exist_ok=True)

    mode = Variable.get("stress_test_mode", "super_light")
    start_time = time.time()
    process = psutil.Process(os.getpid())
    mem_before = process.memory_info().rss / (1024 * 1024)  # in MB

    # Run the actual function
    function_to_run(**kwargs)

    end_time = time.time()
    mem_after = process.memory_info().rss / (1024 * 1024)  # in MB

    log_entry = {
        "stage": stage_name,
        "start_time": datetime.fromtimestamp(start_time).isoformat(),
        "end_time": datetime.fromtimestamp(end_time).isoformat(),
        "duration_seconds": round(end_time - start_time, 2),
        "memory_start_MB": round(mem_before, 2),
        "memory_end_MB": round(mem_after, 2),
        "memory_diff_MB": round(mem_after - mem_before, 2)
    }

    log_path = os.path.join(results_folder, f"stress_test_{stage_name}_{mode}_log.csv")

    # Append to CSV
    if not os.path.exists(log_path):
        df_log = pd.DataFrame([log_entry])
        df_log.to_csv(log_path, index=False)
    else:
        df_existing = pd.read_csv(log_path)
        df_existing = pd.concat([df_existing, pd.DataFrame([log_entry])], ignore_index=True)
        df_existing.to_csv(log_path, index=False)

    print(f"[LOGGED] {stage_name}: {round(end_time - start_time, 2)}s, Memory diff: {round(mem_after - mem_before, 2)}MB")

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

def merge_extracted_csvs(source_folder, output_file="merged_data.csv", chunk_size=100000):
    files = [os.path.join(source_folder, f) for f in os.listdir(source_folder)
             if f.endswith(".csv") and not f.startswith("summary")]

    if not files:
        raise Exception("No CSV files found to merge!")

    merged_file_path = os.path.join(source_folder, output_file)
    first = True
    standard_columns = None

    for file in files:
        try:
            # Only read the header first
            header = pd.read_csv(file, nrows=1)

            if standard_columns is None:
                standard_columns = header.columns
            else:
                if not header.columns.equals(standard_columns):
                    print(f"Skipping {file} due to column mismatch.")
                    continue

            # Now read chunks
            for chunk in pd.read_csv(file, chunksize=chunk_size):
                if first:
                    chunk.to_csv(merged_file_path, index=False, mode='w')
                    first = False
                else:
                    chunk.to_csv(merged_file_path, index=False, mode='a', header=False)

        except Exception as e:
            print(f"[WARN] Failed to process {file}: {e}")

    print(f"Merged valid CSV files into {output_file}")

def clean_merged_csv(input_path, output_path, chunk_size=100000):
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input merged CSV not found: {input_path}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    first_chunk = True

    for chunk in pd.read_csv(input_path, chunksize=chunk_size):
        # Drop unwanted columns if they exist
        drop_cols = [col for col in ['Capital Gains', 'Stock Splits', 'Dividends'] if col in chunk.columns]
        chunk = chunk.drop(columns=drop_cols, errors='ignore')

        # Drop NA values
        chunk = chunk.dropna()

        # Convert Date to 'YYYY-MM' format if 'Date' column exists
        if 'Date' in chunk.columns:
            chunk['Date'] = pd.to_datetime(chunk['Date'], utc=True, errors='coerce')
            chunk['Date'] = chunk['Date'].dt.to_period('M')

        # Save cleaned chunk
        if first_chunk:
            chunk.to_csv(output_path, index=False, mode='w')
            first_chunk = False
        else:
            chunk.to_csv(output_path, index=False, mode='a', header=False)

    print(f"Cleaned data saved to: {output_path}")

def load_to_postgres(clean_csv_path, table_name, db_uri):
    retries = 5
    delay_seconds = 10

    for attempt in range(retries):
        try:
            print(f"Attempt {attempt+1}: Connecting to PostgreSQL...")
            engine = create_engine(db_uri, pool_pre_ping=True)  # avoids dead connections
            with engine.begin() as connection:
                df = pd.read_csv(clean_csv_path)
                df.to_sql(
                    table_name,
                    connection,
                    if_exists='replace',
                    index=False,
                    chunksize=10000 # loading data in batches to the database
                )
                print(f"Loaded cleaned data into PostgreSQL table: {table_name}")
                return
        except Exception as e:
            print(f"Attempt {attempt+1} failed: {e}")
            time.sleep(delay_seconds * (attempt + 1))  # Exponential backoff: 10s, 20s, 30s...

    raise Exception("All attempts to connect to PostgreSQL failed after retries.")

# === CONFIGURATION ===
def get_mode_config():
    """Fetch mode from Airflow Variables and return config."""
    mode = Variable.get("stress_test_mode", default_var="super_light").lower()

    config = {
        "super_light": {"ticker_limit": 250, "threads": 5},
        "light": {"ticker_limit": 500, "threads": 10},
        "slightly_heavy": {"ticker_limit": 2000, "threads": 30},
        "heavy": {"ticker_limit": 6000, "threads": 60}
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

    mode = Variable.get("stress_test_mode", "super_light")
    data_folder = f"{output_folder}/{mode}"
    ticker_files = glob.glob(os.path.join(data_folder, "*.csv"))
    num_tickers_saved = len([f for f in ticker_files if "fetch_log" not in f])

    # Log Result
    log_entry = {
        "mode": Variable.get("stress_test_mode", "super_light"),
        "ticker_limit": config["ticker_limit"],
        "threads": config["threads"],
        "tickers_saved": num_tickers_saved,
        "start_time": datetime.fromtimestamp(start_time).isoformat(),
        "end_time": datetime.fromtimestamp(end_time).isoformat(),
        "duration_seconds": round(end_time - start_time, 2),
        "memory_start_MB": round(mem_before, 2),
        "memory_end_MB": round(mem_after, 2),
        "memory_diff_MB": round(mem_after - mem_before, 2)
    }

    log_path = os.path.join(results_folder, f"stress_test_fetch_{mode}_log.csv")

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

def merge_task(**kwargs):
    mode = Variable.get("stress_test_mode", "super_light")
    output_folder = f"/opt/airflow/stress_testing_data/{mode}"
    combined_path = output_folder+f"/combined_{mode}.csv"

    measure_and_log(
        stage_name="merge",
        function_to_run=merge_extracted_csvs,
        source_folder=output_folder,
        output_file=combined_path
    )

def clean_task(**kwargs):
    mode = Variable.get("stress_test_mode", "super_light")
    combined_path = f"/opt/airflow/stress_testing_data/{mode}/combined_{mode}.csv"
    cleaned_path = f"/opt/airflow/stress_testing_data/{mode}/cleaned_{mode}.csv"

    measure_and_log(
        stage_name="clean",
        function_to_run=clean_merged_csv,
        input_path=combined_path,
        output_path=cleaned_path
    )

def load_task(**kwargs):
    mode = Variable.get("stress_test_mode", "super_light")
    cleaned_path = f"/opt/airflow/stress_testing_data/{mode}/cleaned_{mode}.csv"
    db_uri = Variable.get("postgres_db_uri")
    table_name = f"stock_data_{mode}"
    results_folder = '/opt/airflow/stress_testing_results'

    if not db_uri:
        raise ValueError("Postgres DB URI not set in Airflow Variables!")

    start_time = time.time()
    process = psutil.Process(os.getpid())
    mem_before = process.memory_info().rss / (1024 * 1024)

    # Load into Postgres
    load_to_postgres(cleaned_path, table_name, db_uri)

    # After loading, count rows
    engine = create_engine(db_uri)
    with engine.begin() as connection:
        row_count = connection.execute(f"SELECT COUNT(*) FROM {table_name}").scalar()

    end_time = time.time()
    mem_after = process.memory_info().rss / (1024 * 1024)

    log_entry = {
        "stage": "load_to_postgres",
        "mode": mode,
        "table_name": table_name,
        "rows_inserted": row_count,
        "start_time": datetime.fromtimestamp(start_time).isoformat(),
        "end_time": datetime.fromtimestamp(end_time).isoformat(),
        "duration_seconds": round(end_time - start_time, 2),
        "memory_start_MB": round(mem_before, 2),
        "memory_end_MB": round(mem_after, 2),
        "memory_diff_MB": round(mem_after - mem_before, 2)
    }

    log_path = os.path.join(results_folder, f"stress_test_load_{mode}_log.csv")

    if not os.path.exists(log_path):
        pd.DataFrame([log_entry]).to_csv(log_path, index=False)
    else:
        df_existing = pd.read_csv(log_path)
        df_existing = pd.concat([df_existing, pd.DataFrame([log_entry])], ignore_index=True)
        df_existing.to_csv(log_path, index=False)

    print(f"Logged load stage result into {log_path}")

# === Updated DAG ===
default_args = {
    'owner': 'airflow',
    'depends_on_past': False,
    'email_on_failure': False,
    'retries': 1,
    'retry_delay': timedelta(seconds=30),
}

with DAG(
    'complete_etl_stress_test',
    default_args=default_args,
    description='Full ETL Stress Test for Yahoo Stock Data',
    schedule_interval=None,
    start_date=datetime(2024, 4, 24),
    catchup=False,
    tags=['stress_test', 'yfinance', 'etl', 'postgresql'],
) as dag:

    mode_info_task = PythonOperator(
        task_id='print_stress_mode',
        python_callable=print_selected_mode
    )

    fetch_data_task = PythonOperator(
        task_id='fetch_data_dynamic',
        python_callable=dynamic_fetch_task
    )

    merge_data_task = PythonOperator(
        task_id='merge_data',
        python_callable=merge_task
    )

    clean_data_task = PythonOperator(
        task_id='clean_data',
        python_callable=clean_task
    )

    load_data_task = PythonOperator(
        task_id='load_to_postgres',
        python_callable=load_task
    )

    # Define Dependencies
    mode_info_task >> fetch_data_task >> merge_data_task >> clean_data_task >> load_data_task