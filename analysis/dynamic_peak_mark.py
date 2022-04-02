import time
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from pymongo import MongoClient, DESCENDING, ASCENDING

def start_mark(last_peak, new_tick, records, price_diff, peak_price):
    if last_peak['secondMark'] == "pass" or last_peak['secondMark'] == "":
        trigger_a_peak(new_tick, last_peak)
    elif last_peak['firstMark'] == "verifing":
        # Do verify
        first_verify_peak(new_tick, last_peak)
        # Update position here
    elif last_peak['firstMark'] == "pass":
        # If pass, check whether mark wrong
        second_verify_peak(new_tick, last_peak)
        # Update cut logic here

def trigger_a_peak():
    return

# 1. If cjl reduce fast, price reduce fast, then pass
# 2. If cjl increase and price still running, then still peaking, add more?
# 3. If no changes, more like a false peak.
def first_verify_peak(new_tick, last_peak):
    return

def second_verify_peak(new_tick, last_peak):
    return
