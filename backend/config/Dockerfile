ARG AIRFLOW_VERSION=2.10.5
ARG PYTHON_VERSION=3.10

FROM apache/airflow:${AIRFLOW_VERSION}-python${PYTHON_VERSION}

ARG AIRFLOW_VERSION
ARG PYTHON_VERSION

COPY requirements.txt /requirements.txt

# Install the ETL/ML extras (pandas, xgboost, shap, ...) on top of the base
# Airflow image, constrained against Airflow's own published constraints file
# so pip can't silently pull in a SQLAlchemy/Flask/etc. version that conflicts
# with what this Airflow version actually needs. Keep AIRFLOW_VERSION here in
# sync with docker-compose.yaml's AIRFLOW_IMAGE_NAME - a mismatch is exactly
# the kind of bug (mixed Airflow versions across the Celery cluster) this
# pinning is meant to prevent.
RUN pip install --no-cache-dir -r /requirements.txt \
    --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt"
