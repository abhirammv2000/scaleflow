import os
import json
import time
import requests
import pandas as pd
from datetime import datetime
from itertools import product
import random
import string
from concurrent.futures import ThreadPoolExecutor, as_completed

# === CONFIGURATION ===
OUTPUT_FOLDER = "/opt/airflow/macroecon_data_threaded"
INDICATORS = [
    "NY.GDP.MKTP.CD", "NY.GDP.MKTP.KD.ZG", "FP.CPI.TOTL.ZG", "PA.NUS.FCRF", "SL.UEM.TOTL.ZS",
    "NE.EXP.GNFS.ZS", "NE.IMP.GNFS.ZS", "LP.LPI.OVRL.XQ", "IC.COST.INFR.CD", "IC.TIME.INFR",
    "EG.USE.ELEC.KH.PC", "IT.NET.USER.ZS", "IT.CEL.SETS.P2",
    "NV.AGR.TOTL.ZS", "SP.URB.TOTL.IN.ZS",
    "LP.LPI.INFR.XQ", "LP.LPI.CLEC.XQ", "LP.LPI.TRAC.XQ", "LP.LPI.TIME.XQ", "IS.AIR.GOOD.MT.K1", "IS.SHP.GOOD.TU",
    "IQ.REG.QUAL.XQ", "IQ.GOV.EFF.XQ", "IQ.CORR.XQ", "PV.EST",
    "SL.TLF.CACT.ZS", "SL.IND.EMPL.ZS", "IC.REG.DURS"
]

COUNTRIES = "all"
START_YEAR = 1974
END_YEAR = 2024
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# === FUNCTION TO GET TOTAL RECORD COUNT ===
def get_total_records(indicator):
    url = (
        f"http://api.worldbank.org/v2/country/{COUNTRIES}/indicator/{indicator}"
        f"?date={START_YEAR}:{END_YEAR}&format=json&per_page=1"
    )
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()[0].get("total", 0)
    except Exception as e:
        print(f"Metadata error for {indicator}: {e}")
        return 0

# === FUNCTION TO FETCH DATA & SAVE TO FILE ===
def fetch_and_save(indicator):
    total = get_total_records(indicator)
    if not total:
        return f"{indicator}: No records"

    url = (
        f"http://api.worldbank.org/v2/country/{COUNTRIES}/indicator/{indicator}"
        f"?date={START_YEAR}:{END_YEAR}&format=json&per_page={total}"
    )
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()[1]

        # Save JSON (optional)
        with open(f"{OUTPUT_FOLDER}/{indicator}.json", "w") as jf:
            json.dump(data, jf, indent=2)

        # Save CSV
        df = pd.json_normalize(data)
        df.to_csv(f"{OUTPUT_FOLDER}/{indicator}.csv", index=False)
        return f"{indicator}: success"
    except Exception as e:
        return f"{indicator}: failed with error {e}"

# === PARALLEL EXECUTION ===
MAX_WORKERS = 28
def main():
    start_time = time.time()
    print(f"\n Starting threaded download for {len(INDICATORS)} indicators...\n")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(fetch_and_save, ind) for ind in INDICATORS]
        for future in as_completed(futures):
            print(future.result())

    end_time = time.time()
    print(f"\n Time taken for extracting data threading with {MAX_WORKERS} workers: {end_time - start_time:.2f} seconds")

if __name__ == "__main__":
    main()
