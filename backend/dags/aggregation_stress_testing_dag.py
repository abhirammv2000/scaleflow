from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.models import Variable
from datetime import datetime, timedelta
import time
import psutil
import pandas as pd
from airflow.providers.postgres.hooks.postgres import PostgresHook

# === Configuration ===
DATABASE_URL = "postgresql://your_user:your_password@postgres:5432/airflow"

# Define aggregation stress modes
AGGREGATION_STRESS_MODES = {
    "super_light": {"sample_size": 10_000, "group_by": ["ticker"]},
    "light": {"sample_size": 100_000, "group_by": ["ticker"]},
    "moderate": {"sample_size": 1_000_000, "group_by": ["ticker", "EXTRACT(YEAR FROM (date || '-01')::date)"]},
    "heavy": {"sample_size": 5_000_000, "group_by": ["ticker", "EXTRACT(YEAR FROM (date || '-01')::date)", "EXTRACT(MONTH FROM (date || '-01')::date)"]},
}

# Map stress mode to table name
TABLE_MAPPING = {
    "super_light": "stock_data_super_light",
    "light": "stock_data_light",
    "moderate": "stock_data_slightly_heavy",
    "heavy": "stock_data_heavy"
}

# Aggregation mode (can be passed via Airflow Variables or hardcoded for now)
aggregation_stress_mode = Variable.get("aggregation_stress_mode", default_var="moderate")

# === DAG definition ===
default_args = {
    "owner": "airflow",
    "retries": 2,
    "retry_delay": timedelta(minutes=2)
}

dag = DAG(
    dag_id="aggregation_stress_testing",
    default_args=default_args,
    description="DAG to perform aggregation stress testing based on stress modes",
    schedule_interval=None,
    start_date=datetime(2024, 1, 1),
    catchup=False
)

# === Helper Functions ===
def log_result(results_file, data):
    df = pd.DataFrame([data])
    df.to_csv(results_file, mode='a', header=not pd.io.common.file_exists(results_file), index=False)

def start_aggregation_stress_testing():
    print("Aggregation stress testing has begun.")

def end_aggregation_stress_testing():
    print("Aggregation stress testing has ended.")

def run_aggregation_with_hook(query_name, query_sql, mode, config, table_name):
    results_log = f"/opt/airflow/stress_testing_results/aggregation_stress_log_{mode}.csv"

    hook = PostgresHook(postgres_conn_id="shre_postgres_conn_id")
    conn = hook.get_conn()
    cursor = conn.cursor()

    print(f"Running: {query_name}")
    start_time = time.perf_counter()
    mem_before = psutil.virtual_memory().used / (1024 * 1024)
    cpu_before = psutil.cpu_percent(interval=1)

    try:
        cursor.execute(query_sql)
        _ = cursor.fetchall()
    except Exception as e:
        print(f"Query failed: {e}")
        raise

    end_time = time.perf_counter()
    mem_after = psutil.virtual_memory().used / (1024 * 1024)
    cpu_after = psutil.cpu_percent(interval=1)

    elapsed_time = end_time - start_time

    result = {
        "timestamp": datetime.now(),
        "mode": mode,
        "aggregation": query_name,
        "sample_size": config["sample_size"],
        "query_time_sec": elapsed_time,
        "cpu_before": cpu_before,
        "cpu_after": cpu_after,
        "mem_before_MB": mem_before,
        "mem_after_MB": mem_after
    }
    log_result(results_log, result)

    cursor.close()
    conn.close()

def get_queries():
    mode = aggregation_stress_mode
    config = AGGREGATION_STRESS_MODES[mode]
    table_name = TABLE_MAPPING[mode]

    queries = {
        "total_volume": f"""SELECT {', '.join(config['group_by'])}, SUM(volume) as total_volume
                            FROM {table_name}
                            GROUP BY {', '.join(config['group_by'])}
                            LIMIT {config['sample_size']}""",

        "avg_close_price": f"""SELECT {', '.join(config['group_by'])}, AVG(close) as avg_close
                               FROM {table_name}
                               GROUP BY {', '.join(config['group_by'])}
                               LIMIT {config['sample_size']}""",

        "max_high_min_low": f"""SELECT {', '.join(config['group_by'])}, MAX(high) as max_high, MIN(low) as min_low
                                FROM {table_name}
                                GROUP BY {', '.join(config['group_by'])}
                                LIMIT {config['sample_size']}""",

        "monthly_volume": f"""SELECT ticker, EXTRACT(YEAR FROM (date || '-01')::date) as year, EXTRACT(MONTH FROM (date || '-01')::date) as month, SUM(volume) as total_monthly_volume
                              FROM {table_name}
                              GROUP BY ticker, year, month
                              LIMIT {config['sample_size']}""",

        "volatility": f"""SELECT {', '.join(config['group_by'])}, STDDEV(close) as volatility
                          FROM {table_name}
                          GROUP BY {', '.join(config['group_by'])}
                          LIMIT {config['sample_size']}"""
    }
    return queries

# === Create tasks dynamically ===
start_task = PythonOperator(
    task_id="start_aggregation_stress_testing",
    python_callable=start_aggregation_stress_testing,
    dag=dag
)

queries = get_queries()

aggregation_tasks = []
for task_name, sql_query in queries.items():
    task = PythonOperator(
        task_id=f"aggregation_{task_name}",
        python_callable=run_aggregation_with_hook,
        op_args=[task_name, sql_query, aggregation_stress_mode, AGGREGATION_STRESS_MODES[aggregation_stress_mode], TABLE_MAPPING[aggregation_stress_mode]],
        retries=3,
        retry_delay=timedelta(minutes=1),
        dag=dag
    )
    aggregation_tasks.append(task)

end_task = PythonOperator(
    task_id="end_aggregation_stress_testing",
    python_callable=end_aggregation_stress_testing,
    dag=dag
)

# Set task dependencies
start_task >> aggregation_tasks >> end_task