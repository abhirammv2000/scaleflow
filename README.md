# ScaleFlow: AI-Powered Supply Chain Risk Prediction

ScaleFlow forecasts supply chain risk from financial, trade and macroeconomic data. It is a containerized full-stack app: Airflow runs the batch pipelines, PostgreSQL and Pinecone hold the data, and a LangChain and GPT-4o chat interface sits on top for asking questions about it.

---

## Table of Contents

* [Project Overview](#project-overview)
* [Architecture Diagram](#architecture-diagram)
* [Features](#features)
* [Backend Overview](#backend-overview)
* [Frontend Overview](#frontend-overview)
* [Data Sources](#data-sources)
* [Evaluation Metrics](#evaluation-metrics)
* [Deployment](#deployment)
* [Setup Instructions](#setup-instructions)
* [Folder Structure](#folder-structure)
* [Results](#results)
* [Future Work](#future-work)
* [License](#license)

---

## Project Overview

Supply chain disruptions, whether from natural disasters or macroeconomic shocks, are a real risk to global commerce. ScaleFlow predicts them from historical data, economic indicators, weather data and market sentiment, and lets you ask about the results through a chat interface built on LangChain and OpenAI.

---

## Architecture Diagram

![Architecture](results/Scaleflow_Architecture_Diagram.png)

---

## Features

* Batch ETL pipelines for economic, logistics, and financial data
* Multi-threaded data extraction + API rate limit handling
* PostgreSQL-based storage + scalable Airflow DAGs
* Machine learning model training with XGBoost, Decision Trees
* ML evaluation using SHAP, Precision, Recall, AUC-ROC
* Real-time Q\&A assistant using LangChain and GPT-4o
* Frontend built with React, Tailwind, and Vercel AI SDK

---

## Backend Overview

### Technologies Used:

* **Apache Airflow** (ETL Orchestration)
* **Docker + Docker Compose** (Containerization)
* **PostgreSQL** (Relational Storage)
* **Python** (ETL + ML Pipelines)
* **MLflow** (Model Drift Monitoring)

### Key Components:

* `/dags`: Airflow DAGs for UN Comtrade, World Bank, Yahoo Finance
* `/scripts`: Threaded extraction, cleaning, and loading logic
* `stress_modes`: Dynamically scale pipeline load via Airflow Variables
* Aggregation DAGs benchmark DB under heavy SQL operations

---

## Frontend Overview

### Tech Stack:

* **React + Next.js 14+ (App Router)**
* **Tailwind CSS** for styling
* **Supabase** for block-level sheet data
* **Pinecone** for semantic search
* **OpenAI GPT-4o** for Q\&A and embeddings
* **LangChain** for orchestration
* **Vercel AI SDK** for streaming chat

### Data Flow Summary:

1. User submits a query via chat interface
2. `/api/qa` processes input using `MatrixQAService`
3. Plans retrieval steps using LLMs + schema awareness
4. Fetches evidence using Pinecone and Supabase
5. Streams synthesized response with citation metadata
6. Frontend parses metadata and renders annotated output

### API Endpoint:

```http
POST /api/qa
Content-Type: application/json
```

---

## Data Sources

* **UN Comtrade API** - Global trade statistics
* **World Bank API** - GDP, inflation, macro indicators
* **Yahoo Finance** - 6000+ tickers, 20 years of stock data
* **OpenWeather API** - Weather and disaster logs (optional)

---

## Machine Learning Models

* **Algorithms:** Logistic Regression, Decision Trees, XGBoost
* **Features:** Supplier performance, economic indicators, weather
* **Training:** Batched mode with hyperparameter tuning
* **Explainability:** SHAP analysis

---

## Evaluation Metrics

### Risk Prediction Models:

* Precision, Recall, AUC-ROC
* FPR/FNR, Confusion Matrix

### Chatbot:

* Latency & Response Speed
* Query Relevance Score
* Citation Accuracy

---

## Deployment

* **Backend API:** FastAPI/Flask (Optional)
* **Cloud:** GCP Cloud Run or AWS Lambda (Optional)
* **Frontend:** Vercel-hosted React frontend (Next.js)
* **Dockerized Setup:** Local Airflow + PostgreSQL stack

---

## Setup Instructions

```bash
# Clone the repo
$ git clone https://github.com/abhirammv2000/scaleflow.git
$ cd scaleflow

# Copy and configure environment variables for the Airflow stack
$ cp .env.example .env

# Get a UN Comtrade API key (https://comtradedeveloper.un.org/signin)
# and drop it into backend/config/uncomtrade-api-key.json
$ cp backend/config/uncomtrade-api-key.example.json backend/config/uncomtrade-api-key.json

# Add the raw datasets the DAGs expect - see backend/datasets/readme.md and
# backend/helper_datasets/readme.md for the layout (or point DATASETS_DIR in
# .env at wherever you already keep them)

# Start Docker containers (builds the custom Airflow image the first time)
$ docker-compose up --build -d

# Access Airflow UI (login: airflow / airflow, unless you changed it in .env)
Visit: http://localhost:8080
```

For the frontend:

```bash
$ cd frontend
$ cp .env.example .env.local   # fill in Clerk/Supabase/Pinecone/OpenAI keys
$ npm install
$ npm run dev
```

---

## Folder Structure

```
scaleflow/
├── backend/
│   ├── dags/                  # Airflow DAGs
│   ├── scripts/               # Standalone Python ETL scripts
│   ├── config/                # Dockerfile + uncomtrade-api-key.json (gitignored;
│   │                          #   copy uncomtrade-api-key.example.json)
│   ├── datasets/               # Raw input datasets (gitignored, see its readme.md)
│   ├── helper_datasets/        # Small helper inputs, e.g. companies.csv (gitignored)
│   ├── output_data/            # Committed stress-test/aggregation result CSVs
│   └── requirements.txt        # Python dependencies
├── frontend/                   # Next.js 15 app (App Router)
│   ├── app/                    # Routes, incl. app/api/qa/route.ts (Matrix QA endpoint)
│   ├── components/             # Chat + sheet-grid UI components
│   └── lib/                    # Agents, services, Supabase/Pinecone clients
├── supabase/                   # Supabase project config (supabase/config.toml)
├── results/                    # Architecture diagram + stress-test/eval screenshots
├── docker-compose.yaml         # Local Airflow + Postgres + Redis stack
├── .env.example                # Sample ENV variables for docker-compose
├── LICENSE
└── README.md
```

---

## Results

ScaleFlow was tested across the frontend AI integration and backend data pipelines to confirm its scalability and resilience. The findings demonstrate the system's capacity to manage large data intake, carry out intricate aggregations under pressure, and provide precise, instantaneous responses via an AI-powered chatbot. From user input to database retrieval and dynamic streaming response, integration tests further validated the end-to-end architecture's stability and consistency.

### Backend Stress Testing

**1. Batch Pipeline Performance (Yahoo Finance Ingestion)**

* Four ingestion modes were tested: `super_light`, `light`, `slightly_heavy`, and `heavy`.
* Key metrics included total execution time and memory usage per mode:

![Stress Test - Execution Time vs Memory](results/exec_time_vs_mem.png)

* Findings:

  * Execution time scaled non-linearly under increasing loads.
  * Peak memory usage occurred at the `slightly_heavy` level before optimizing for the `heavy` load.

**2. Aggregation Query Benchmarking (PostgreSQL)**

* Five types of queries tested: `avg_close_price`, `max_high_min_low`, `monthly_volume`, `total_volume`, and `volatility`.
* Executed under four stress modes from `super_light` to `heavy`.

![Aggregation Query Time](results/agg_query_exec_time_vs_sm.png)

* Findings:

  * `heavy` mode queries exhibited \~20x execution time compared to lighter modes.
  * Despite load increase, DAGs remained stable with retry logic and chunked processing.

---

### Chatbot Evaluation

**Benchmark Metrics** (based on 10-query evaluation):

![Chatbot Evaluation Metrics](results/chatbot_eval.png)

* **Accuracy**: 90% of queries yielded factually correct responses.
* **Citation Quality**: 100% of responses included verifiable, inline citations.
* **Context Handling**: 80% effectiveness across multi-turn conversations.

---

### API Performance & Streaming Analysis

![API Latency](results/api_strm_perf.png)

* **Average First Token Latency**: \~400ms
* **Peak Latency (under load)**: \~1100ms
* **Total Response Time** under load reached 4200ms, but token streaming ensured a responsive UI.

---

### Integration Verification

* **API Response Success Rate**: 95% (19/20 queries handled successfully)
* **Vector Retrieval**: Pinecone + Supabase returned relevant results on every run
* **Citation Injection**: All streaming responses included accurate citations
* **Full-stack Pipeline Stability**: End-to-end flow (UI -> API -> LLM -> DBs -> UI) worked without breaking across test rounds

---

## Future Work

* Integrate SHAP-based interpretability dashboards
* Real-time streaming using Kafka or Flink
* Chatbot memory and history personalization
* Deploy across multiple industry domains
* Serverless global deployment (Cloud Run, Lambda)

---

## License

MIT - see [LICENSE](LICENSE).

---

## **Acknowledgments**
This repository showcases the project built for the **CSCI-6502: Big Data Analytics** course at the **University of Colorado Boulder**.
