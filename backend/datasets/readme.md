# backend/datasets/

Raw input datasets consumed by the Airflow DAGs, mounted into the containers
by `docker-compose.yaml` (via `${DATASETS_DIR:-./backend/datasets}`). These
are large, external, and **not committed to the repo** - this folder (and
everything in it except this file) is gitignored.

Point `DATASETS_DIR` in your root `.env` at wherever you keep these if you'd
rather not put them inside the repo checkout.

Expected layout:

```
datasets/
├── yahoo_finance_dataset/
│   ├── ticker_data_individual/   # one CSV per ticker, fetched by yahoo_fetch_dag.py
│   └── ticker_data_combined/     # merged/cleaned combined CSVs
├── stress_testing_data/
│   ├── super_light/
│   ├── light/
│   ├── slightly_heavy/
│   └── heavy/                    # per-mode output of the stress-testing DAGs
├── stress_testing_results/       # execution-time/memory + aggregation-query logs
├── uncomtrade-data/
│   ├── threaded/
│   └── unthreaded/                # UN Comtrade ingestion output (see uncomtrade_dag.py)
└── macroecon-data/
    ├── threaded/
    └── unthreaded/                # World Bank / macroeconomic ingestion output
```

Each of these subfolders is bind-mounted individually, so create the ones you
actually need before running `docker-compose up` (Docker will otherwise
create them as empty directories automatically on Linux, but that's easy to
mistake for "the DAG produced no data").
