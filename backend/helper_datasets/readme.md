# backend/helper_datasets/

Small helper input files the DAGs read directly (as opposed to the large
external datasets under `backend/datasets/`). CSVs here are gitignored;
this readme is the only tracked file.

Currently required:

- **companies.csv** - the ticker list `yahoo_fetch_dag.py`,
  `stress_testing_dag.py` and `complete_stress_dag.py` read from
  `/opt/airflow/helper_datasets/companies.csv`. Needs at least a `ticker`
  column; any other columns are ignored. A few hundred well-known tickers
  (e.g. the S&P 500 constituents) is enough to exercise the pipeline.
