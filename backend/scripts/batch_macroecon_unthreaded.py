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
OUTPUT_FOLDER = "/opt/airflow/macroecon_data_unthreaded"
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
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed metadata call for {indicator}")
        return None
    metadata = response.json()[0]
    return metadata.get("total", None)

# === FUNCTION TO FETCH ALL DATA IN ONE CALL ===
def fetch_all_data(indicator, total):
    url = (
        f"http://api.worldbank.org/v2/country/{COUNTRIES}/indicator/{indicator}"
        f"?date={START_YEAR}:{END_YEAR}&format=json&per_page={total}"
    )
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed data fetch for {indicator}")
        return None
    return response.json()[1]

# === MAIN SCRIPT ===
start_time = time.time() #logging the time taken for data ingestion
for ind in INDICATORS:
    print(f"\nFetching indicator: {ind}")
    total = get_total_records(ind)
    if not total:
        continue

    print(f"-> Total records: {total}")
    data = fetch_all_data(ind, total)
    if data:
        # Save raw JSON for reference (optional)
        with open(f"{OUTPUT_FOLDER}/{ind}.json", "w") as f:
            json.dump(data, f, indent=2)

        # Normalize and save as CSV
        df = pd.json_normalize(data)
        df.to_csv(f"{OUTPUT_FOLDER}/{ind}.csv", index=False)
        print(f"Saved {ind}.csv")
    else:
        print(f"No data found for {ind}")

end_time = time.time()

print(f"Time taken for extracting data without unthreading: {end_time - start_time:.2f} seconds")